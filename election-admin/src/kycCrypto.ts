/**
 * KYC encryption utilities — X25519 hybrid (protocol-standard).
 *
 * Admin-side: key generation + decryption.
 * Uses Web Crypto API for X25519 ECDH (no external deps).
 */

import { chacha20Poly1305Decrypt } from './chacha20poly1305';

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

export interface KycKeyPair {
  publicKeyHex: string;
  privateKeyHex: string;
}

export function kycReaderDid(publicKeyHex: string): string {
  return `did:key:x25519:${publicKeyHex}`;
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

export async function generateKycKeyPair(): Promise<KycKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'X25519' }, true, ['deriveBits'],
  );
  const rawPublic = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

  const dBytes = fromBase64Url(jwk.d!);
  const xBytes = new Uint8Array(rawPublic);

  return {
    privateKeyHex: toHex(dBytes),
    publicKeyHex: toHex(xBytes),
  };
}

function fromBase64Url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

async function x25519SharedSecret(privateKeyHex: string, publicKeyHex: string): Promise<Uint8Array> {
  const privBytes = fromHex(privateKeyHex);
  const pubBytes = fromHex(publicKeyHex);

  const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + privBytes.length);
  pkcs8.set(X25519_PKCS8_PREFIX, 0);
  pkcs8.set(privBytes, X25519_PKCS8_PREFIX.length);

  const spki = new Uint8Array(X25519_SPKI_PREFIX.length + pubBytes.length);
  spki.set(X25519_SPKI_PREFIX, 0);
  spki.set(pubBytes, X25519_SPKI_PREFIX.length);

  const privKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits']);
  const pubKey = await crypto.subtle.importKey('spki', spki, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: pubKey }, privKey, 256);
  return new Uint8Array(shared);
}

export interface KycWrappedSecret {
  reader_id: string;
  wrapped_dek: string;
}

export async function decryptKycHybrid(
  ciphertextHex: string,
  nonceHex: string,
  authorPublicKeyHex: string,
  keyWrappedSecrets: KycWrappedSecret[],
  adminReaderDid: string,
  adminPrivateKeyHex: string,
): Promise<{ full_name: string; address: string } | null> {
  const matching = keyWrappedSecrets.find((s) => s.reader_id === adminReaderDid);
  if (!matching) return null;

  const sharedSecret = await x25519SharedSecret(adminPrivateKeyHex, authorPublicKeyHex);
  const wrapKey = await sha256(sharedSecret);

  const wrapped = fromHex(matching.wrapped_dek);
  if (wrapped.length <= 12) return null;
  const wrapNonce = wrapped.slice(0, 12);
  const wrapCt = wrapped.slice(12);
  const dek = chacha20Poly1305Decrypt(wrapKey, wrapNonce, wrapCt);
  if (!dek || dek.length !== 32) return null;

  const payloadNonce = fromHex(nonceHex);
  if (payloadNonce.length !== 12) return null;
  const ciphertext = fromHex(ciphertextHex);
  const plaintext = chacha20Poly1305Decrypt(dek, payloadNonce, ciphertext);
  if (!plaintext) return null;

  return JSON.parse(TEXT_DECODER.decode(plaintext));
}
