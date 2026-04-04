# Wallet Runtime Compatibility Profile (WRCP)

Status: Draft v2 (implementation-aligned)

Implementation progress note (2026-04-04):

- Rust wallet crate now exposes `WrcpTxV1SigningPayload`,
  `build_wrcp_tx_v1_signing_payload`, and `wrcp_tx_v1_canonical_json` so wallet
  surfaces can construct and inspect canonical WRCP-TX-V1 preimages using the
  same serialization path as runtime signature verification.
- Wallet CLI now supports:
  - `sign-builder-credit-proof` for runtime-shaped `multisig_proofs` elements
    (approver/public_key/signature + exact signing payload string), and
  - `dry-run-builder-credit-grant` for pre-submit multisig validation reports,
  - `sign-builder-credit-grant` with `--multisig-proofs-json` injection for
    `builder.credits/MULTISIG_CREDIT_GRANT` submissions.
- Wallet tests now consume shared vector fixtures under
  `docs/test-vectors/` for file-manifest commitments and payload-field
  commitments, improving cross-surface determinism checks.

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
2. Multisig proof authoring currently relies on CLI/manual composition patterns;
   there is not yet a high-level wallet API that derives grant proofs directly
   from namespace policy (`required_grant_approvals`, `grant_approvers`) and
   performs full pre-submit dry-run validation.
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
- [x] Add wallet-side verifier fixtures from shared test vectors (`docs/test-vectors/*` for commitment determinism coverage).
- [~] Implement `WRCP-MSIG-V1` proof builder + local dry-run checks (wallet lib now exposes proof builder + dry-run primitives; full policy-driven end-to-end wiring and parity vectors remain open).
- [x] Add privacy mode generation flows that satisfy runtime-required fields (`none` / `passphrase` / `hybrid` in wallet signing path).
- [ ] Enforce UX lane separation for JWT vs protocol signing.
- [ ] Add CI gate job for WRCP conformance before release publish.
- [ ] Add runtime-rejection telemetry dashboard to detect drift post-release.

## 17) Next implementation slice (v2.1 execution plan)

To continue implementation from the current baseline, prioritize the following
work items in order:

1. **Wallet library multisig builder API**
   - Add a first-class helper in `crates/wallet` that accepts:
     - a candidate `LedgerEntry` (`builder.credits` + `MULTISIG_CREDIT_GRANT`),
     - `approver` key material,
     - namespace policy snapshot (`required_grant_approvals`, `grant_approvers`).
   - Return a runtime-compatible proof object and append/merge it into
     `payload.multisig_proofs`.
   - Reuse the same signing payload composition expected by ledger verifier logic.

2. **Local dry-run compatibility check**
   - Add wallet-side dry-run helper that validates:
     - proof shape,
     - approver membership,
     - public-key binding,
     - unique approvals threshold.
   - This should fail fast before API submit and mirror ledger rejection reasons.

3. **Cross-crate WRCP conformance fixtures**
   - Introduce dedicated WRCP fixtures for:
     - canonical TX signing payload bytes,
     - signature pass/fail cases,
     - multisig proof pass/fail matrix.
   - Reuse fixtures in both wallet and ledger tests to detect drift.

4. **CI release gate wiring**
   - Add a CI job that runs WRCP-focused tests as a release blocker, including
     privacy and multisig negative cases.

## 18) Definition of done for “WRCP strict compatibility”

Strict compatibility should only be claimed when all are true:

1. Wallet surfaces can produce WRCP-TX-V1 canonical payloads and signatures that
   verify with runtime verifier.
2. Wallet surfaces can produce WRCP-MSIG-V1 proofs without manual JSON editing.
3. Pre-submit wallet dry-run catches the same structural failures as ledger
   runtime tests for supported negative vectors.
4. CI enforces WRCP conformance on every release candidate.

## 19) WRCP implementation checklist guide (track done vs not done)

