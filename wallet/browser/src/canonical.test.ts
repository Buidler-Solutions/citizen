import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256DigestHex } from './canonical';

describe('canonicalJson', () => {
  it('sorts keys and drops undefined object fields', () => {
    const output = canonicalJson({ z: 1, a: { d: 2, c: 1, omit: undefined }, maybe: undefined });
    expect(output).toBe('{"a":{"c":1,"d":2},"z":1}');
  });
});

describe('sha256DigestHex', () => {
  it('matches protocol payload field commitment test vector format', async () => {
    const input = {
      namespace: 'identity.citizen',
      schema_version: '1.0.0',
      policy_version: 1,
      entry_id: 'entry-2001',
      fields: [
        {
          field_path: 'claims.address',
          ciphertext_hash: 'sha256:3c8c1af6f9d6e2f6de53726d97cf3dc2e31de4d12888da265fa1f49f8f465f4f',
        },
        {
          field_path: 'claims.national_id',
          ciphertext_hash: 'sha256:d5a2a9d8e5b6822fdd2659ae8354570b5e27f6587f7f8e0ae5d8f6a22ec7c222',
        },
      ],
    };

    const canonical = canonicalJson(input);
    expect(canonical).toBe('{"entry_id":"entry-2001","fields":[{"ciphertext_hash":"sha256:3c8c1af6f9d6e2f6de53726d97cf3dc2e31de4d12888da265fa1f49f8f465f4f","field_path":"claims.address"},{"ciphertext_hash":"sha256:d5a2a9d8e5b6822fdd2659ae8354570b5e27f6587f7f8e0ae5d8f6a22ec7c222","field_path":"claims.national_id"}],"namespace":"identity.citizen","policy_version":1,"schema_version":"1.0.0"}');
    await expect(sha256DigestHex(canonical)).resolves.toBe('sha256:8d37bce43423a6d789cb90d276bb4ef56b39acee526e7fa8fe7bc85afc788731');
  });
});
