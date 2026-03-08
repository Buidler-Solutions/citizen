# Off-Chain Encrypted Files Error Code Registry (Gate 0)

Status: Draft v1.0.0

This registry defines stable, typed error codes for consent, key-wrap, and namespace-field-policy violations.

## Error Codes

| Code | Category | HTTP | Description |
|---|---|---:|---|
| `OFFCHAIN_POLICY_NOT_FOUND` | policy | 400 | Namespace field policy is missing for a namespace requiring encrypted fields. |
| `OFFCHAIN_POLICY_VERSION_UNSUPPORTED` | policy | 400 | Submitted policy version does not match the active governance policy. |
| `OFFCHAIN_POLICY_VERSION_BELOW_MIN_SUPPORTED` | policy | 422 | Submitted policy version is below namespace `min_supported_policy_version`; migration is required before commit. |
| `OFFCHAIN_FIELD_REQUIRED_ENCRYPTED` | policy | 422 | Required `offchain_encrypted_fields` were not provided as encrypted references. |
| `OFFCHAIN_FIELD_CLASSIFICATION_CONFLICT` | policy | 422 | A field appears in incompatible policy classes for the same namespace version. |
| `OFFCHAIN_CONSENT_RECEIPT_MISSING` | consent | 400 | Consent receipt reference was not provided for encrypted file or encrypted field commit. |
| `OFFCHAIN_CONSENT_RECEIPT_NOT_FOUND` | consent | 404 | Referenced consent receipt cannot be resolved from deterministic receipt index. |
| `OFFCHAIN_CONSENT_RECEIPT_EXPIRED` | consent | 403 | Consent receipt exists but is expired at verification time. |
| `OFFCHAIN_CONSENT_RECEIPT_REVOKED` | consent | 403 | Consent receipt has a revocation status event and cannot authorize reads/writes. |
| `OFFCHAIN_ENCRYPTION_MODE_NOT_ALLOWED` | encryption | 422 | Encryption mode is not allowed by namespace governance constraints. |
| `OFFCHAIN_DEK_WRAP_MISSING_FOR_PARTICIPANT` | key_wrap | 422 | ACL/DEK mode is missing a key wrap for at least one authorized participant wallet. |
| `OFFCHAIN_DEK_WRAP_INVALID_FORMAT` | key_wrap | 422 | Submitted DEK wrap format or algorithm identifier is malformed/unsupported. |
| `OFFCHAIN_DEK_UNWRAP_FORBIDDEN` | key_wrap | 403 | Wallet attempted DEK unwrap/decrypt without an active grant. |
| `OFFCHAIN_DECRYPTION_AUTHZ_FAILED` | key_wrap | 403 | Decrypt request denied because wallet is outside active authorized set. |
| `OFFCHAIN_CIPHERTEXT_HASH_MISMATCH` | integrity | 409 | Off-chain ciphertext object hash does not match committed hash in manifest. |
| `OFFCHAIN_COMMITMENT_MISMATCH` | integrity | 409 | Deterministic commitment from canonical manifest/fields does not match submitted commitment. |
| `OFFCHAIN_INTENT_REPLAY_DETECTED` | replay | 409 | Idempotency or intent nonce reuse indicates replayed commit attempt. |

## Stability Rules

- Error code identifiers are API contracts and MUST remain stable across patch/minor releases.
- New codes may be added; existing codes may only be deprecated with migration notes.
- Namespace-specific messages should map to one of these top-level codes for telemetry consistency.