Use this checklist as the canonical progress tracker for WRCP strict
compatibility work.

Status legend:

- `[x]` complete and merged to default branch
- `[~]` partially implemented
- `[ ]` not started

Last checklist refresh: **2026-04-04 (post wallet proof-builder + dry-run API landing)**.

### 19.1 Wallet multisig builder API (`build_wrcp_msig_v1_proof`)

- [x] Add API to `crates/wallet` with explicit input contract:
  - `entry: &LedgerEntry`
  - `approver_did: &str`
  - `approver_private_key_hex: &str`
  - `namespace_policy: &NamespaceConfig`
- [x] Return runtime-compatible proof object containing:
  - `approver`
  - `public_key`
  - `signature`
- [x] Reject non-`builder.credits` / non-`MULTISIG_CREDIT_GRANT` entries.
- [x] Reject approvers not present in `grant_approvers`.
- [x] Guarantee signing payload parity with ledger verifier composition.
- [x] Emit lowercase-hex signatures.
- [~] Add wallet crate unit tests for pass + fail cases.

### 19.2 Wallet local dry-run helper (`dry_run_wrcp_msig_v1`)

- [x] Add API to `crates/wallet` with input:
  - `entry: &LedgerEntry`
  - `namespace_policy: &NamespaceConfig`
- [x] Return typed report (`ok`, `required_approvals`, `unique_approvals`,
  `errors`, `warnings`).
- [x] Validate proof schema for every `payload.multisig_proofs` element.
- [x] Validate approver membership and public-key binding.
- [x] Validate unique-approval threshold.
- [~] Emit machine-parseable failure reasons shared by CLI + SDK surfaces.
- [ ] Add dry-run parity tests against ledger negative vectors.

### 19.3 Shared WRCP test vectors

- [ ] Add `docs/test-vectors/wrcp_tx_v1/canonical_payloads.json`.
- [ ] Add `docs/test-vectors/wrcp_tx_v1/signature_cases.json`.
- [ ] Add `docs/test-vectors/wrcp_msig_v1/proof_matrix.json`.
- [ ] Include pass/fail matrix for:
  - unauthorized approver
  - duplicate approver counted once
  - invalid public key
  - malformed signature
  - below-threshold approvals
- [ ] Ensure wallet tests consume these vectors.
- [ ] Ensure ledger tests consume the same vectors.
- [ ] Fail CI when fixture changes are not validated in both crates.

### 19.4 CI release gate wiring (`wrcp-conformance`)

- [ ] Add CI job running wallet WRCP unit tests.
- [ ] Add CI job running ledger WRCP policy tests.
- [ ] Add shared-fixture consistency check.
- [ ] Add simulation smoke test for multisig grant submit path.
- [ ] Mark job as required for protected branch + release tags.
- [ ] Disallow allow-failure/optional mode.
- [ ] Upload failure artifacts:
  - canonical payload diff
  - failing vector ID
  - dry-run report JSON

### 19.5 Runtime-rejection telemetry

- [ ] Emit rejection metrics with labels:
  - `reason_code`
  - `namespace`
  - `action`
  - `wallet_profile_version` (if supplied)
  - `node_mode`
- [ ] Emit counters/gauges:
  - `wrcp_rejections_total{reason_code,...}`
  - `wrcp_accepts_total{namespace,action}`
  - `wrcp_rejection_ratio_5m`
- [ ] Add alert: `wrcp_rejection_ratio_5m > 0.001` for 15 minutes in WRCP
  production namespaces.

### 19.6 Documentation sync requirements (same PR as implementation)

- [ ] Update `citizen-protocol/README.md` WRCP compatibility line.
- [ ] Update
  `citizen-protocol/docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md` WRCP status.
- [ ] Update wallet CLI docs/examples for multisig builder and dry-run outputs.
- [ ] Update this WRCP profile checklist statuses.

## 20) Release sign-off checklist (strict compatibility claim)

