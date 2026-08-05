/**
 * KYC encryption utilities using Web Crypto API.
 * Zero external dependencies — uses P-256 ECDH + AES-256-GCM.
 *
 * Dual-recipient flow:
 * 1. Admin publishes KYC encryption public key on-chain.
 * 2. Wallet holder auto-generates their own P-256 keypair on first use.
 * 3. KYC data is encrypted twice: once for admin, once for holder.
 * 4. Admin decrypts with their private key + admin epk.
 * 5. Holder decrypts with their private key + holder epk.
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function toBase64(bytes: ArrayBuffer): string {
  const raw = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < raw.length; i++) binary += String.fromCharCode(raw[i]);
  return btoa(binary);
}

function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer.slice(0);
}

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

const HOLDER_KEY_STORAGE = "citizen.kyc.holderKey";

function isExtensionContext(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

async function storageGet(key: string): Promise<string | null> {
  if (isExtensionContext()) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? null;
  }
  return localStorage.getItem(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (isExtensionContext()) {
    await chrome.storage.local.set({ [key]: value });
  } else {
    localStorage.setItem(key, value);
  }
}

export interface KycKeyPair {
  publicKeyBase64: string;
  privateKeyJwk: JsonWebKey;
}

export async function generateKycKeyPair(): Promise<KycKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return { publicKeyBase64: toBase64(rawPublic), privateKeyJwk: privateJwk };
}

export async function importKycPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", fromBase64(b64),
    { name: "ECDH", namedCurve: "P-256" },
    false, [],
  );
}

export async function importKycPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false, ["deriveKey"],
  );
}

export async function getOrCreateHolderKeyPair(): Promise<KycKeyPair> {
  const stored = await storageGet(HOLDER_KEY_STORAGE);
  if (stored) {
    try { return JSON.parse(stored) as KycKeyPair; } catch { /* fall through */ }
  }
  const keyPair = await generateKycKeyPair();
  await storageSet(HOLDER_KEY_STORAGE, JSON.stringify(keyPair));
  return keyPair;
}

async function encryptWithKey(
  data: Record<string, unknown>,
  recipientPub: CryptoKey,
): Promise<{ ciphertextHex: string; epkBase64: string; nonceHex: string }> {
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"],
  );
  const shared = await crypto.subtle.deriveKey(
    { name: "ECDH", public: recipientPub }, ephemeral.privateKey,
    { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, shared,
    TEXT_ENCODER.encode(JSON.stringify(data)),
  );
  const epk = await crypto.subtle.exportKey("raw", ephemeral.publicKey);
  return {
    ciphertextHex: bytesToHex(ct),
    epkBase64: toBase64(epk),
    nonceHex: bytesToHex(nonce.buffer.slice(0)),
  };
}

export interface EncryptedKycDual {
  ciphertextHex: string;
  nonceHex: string;
  epk: string;
  payloadCommitment: string;
  holderCiphertextHex: string;
  holderNonceHex: string;
  holderEpk: string;
}

export async function encryptKycDataDual(
  data: { full_name: string; address: string },
  adminPublicKeyBase64: string,
): Promise<EncryptedKycDual> {
  const adminPub = await importKycPublicKey(adminPublicKeyBase64);
  const holderPair = await getOrCreateHolderKeyPair();
  const holderPub = await importKycPublicKey(holderPair.publicKeyBase64);
  const commitment = await crypto.subtle.digest(
    "SHA-256", TEXT_ENCODER.encode(JSON.stringify(data)),
  );
  const [admin, holder] = await Promise.all([
    encryptWithKey(data, adminPub),
    encryptWithKey(data, holderPub),
  ]);
  return {
    ciphertextHex: admin.ciphertextHex, nonceHex: admin.nonceHex, epk: admin.epkBase64,
    holderCiphertextHex: holder.ciphertextHex, holderNonceHex: holder.nonceHex,
    holderEpk: holder.epkBase64,
    payloadCommitment: `sha256:${bytesToHex(commitment)}`,
  };
}

export async function decryptKyc(
  ciphertextHex: string, nonceHex: string, epkBase64: string,
  privateKey: CryptoKey,
): Promise<{ full_name: string; address: string }> {
  const epk = await crypto.subtle.importKey(
    "raw", fromBase64(epkBase64),
    { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const shared = await crypto.subtle.deriveKey(
    { name: "ECDH", public: epk }, privateKey,
    { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(nonceHex) }, shared, hexToBytes(ciphertextHex),
  );
  return JSON.parse(TEXT_DECODER.decode(pt));
}

export async function decryptKycAsHolder(
  holderCiphertextHex: string, holderNonceHex: string, holderEpk: string,
): Promise<{ full_name: string; address: string } | null> {
  const stored = await storageGet(HOLDER_KEY_STORAGE);
  if (!stored) return null;
  try {
    const { privateKeyJwk } = JSON.parse(stored) as KycKeyPair;
    const key = await importKycPrivateKey(privateKeyJwk);
    return decryptKyc(holderCiphertextHex, holderNonceHex, holderEpk, key);
  } catch { return null; }
}
