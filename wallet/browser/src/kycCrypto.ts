/**
 * KYC encryption utilities — X25519 hybrid (protocol-standard).
 *
 * Uses Web Crypto API for X25519 ECDH (service-worker safe, no external deps).
 * ChaCha20-Poly1305 via the existing hand-rolled implementation.
 *
 * Envelope matches the onboarding site and protocol wallet:
 *   - Random DEK encrypts payload via ChaCha20-Poly1305
 *   - DEK wrapped per-reader via X25519 ECDH + ChaCha20-Poly1305
 *   - Compatible with the wallet's built-in Decrypt tab
 */

import { chacha20Poly1305Encrypt, chacha20Poly1305Decrypt } from './chacha20poly1305';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const combined = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return new Uint8Array(digest);
}

const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00,
  0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
  0x04, 0x22, 0x04, 0x20,
]);

const X25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
  0x03, 0x21, 0x00,
]);

async function x25519SharedSecret(
  privateKeyBytes: Uint8Array,
  publicKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + privateKeyBytes.length);
  pkcs8.set(X25519_PKCS8_PREFIX, 0);
  pkcs8.set(privateKeyBytes, X25519_PKCS8_PREFIX.length);

  const spki = new Uint8Array(X25519_SPKI_PREFIX.length + publicKeyBytes.length);
  spki.set(X25519_SPKI_PREFIX, 0);
  spki.set(publicKeyBytes, X25519_SPKI_PREFIX.length);

  const privKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits'],
  );
  const pubKey = await crypto.subtle.importKey(
    'spki', spki, { name: 'X25519' }, false, [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'X25519', public: pubKey }, privKey, 256,
  );
  return new Uint8Array(shared);
}

export interface KycWrappedSecret {
  reader_id: string;
  wrapped_dek: string;
}

export interface KycEncryptedEnvelope {
  ciphertextHex: string;
  nonceHex: string;
  authorPublicKeyHex: string;
  keyWrappedSecrets: KycWrappedSecret[];
  payloadCommitment: string;
}

async function wrapDekForReader(
  dek: Uint8Array,
  authorSecret: Uint8Array,
  readerPublicKeyHex: string,
  wrapContext: string,
): Promise<string> {
  const readerPub = fromHex(readerPublicKeyHex);
  const sharedSecret = await x25519SharedSecret(authorSecret, readerPub);
  const wrapKey = await sha256(sharedSecret);
  const nonce = (await sha256(sharedSecret, dek, TEXT_ENCODER.encode(wrapContext))).slice(0, 12);
  const wrapped = chacha20Poly1305Encrypt(wrapKey, nonce, dek);
  const output = new Uint8Array(12 + wrapped.length);
  output.set(nonce, 0);
  output.set(wrapped, 12);
  return toHex(output);
}

async function unwrapDekForReader(
  wrappedDekHex: string,
  readerSecret: Uint8Array,
  authorPublicKeyHex: string,
): Promise<Uint8Array | null> {
  const authorPub = fromHex(authorPublicKeyHex);
  const sharedSecret = await x25519SharedSecret(readerSecret, authorPub);
  const wrapKey = await sha256(sharedSecret);
  const wrapped = fromHex(wrappedDekHex);
  if (wrapped.length <= 12) return null;
  const nonce = wrapped.slice(0, 12);
  const ciphertext = wrapped.slice(12);
  const dek = chacha20Poly1305Decrypt(wrapKey, nonce, ciphertext);
  if (!dek || dek.length !== 32) return null;
  return dek;
}

export async function encryptKycDataHybrid(
  data: { full_name: string; address: string },
  adminPublicKeyHex: string,
  authorSecret: Uint8Array,
  authorPublicKeyHex: string,
  authorReaderDid: string,
  adminReaderDid: string,
  entryId: string,
): Promise<KycEncryptedEnvelope> {
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(data));

  const dek = crypto.getRandomValues(new Uint8Array(32));
  const payloadNonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = chacha20Poly1305Encrypt(dek, payloadNonce, plaintext);

  const adminWrapped = await wrapDekForReader(
    dek, authorSecret, adminPublicKeyHex, `kyc:${entryId}:${adminReaderDid}`,
  );
  const holderWrapped = await wrapDekForReader(
    dek, authorSecret, authorPublicKeyHex, `kyc:${entryId}:${authorReaderDid}`,
  );

  const commitment = await sha256(plaintext);

  return {
    ciphertextHex: toHex(ciphertext),
    nonceHex: toHex(payloadNonce),
    authorPublicKeyHex,
    keyWrappedSecrets: [
      { reader_id: adminReaderDid, wrapped_dek: adminWrapped },
      { reader_id: authorReaderDid, wrapped_dek: holderWrapped },
    ],
    payloadCommitment: `sha256:${toHex(commitment)}`,
  };
}

export async function decryptKycAsHolderHybrid(
  ciphertextHex: string,
  nonceHex: string,
  authorPublicKeyHex: string,
  keyWrappedSecrets: KycWrappedSecret[],
  holderReaderDid: string,
  holderSecret: Uint8Array,
): Promise<{ full_name: string; address: string } | null> {
  const matching = keyWrappedSecrets.find((s) => s.reader_id === holderReaderDid)
    ?? keyWrappedSecrets[0];
  if (!matching) return null;

  const dek = await unwrapDekForReader(matching.wrapped_dek, holderSecret, authorPublicKeyHex);
  if (!dek) return null;

  const nonce = fromHex(nonceHex);
  if (nonce.length !== 12) return null;
  const ciphertext = fromHex(ciphertextHex);
  const plaintext = chacha20Poly1305Decrypt(dek, nonce, ciphertext);
  if (!plaintext) return null;

  return JSON.parse(TEXT_DECODER.decode(plaintext));
}