Do not claim “wallet runtime compatibility complete” until all are checked:

- [ ] WRCP-TX-V1 payload/signature conformance passes against runtime verifier.
- [ ] WRCP-MSIG-V1 flow works without manual JSON editing.
- [ ] Wallet dry-run and ledger runtime agree on supported negative vectors.
- [ ] CI enforces WRCP conformance on every release candidate.

## 21) Next implementation sprint backlog (v2.1 → v2.2)

The following backlog continues implementation with merge-ready slices that can
land independently while preserving runtime compatibility.

### 21.1 Wallet crate API surface additions

Add these public exports in `crates/wallet/src/lib.rs`:

- `WrcpMsigV1Proof` (typed representation of `payload.multisig_proofs[]`).
- `WrcpMsigV1DryRunReport` + `WrcpMsigV1Issue` (typed dry-run output for CLI/SDK).
- `build_wrcp_msig_v1_proof(...) -> Result<WrcpMsigV1Proof, WalletError>`.
- `dry_run_wrcp_msig_v1(...) -> WrcpMsigV1DryRunReport`.

Design constraints:

1. Keep deterministic serialization for any signed bytes (same canonical JSON
   path used by runtime compatibility helpers).
2. Return machine-parseable error codes (not only display text).
3. Keep APIs data-model-first so Node SDK and CLI can consume the same report
   schema without adapter glue.

### 21.2 Wallet CLI command additions

Extend `wallet/cli` with two commands:

1. `build-builder-credit-proof`
   - Inputs:
     - `--entry-json <path>`
     - `--approver-did <did>`
     - key source flags consistent with existing signing commands
     - `--namespace-policy-json <path>`
   - Output:
     - proof JSON object (`approver`, `public_key`, `signature`)
     - optional `--in-place` mode to append into `payload.multisig_proofs`.

2. `dry-run-builder-credit-grant`
   - Inputs:
     - `--entry-json <path>`
     - `--namespace-policy-json <path>`
   - Output:
     - structured report JSON
     - non-zero exit when `ok=false`.

CLI behavior requirements:

- `--json` output must be stable for test snapshotting.
- failure output must include both `reason_code` and human-readable explanation.
- no command should mutate input files unless explicitly requested.

### 21.3 Ledger-aligned reason-code contract

To keep dry-run parity observable and testable, standardize the following
reason codes across wallet dry-run output and ledger tests:

- `MSIG_NOT_BUILDER_CREDITS_GRANT`
- `MSIG_PROOFS_MISSING`
- `MSIG_APPROVER_NOT_AUTHORIZED`
- `MSIG_PUBLIC_KEY_MISMATCH`
- `MSIG_SIGNATURE_INVALID`
- `MSIG_APPROVALS_BELOW_THRESHOLD`
- `MSIG_DUPLICATE_APPROVER`

Implementation rule:

- Wallet dry-run may emit advisory warnings in addition to these errors, but
  must not rename or overload these canonical error codes.

### 21.4 Shared vector rollout order

Implement vectors in this sequence to reduce merge conflicts:

1. Add skeleton files under:
   - `docs/test-vectors/wrcp_tx_v1/canonical_payloads.json`
   - `docs/test-vectors/wrcp_tx_v1/signature_cases.json`
   - `docs/test-vectors/wrcp_msig_v1/proof_matrix.json`
2. Wire wallet tests to parse and assert vectors.
3. Wire ledger tests to consume the same files.
4. Add CI guard ensuring both crates exercised vector IDs changed in a PR.

Vector schema guidance:

- each case MUST have stable `case_id`.
- pass/fail expectations MUST be explicit (`expect_accept: true|false`).
- failing cases MUST include expected canonical `reason_code`.

### 21.5 CI/pipeline acceptance bar

Add a required pipeline stage: `wrcp-conformance`.

Minimum command matrix (workspace-root examples):

