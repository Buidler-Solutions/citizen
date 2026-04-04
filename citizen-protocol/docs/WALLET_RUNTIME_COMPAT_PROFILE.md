# Wallet Runtime Compatibility Profile (WRCP)

Status: Draft v2 (implementation-aligned)

Implementation progress note (2026-04-04):

- Rust wallet crate now exposes `WrcpTxV1SigningPayload`,
  `build_wrcp_tx_v1_signing_payload`, and `wrcp_tx_v1_canonical_json` so wallet
  surfaces can construct and inspect canonical WRCP-TX-V1 preimages using the
  same serialization path as runtime signature verification.

## 1) Purpose

This profile defines the minimum wallet behavior required to interoperate with the Citizen Rust runtime as currently implemented.

Golden rule:

- Wallet behavior MUST conform to runtime validation and signing expectations.
- Wallet UX, provider APIs, and backend login patterns are secondary and must not weaken runtime compliance.
- If an existing wallet surface cannot satisfy runtime requirements, we should revamp that implementation rather than weakening runtime rules.

## 2) Runtime source-of-truth map

Wallet teams must implement against these runtime code paths:

1. Entry signing preimage and signature generation:
   - `citizen-protocol/crates/wallet/src/lib.rs` (`WrcpTxV1SigningPayload`, `build_wrcp_tx_v1_signing_payload`, `wrcp_tx_v1_canonical_json`, `sign_entry`, `verify_entry_signature`).
2. Namespace and policy enforcement:
   - `citizen-protocol/crates/ledger/src/lib.rs` (`validate_entry`, `require_signature`, `consent_policy`, `privacy_policy`, `builder_credit_policy`).
3. Entry schema and privacy fields:
   - `citizen-protocol/crates/types/src/lib.rs` (`LedgerEntry`, `PrivacyMode`, `KeyWrap`).

No wallet-facing spec may contradict these implementations.

## 3) Scope

This profile covers:

- Protocol transaction signing compatibility.
- Multisig builder-credit grant compatibility.
- Privacy-mode envelope compatibility.
- JWT login coexistence boundaries.
- Conformance test matrix and release gates.
- Revamp triggers when implementation diverges from runtime requirements.

This profile does **not** redefine governance policy semantics. It codifies implementation requirements that already exist in the Rust workspace.

## 4) Compatibility lanes (must stay separated)

### 4.1 Auth lane (JWT/login)

Allowed wallet methods:

- `ctzn_requestAccounts` / aliases.
- `personal_sign`.
- `ctzn_signTypedData_v4`.

Expected result:

- Backend challenge/verify flow issues JWT-compatible token.
- Output is a web-session credential, not a ledger-entry signature.

### 4.2 Protocol lane (ledger submissions)

Expected result:

- Wallet outputs a runtime-compatible transaction artifact that can be transformed into a `LedgerEntry` and accepted by namespace validators.
- Signature, payload commitments, privacy metadata, and multisig proofs MUST match Rust runtime checks.

### 4.3 Non-substitution rule

- Auth-lane signatures MUST NOT be reused as protocol-lane signatures.
- Protocol signing keys SHOULD be independently managed from web-login account keys.

## 5) Canonical protocol signing contract (WRCP-TX-V1)

Wallet implementations (browser extension, signer app, mobile signer) MUST support generation of this canonical signing preimage, matching runtime `EntrySigningPayload` semantics:

```json
{
  "entry_id": "uuid",
  "namespace": "string",
  "action": "string",
  "object_id": "string",
  "payload": "json value",
  "privacy_flag": "bool",
  "payload_commitment": "sha256 hex string or null",
  "ciphertext_hex": "hex string or null",
  "nonce_hex": "hex string or null",
  "salt_hex": "hex string or null",
  "kdf_params": "object or null",
  "consent_receipt": "object or null",
  "privacy_mode": "none|passphrase|hybrid",
  "authorized_readers": ["did", "..."],
  "custodian_policy_id": "string or null",
  "key_wrapped_secrets": ["..."],
  "revocation_events": ["..."],
  "field_reader_acls": {"field.path": ["did", "..."]},
  "author": "did",
  "timestamp": 0
}
```

Signing requirements:

1. Canonicalize JSON deterministically.
2. Sign canonical bytes with the selected protocol signing key.
3. Emit the signature as lowercase hex.
4. Include all privacy/multisig-related fields in the signed preimage.
5. Verify locally with the same preimage reconstruction used by runtime verifier.

## 6) Runtime-required validation compatibility

Wallet outputs must satisfy runtime checks for:

- Namespace writer permissions.
- Required non-empty signature.
- Consent policy and TTL requirements where configured.
- Privacy policy metadata requirements.
- Builder-credit multisig proof checks.

Failure to satisfy any runtime rule means wallet incompatibility.

## 7) Privacy mode compatibility matrix

### 7.1 `privacy_mode = none`

Required fields:

