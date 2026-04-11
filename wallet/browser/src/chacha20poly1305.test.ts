import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chacha20Poly1305Decrypt } from './chacha20poly1305';

describe('chacha20Poly1305Decrypt', () => {
  it('decrypts ciphertext produced by node chacha20-poly1305', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const plaintext = Buffer.from(JSON.stringify({ hello: 'citizen', count: 2 }), 'utf8');

    const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertextAndTag = new Uint8Array(Buffer.concat([encrypted, tag]));

    const decrypted = chacha20Poly1305Decrypt(new Uint8Array(key), new Uint8Array(nonce), ciphertextAndTag);
    expect(decrypted).not.toBeNull();
    expect(Buffer.from(decrypted ?? new Uint8Array(0)).toString('utf8')).toBe(plaintext.toString('utf8'));
  });

  it('returns null when tag is tampered', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const plaintext = Buffer.from('hello', 'utf8');

    const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertextAndTag = new Uint8Array(Buffer.concat([encrypted, tag]));
    ciphertextAndTag[ciphertextAndTag.length - 1] ^= 0xff;

    const decrypted = chacha20Poly1305Decrypt(new Uint8Array(key), new Uint8Array(nonce), ciphertextAndTag);
    expect(decrypted).toBeNull();
  });
});
