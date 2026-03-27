# Off-chain Critical Private Data Encryption Review

Date: 2026-03-27

## Key findings

1. **Client-side off-chain file encryption lives in wallet crate** (`citizen-protocol/crates/wallet/src/lib.rs`).
   - `encrypt_offchain_file_reader_to_writer` encrypts file chunks with `ChaCha20Poly1305`.
   - Key material is derived from passphrase using Argon2id.
   - Metadata persisted for verification includes `salt_hex`, `nonce_prefix_hex`, `kdf_params`, and `ciphertext_hash`.

2. **Hybrid DEK wrapping for authorized readers** exists in `citizen-protocol/crates/wallet/src/privacy.rs`.
   - DEKs are generated client-side.
   - DEKs are wrapped using X25519-derived shared secret and `XChaCha20Poly1305`.

3. **API off-chain flow stores/validates refs and commitments, not plaintext payloads** in `citizen-protocol/crates/api/src/lib.rs`.
   - `/api/v1/files/intents` enforces namespace policy and issues object-store upload intents.
   - `/api/v1/files/commit` and `/api/v1/payloads/commit` validate ciphertext/object refs + canonical commitments.
   - Payload-commit endpoint rejects plaintext in fields that must be off-chain encrypted.

4. **Ledger enforces encrypted-entry constraints and consent binding** in `citizen-protocol/crates/ledger/src/lib.rs`.
   - Encrypted entries require ciphertext/nonce/payload commitment.
   - Consent receipt is mandatory and must match payload commitment and reader ACL metadata.

5. **Verification/reconciliation path is implemented** in wallet crate.
   - `verify_offchain_file_object_hash_*` checks ciphertext hash.
   - `verify_offchain_file_reconciliation` checks both ciphertext hash and manifest commitment.

## Practical interpretation

The protocol’s off-chain privacy model is: encrypt private blobs and sensitive fields off-chain, commit deterministic hashes/commitments on-chain, and enforce governance + consent + integrity checks at API and ledger validation boundaries.
