export type EncryptedJsonEnvelope = {
  algorithm: 'aes-gcm';
  version: 1;
  ivBase64: string;
  ciphertextBase64: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    out[index] = raw.charCodeAt(index);
  }
  return out;
}

export function isEncryptedJsonEnvelope(value: unknown): value is EncryptedJsonEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<EncryptedJsonEnvelope>;
  return (
    candidate.algorithm === 'aes-gcm'
    && candidate.version === 1
    && typeof candidate.ivBase64 === 'string'
    && typeof candidate.ciphertextBase64 === 'string'
  );
}

export async function encryptJsonValue(value: unknown, key: CryptoKey): Promise<EncryptedJsonEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    plaintext,
  );
  return {
    algorithm: 'aes-gcm',
    version: 1,
    ivBase64: bytesToBase64(iv),
    ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptJsonValue<T>(
  encrypted: EncryptedJsonEnvelope,
  key: CryptoKey,
): Promise<T | null> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(encrypted.ivBase64),
      },
      key,
      base64ToBytes(encrypted.ciphertextBase64),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

export async function importAesKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
