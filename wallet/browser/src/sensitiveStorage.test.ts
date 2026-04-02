import { describe, expect, it } from 'vitest';
import {
  decryptJsonValue,
  encryptJsonValue,
  importAesKey,
  isEncryptedJsonEnvelope,
} from './sensitiveStorage';

describe('sensitiveStorage', () => {
  it('round-trips encrypted JSON payloads', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAesKey(rawKey);
    const value = {
      requestId: crypto.randomUUID(),
      payloadHash: 'sha256:abc123',
      riskFlags: ['unknown_origin'],
    };

    const encrypted = await encryptJsonValue(value, key);
    expect(isEncryptedJsonEnvelope(encrypted)).toBe(true);

    const decrypted = await decryptJsonValue<typeof value>(encrypted, key);
    expect(decrypted).toEqual(value);
  });

  it('returns null when ciphertext authentication fails', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAesKey(rawKey);
    const encrypted = await encryptJsonValue({ value: 1 }, key);
    const tampered = {
      ...encrypted,
      ciphertextBase64: encrypted.ciphertextBase64.slice(0, -2) + 'ab',
    };

    const decrypted = await decryptJsonValue<{ value: number }>(tampered, key);
    expect(decrypted).toBeNull();
  });
});