```bash
cargo test -p citizen-wallet wrcp_
cargo test -p citizen-ledger wrcp_
cargo test -p citizen-simulation multisig_credit_grant
```

Pipeline requirements:

1. Stage is required for protected branches and release tags.
2. Fixture drift check fails if wallet/ledger tests do not both reference newly
   added vector IDs.
3. Artifacts uploaded on failure:
   - dry-run report JSON
   - failing `case_id`
   - canonical-payload diff (when applicable).

## 22) PR slicing template for maintainers

Use this slicing template so WRCP work can ship incrementally:

1. **PR-A (wallet types + builder helper)**
   - Introduce `WrcpMsigV1Proof` and proof-builder function.
   - Add focused unit tests.
2. **PR-B (dry-run + reason codes)**
   - Introduce dry-run report types and canonical reason-code mapping.
   - Add fail-matrix unit tests.
3. **PR-C (shared vectors)**
   - Add WRCP vector files and hook both wallet + ledger tests.
4. **PR-D (CLI integration)**
   - Add `build-builder-credit-proof` and `dry-run-builder-credit-grant`.
   - Add CLI golden-output tests.
5. **PR-E (CI gate)**
   - Add required `wrcp-conformance` workflow and artifact upload.

Each PR should update Section 19 checklist statuses in the same change.

## 23) Exit criteria for v2.2 checklist refresh

Before moving profile status from “Draft v2” to “Draft v2.2”, confirm:

1. At least one non-test wallet surface (CLI or SDK flow) can build and dry-run
   multisig grants without manual JSON edits.
2. Shared WRCP vectors are consumed by both wallet and ledger tests in CI.
3. Failure reason-code parity is asserted in automated tests.
4. This document’s Sections 16 and 19 are updated with real completion status
   (no stale `[x]` markers).

## 24) WRCP canonical data contracts (v2.2 draft targets)

This section provides concrete JSON contracts so implementation PRs can converge
without re-debating field names.

### 24.1 `WrcpMsigV1Proof` JSON shape

`payload.multisig_proofs[]` SHOULD serialize as:

```json
{
  "approver": "did:citizen:approver-1",
  "public_key": "02ab...ef",
  "signature": "4f2c...91"
}
```

Contract requirements:

1. `approver` MUST be a non-empty DID string.
2. `public_key` MUST be lowercase-hex encoded compressed secp256k1 bytes.
3. `signature` MUST be lowercase-hex ECDSA signature bytes produced from the
   runtime-compatible multisig signing payload.

### 24.2 `WrcpMsigV1DryRunReport` JSON shape

Wallet/CLI/SDK dry-run output SHOULD use this stable structure:

```json
{
  "ok": false,
  "required_approvals": 2,
  "unique_approvals": 1,
  "errors": [
    {
      "reason_code": "MSIG_APPROVALS_BELOW_THRESHOLD",
      "message": "Unique authorized approvals 1/2."
    }
  ],
  "warnings": []
}
```

Implementation notes:

- `errors` MUST be deterministic in order (input-proof order, then threshold
  summary checks).
- `warnings` are non-blocking but MUST NOT hide errors.
- `ok=true` iff `errors` is empty.

### 24.3 Reason-code extension policy

To preserve backward compatibility for automation:

1. Existing canonical reason codes in Section 21.3 are immutable once released.
2. New reason codes MAY be added, but only as additive change.
3. Any addition MUST update:
   - wallet dry-run tests,
   - ledger parity tests,
   - vector fixtures,
   - CLI docs/examples in same PR.

## 25) Test-vector schema draft (for `docs/test-vectors/`)

Use the following minimal schema so vectors remain portable across crates.

### 25.1 `wrcp_tx_v1/canonical_payloads.json`

Each case SHOULD include:

- `case_id` (string, stable)
- `entry` (full `LedgerEntry` JSON)
- `expected_canonical_json` (string)
- `expected_sha256_hex` (string)

### 25.2 `wrcp_tx_v1/signature_cases.json`

