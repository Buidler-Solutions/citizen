import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  randomUUID,
} from "node:crypto";

/**
 * Ed25519 identity material for TreasureNet Citizen Edition.
 *
 * DIDs follow the Citizen wallet convention: `did:key:ed25519:<public_hex>`.
 * Keypairs are generated on device (mobile secure enclave / browser keystore /
 * backend KMS) and never leave the holder.
 */

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface KeyPair {
  did: string;
  publicKeyHex: string;
  privateKeyHex: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = Buffer.from(publicKey.export({ type: "spki", format: "der" }))
    .subarray(-32)
    .toString("hex");
  const privateKeyHex = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" }))
    .subarray(-32)
    .toString("hex");
  return { did: didFromPublicKey(publicKeyHex), publicKeyHex, privateKeyHex };
}

export function didFromPublicKey(publicKeyHex: string): string {
  return `did:key:ed25519:${publicKeyHex}`;
}

/** Derive the public key hex (and DID form) from a raw 32-byte private key. */
export function publicKeyFromPrivateKeyHex(privateKeyHex: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKeyHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  return Buffer.from(publicKey.export({ type: "spki", format: "der" }))
    .subarray(-32)
    .toString("hex");
}

export function didFromPrivateKeyHex(privateKeyHex: string): string {
  return didFromPublicKey(publicKeyFromPrivateKeyHex(privateKeyHex));
}

export function publicKeyFromDid(did: string): string {
  const prefix = "did:key:ed25519:";
  if (!did.startsWith(prefix)) {
    throw new Error(`unsupported did format: ${did}`);
  }
  return did.slice(prefix.length);
}

function keyObjects(privateKeyHex: string) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKeyHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function signMessage(message: string, privateKeyHex: string): string {
  const { privateKey } = keyObjects(privateKeyHex);
  return cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");
}

export function verifyMessage(
  message: string,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(
      null,
      Buffer.from(message, "utf8"),
      publicKey,
      Buffer.from(signatureHex, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Canonical JSON: object keys sorted recursively, compact separators.
 * Mirrors `canonical_json` in the Citizen ledger so signatures verify on-chain.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export interface LedgerEntryInput {
  namespace: string;
  action: string;
  object_id: string;
  payload: Record<string, unknown>;
  author: string;
}

export interface SignedLedgerEntry {
  entry_id: string;
  namespace: string;
  action: string;
  object_id: string;
  payload: Record<string, unknown>;
  author: string;
  signature: string;
  timestamp: number;
  privacy_flag: boolean;
  privacy_mode: string;
}

export function buildSignedEntry(
  input: LedgerEntryInput,
  privateKeyHex: string,
  timestamp: number = Math.floor(Date.now() / 1000)
): SignedLedgerEntry {
  const entry_id = randomUUID();
  const signingPayload = {
    entry_id,
    namespace: input.namespace,
    action: input.action,
    object_id: input.object_id,
    payload: input.payload,
    author: input.author,
    timestamp,
  };
  const signature = signMessage(canonicalJson(signingPayload), privateKeyHex);
  return {
    ...signingPayload,
    signature,
    privacy_flag: false,
    privacy_mode: "none",
  };
}

/**
 * Replay protection scope: deterministic idempotency keys derived from the
 * operation scope, so a replayed submission is detected and rejected upstream.
 */
export function signatureScope(namespace: string, action: string, objectId: string): string {
  return `${namespace}:${action}:${objectId}`;
}
