/**
 * Ballot encryption utilities using Web Crypto API.
 * Zero external dependencies — uses P-256 ECDH + AES-256-GCM.
 *
 * Flow:
 * 1. Election admin generates a P-256 keypair; public key goes in the
 *    OPEN_ELECTION payload as `tally_public_key`.
 * 2. Voter imports the election public key, generates an ephemeral
 *    keypair, derives a shared AES-256 key via ECDH, and encrypts
 *    the ballot selections.
 * 3. Admin decrypts each ballot using the election private key +
 *    the ballot's ephemeral public key.
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function toBase64(bytes: ArrayBuffer): string {
  const raw = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < raw.length; i++) {
    binary += String.fromCharCode(raw[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer.slice(0);
}

export interface ElectionKeyPair {
  publicKeyBase64: string;
  privateKeyJwk: JsonWebKey;
}

export async function generateElectionKeyPair(): Promise<ElectionKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    publicKeyBase64: toBase64(rawPublic),
    privateKeyJwk: privateJwk,
  };
}

export async function importElectionPublicKey(
  publicKeyBase64: string,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromBase64(publicKeyBase64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

export async function importElectionPrivateKey(
  jwk: JsonWebKey,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  );
}

export interface EncryptedBallot {
  ciphertextBase64: string;
  ephemeralPublicKeyBase64: string;
  nonceBase64: string;
}

export async function encryptBallot(
  selections: unknown,
  electionPublicKeyBase64: string,
): Promise<EncryptedBallot> {
  const electionPublicKey = await importElectionPublicKey(electionPublicKeyBase64);

  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );

  const sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: electionPublicKey },
    ephemeralKeyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(selections));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    sharedKey,
    plaintext,
  );

  const ephemeralPublicKey = await crypto.subtle.exportKey(
    "raw",
    ephemeralKeyPair.publicKey,
  );

  return {
    ciphertextBase64: toBase64(ciphertext),
    ephemeralPublicKeyBase64: toBase64(ephemeralPublicKey),
    nonceBase64: toBase64(nonce.buffer.slice(0)),
  };
}

export async function decryptBallot(
  encrypted: EncryptedBallot,
  electionPrivateKey: CryptoKey,
): Promise<unknown> {
  const ephemeralPublicKey = await crypto.subtle.importKey(
    "raw",
    fromBase64(encrypted.ephemeralPublicKeyBase64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: ephemeralPublicKey },
    electionPrivateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(encrypted.nonceBase64) },
    sharedKey,
    fromBase64(encrypted.ciphertextBase64),
  );

  return JSON.parse(TEXT_DECODER.decode(plaintext));
}