Each case SHOULD include:

- `case_id`
- `entry`
- `author_public_key_hex`
- `signature_hex`
- `expect_accept`
- `expected_reason_code` (required when `expect_accept=false`)

### 25.3 `wrcp_msig_v1/proof_matrix.json`

Each case SHOULD include:

- `case_id`
- `namespace_policy`
- `entry`
- `expect_accept`
- `expected_reason_code` (required for failures)
- `notes` (optional human context)

Vector hygiene rules:

1. `case_id` values MUST never be reused with changed semantics.
2. `entry_id` in fixtures SHOULD be deterministic UUIDs to avoid noisy diffs.
3. Vector files SHOULD stay sorted by `case_id`.

## 26) Operator-facing rollout notes (when enabling strict mode)

For namespaces adopting WRCP strict compatibility in production-like
environments:

1. Enable dry-run in wallet/SDK by default before submit.
2. Track rejection ratios by `reason_code` for at least one full release cycle.
3. Only enforce hard fail on unknown wallet profile versions after observing
   compatibility telemetry and publishing migration guidance.

Recommended staged rollout:

- **Phase 0 (observe):** emit metrics only, no policy hardening changes.
- **Phase 1 (warn):** return warning metadata for likely future failures.
- **Phase 2 (enforce):** reject incompatible submissions according to WRCP
  conformance gate.

## 27) Maintainer update protocol for this document

When a WRCP implementation PR lands, update this file in the same PR:

1. Refresh Section 16 and Section 19 checklist markers.
2. Add/adjust implementation progress note date at the top.
3. Link new commands or fixtures in relevant sections.
4. If behavior changed, add a short migration note under Section 15.

This keeps the profile implementation-aligned and prevents stale “paper spec”
drift.

## 28) v2.2 implementation wave (detailed execution slices)

This wave expands Section 21 backlog items into merge-ready tasks with explicit
inputs, outputs, and acceptance checks.

### 28.1 PR-A1: wallet proof type + serializer contract

Goal:

- Introduce `WrcpMsigV1Proof` and ensure deterministic JSON field ordering for
  any payload that is signed or snapshot-tested.

Changes:

1. Add `WrcpMsigV1Proof` Rust type in `crates/wallet/src/lib.rs`.
2. Add serde tests proving serialized key order:
   - `approver`
   - `public_key`
   - `signature`
3. Add lower-hex normalization helper used by builder + CLI outputs.

Acceptance:

- `cargo test -p citizen-wallet wrcp_msig_v1_proof_serialization`.

### 28.2 PR-A2: proof builder core logic

Goal:

- Implement `build_wrcp_msig_v1_proof(...)` with runtime-compatible message
  composition and policy membership checks.

Required behavior:

1. Reject entries not matching `builder.credits` + `MULTISIG_CREDIT_GRANT`.
2. Verify approver membership in namespace `grant_approvers`.
3. Derive approver public key from provided private key and enforce
   public-key consistency.
4. Emit `WrcpMsigV1Proof` with lowercase-hex signature.

Acceptance:

- Wallet tests cover:
  - success case,
  - unauthorized approver,
  - invalid key material,
  - non-builder-credit action.

### 28.3 PR-B1: dry-run report and canonical reason codes

Goal:

- Implement `dry_run_wrcp_msig_v1(...)` with deterministic report output and
  canonical reason-code mapping.

Required behavior:

1. Report shape matches Section 24.2.
2. `ok` derives from `errors.is_empty()`.
3. `unique_approvals` counts unique authorized approvers only.
4. Duplicate approvers produce warning and (if policy requires) threshold error.

Acceptance:

- Tests assert exact reason codes from Section 21.3.
- Tests assert deterministic error ordering.

### 28.4 PR-B2: ledger parity matrix tests

Goal:

- Ensure wallet dry-run verdicts and ledger verifier outcomes agree on known
  fail classes.