- `privacy_flag = false`
- `ciphertext_hex = null`
- `nonce_hex = null`
- `consent_receipt = null`

### 7.2 `privacy_mode = passphrase`

Required fields:

- `privacy_flag = true`
- `payload_commitment`
- `ciphertext_hex`
- `nonce_hex`
- `salt_hex`
- `kdf_params` (Argon2id-compatible)
- `consent_receipt` with matching `data_hash`, `authorized_readers`, and ACL fields

### 7.3 `privacy_mode = hybrid`

Required fields:

- `privacy_flag = true`
- `payload_commitment`
- `ciphertext_hex`
- `nonce_hex` (XChaCha20 nonce format)
- `key_wrapped_secrets` containing all `authorized_readers`
- `consent_receipt` consistency with entry fields

## 8) Multisig credit-grant compatibility (WRCP-MSIG-V1)

For `builder.credits` + `MULTISIG_CREDIT_GRANT`:

- Wallet MUST include `payload.multisig_proofs` array.
- Each proof MUST contain:
  - `approver`
  - `public_key`
  - `signature`
- Approvers and public keys must be drawn from runtime policy `grant_approvers`.
- Unique approvals count must satisfy `required_grant_approvals`.
- Signature payload shape must match runtime verifier message composition.

## 9) Known compatibility gaps (current implementation baseline)

These are known risks until closed:

1. Some wallet surfaces return envelope/hash artifacts that are not yet 1:1 replacements for runtime `LedgerEntry` signing flows.
2. Multisig proof authoring UX may exist without complete runtime-equivalent proof generation and validation.
3. Local key custody hardening may lag behind runtime wallet crate expectations.

Gaps in this section are release blockers for strict runtime compatibility claims.

## 10) Revamp triggers (when we should refactor instead of patch)

A wallet implementation should be revamped when any one of these is true:

1. Runtime rejects more than 0.1% of wallet-produced entries in conformance tests.
2. Wallet cannot produce privacy-mode metadata required by runtime validators.
3. Wallet cannot produce multisig proof payloads accepted by runtime checks.
4. Auth and protocol signature lanes are mixed in a way that can cause replay or semantic confusion.
5. Key custody model persists protocol private keys without adequate at-rest protection.

## 11) JWT coexistence rules

To prevent identity/signature confusion:

1. A JWT login signature MUST NOT be reused as protocol transaction signature.
2. Wallets SHOULD display explicit intent labels:
   - `Sign in (JWT auth)`
   - `Sign protocol transaction (Citizen runtime)`
3. Backends MUST verify auth signatures and tx signatures using their respective contracts.

## 12) Key management requirements (minimum bar)

Wallet implementations SHOULD align with Rust wallet custody posture:

- Private signing keys encrypted at rest using password-derived key material.
- KDF-hardening for local secret encryption (Argon2id/scrypt equivalent).
- No plaintext private keys persisted where avoidable.
- Clear key-role separation where both auth and protocol signing keys coexist.

## 13) Conformance test matrix (required for release)

### 13.1 Protocol signing conformance

- Generate entry via wallet implementation.
- Verify signature using Rust verifier.
- Submit against node/API and assert acceptance under expected namespace rules.

### 13.2 Privacy conformance

- `none`, `passphrase`, and `hybrid` entry generation tests.
- Negative tests for missing required metadata (`payload_commitment`, `nonce`, etc.).
- Consent receipt mismatch tests.

### 13.3 Multisig conformance

- Valid threshold pass test.
- Unauthorized approver fail test.
- Public-key mismatch fail test.
- Insufficient unique approvals fail test.

### 13.4 Auth lane regression

- Challenge/verify flow with `personal_sign` and `ctzn_signTypedData_v4`.
- Ensure session token issuance and revocation remain functional.
- Ensure auth changes do not alter protocol signing artifacts.

## 14) CI release gates (wallet/browser and signer apps)

A release candidate is blocked unless:

1. WRCP-TX-V1 tests pass against Rust verifier.
2. WRCP-MSIG-V1 tests pass against Rust ledger policy checks.
3. Privacy matrix tests pass.
4. Auth lane tests pass.
5. Backward compatibility tests for supported signer payload versions pass.

## 15) Versioning and migration

- Profile versions MUST be explicit (`WRCP v1`, `v2`, ...).
- Any signing preimage change requires:
  1. new versioned contract,
  2. migration tests,
  3. compatibility window and rollback plan.

## 16) Immediate implementation checklist

- [x] Implement wallet-side `WRCP-TX-V1` preimage generator.
- [ ] Add wallet-side verifier fixtures from Rust canonical test vectors.
- [ ] Implement `WRCP-MSIG-V1` proof builder + local dry-run checks.
- [ ] Add privacy mode generation flows that satisfy runtime-required fields.
- [ ] Enforce UX lane separation for JWT vs protocol signing.
- [ ] Add CI gate job for WRCP conformance before release publish.
- [ ] Add runtime-rejection telemetry dashboard to detect drift post-release.