Required behavior:

1. Shared fail matrix drives both wallet and ledger tests.
2. Each failing case asserts `expected_reason_code`.
3. CI fails when a new fail class is added without parity coverage.

Acceptance:

- `cargo test -p citizen-wallet wrcp_msig_v1_parity`.
- `cargo test -p citizen-ledger wrcp_msig_v1_parity`.

### 28.5 PR-C1: test-vector files + schema guard

Goal:

- Land initial vector corpus and enforce schema stability.

Required behavior:

1. Create vector files from Section 25.
2. Add parser validation test in both wallet + ledger crates.
3. Add schema guard script/test ensuring:
   - unique `case_id`,
   - sorted by `case_id`,
   - failure cases include `expected_reason_code`.

Acceptance:

- `cargo test -p citizen-wallet wrcp_vector_schema`.
- `cargo test -p citizen-ledger wrcp_vector_schema`.

### 28.6 PR-D1: CLI command implementation

Goal:

- Add ergonomic command path that removes manual JSON proof editing.

Commands:

1. `build-builder-credit-proof`
2. `dry-run-builder-credit-grant`

Required behavior:

1. Respect `--json` deterministic output.
2. Use non-zero exit code when `dry-run` returns `ok=false`.
3. Preserve no-mutation default unless `--in-place` is provided.

Acceptance:

- CLI golden tests for both success and failure output.
- One integration test proving `build ... --in-place` appends a proof and
  dry-run passes threshold for a valid fixture.

### 28.7 PR-E1: CI release gate wiring

Goal:

- Make WRCP conformance a required release blocker.

Required behavior:

1. Add `wrcp-conformance` workflow stage running:
   - wallet WRCP tests,
   - ledger WRCP tests,
   - simulation multisig smoke.
2. Upload on failure:
   - case ID,
   - reason code,
   - canonical payload diff report.
3. Mark stage required for protected branches and release tags.

Acceptance:

- Branch protection documentation updated in same PR.
- Dry-run of workflow validates artifact upload paths.

## 29) Canonical reason-code message registry (draft)

To keep CLI/SDK/operator UX consistent, map canonical codes to stable default
messages. These are defaults only; clients may add context suffixes.

| Reason code | Default message |
| --- | --- |
| `MSIG_NOT_BUILDER_CREDITS_GRANT` | Entry is not a builder credit multisig grant action. |
| `MSIG_PROOFS_MISSING` | `payload.multisig_proofs` is missing or empty. |
| `MSIG_APPROVER_NOT_AUTHORIZED` | Approver is not in namespace grant approvers list. |
| `MSIG_PUBLIC_KEY_MISMATCH` | Proof public key does not match approver key material. |
| `MSIG_SIGNATURE_INVALID` | Proof signature failed runtime-compatible verification. |
| `MSIG_APPROVALS_BELOW_THRESHOLD` | Unique authorized approvals are below required threshold. |
| `MSIG_DUPLICATE_APPROVER` | Duplicate approver proof detected; counted once. |

Registry rules:

1. Message text may be clarified, but reason-code identifiers are immutable once
   shipped.
2. Any registry addition requires:
   - vector additions,
   - wallet + ledger parity tests,
   - CLI docs update.

## 30) Maintainer handoff checklist for the next contributor

Before starting the next WRCP PR, perform this quick handoff sequence:

1. Read Sections 16, 19, 28, and 29 to confirm current open items.
2. Pick exactly one slice (`PR-A1`, `PR-A2`, `PR-B1`, etc.) as primary scope.
3. Add/refresh test vectors first if the slice introduces new fail classes.
4. Ensure the same PR updates checklist status markers and progress notes.
5. If a reason code changes, update:
   - this profile,
   - wallet tests,
   - ledger tests,
   - CLI help/examples.

This protocol keeps WRCP changes incremental, reviewable, and implementation
aligned across wallet, ledger, and CI surfaces.
