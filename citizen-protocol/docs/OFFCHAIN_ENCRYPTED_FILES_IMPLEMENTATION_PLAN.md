# Off-Chain Encrypted Files Implementation Plan

Status: 🚧 In progress (Gate 0 contracts + vectors implemented)

Owner: Protocol + Wallet + API + Explorer teams

Related baseline: `docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md` (user-owned off-chain custody with on-chain commitments and consent receipts)

## 1) Objective

Deliver a production-ready **opt-in off-chain encrypted files** capability that preserves Citizen's governance-first data ownership model:

- on-chain stores only commitments, consent receipts, status/revocation signals, and governance proofs,
- file bytes stay off-chain in encrypted form,
- users/builders retain custody and controlled sharing,
- verification is deterministic from receipt + commitment paths.

Primary implementation emphasis for v1:

- **Per-namespace field policies first**: each namespace must explicitly define which payload fields are clear, committed-only, or encrypted off-chain.
- **Per-payload encryption off-chain**: sensitive payload fields are encrypted as detached off-chain blobs and referenced by deterministic commitments in the on-chain payload.
- **Grant-only decryption**: decryption must be possible only for wallets that have an explicit active grant, and sharing modes must support all participating wallets in the authorized set without exposing plaintext to non-participants.

## 1.1 Strategic Implementation Start (authoritative execution order)

To start implementation with minimal rework risk, execution proceeds as **three merge gates** before broad feature coding.

### Gate 0 — Canonical Contracts First (must land before crypto/storage code)

Goal: lock deterministic contracts so all teams build against identical inputs/outputs.

Deliver in first PR slice:
- `encrypted_file_manifest.schema.json` (canonical envelope contract).
- `namespace_field_policy.schema.json` (public/committed/offchain-encrypted policy contract).
- `file_commitment_test_vectors.json` and `payload_field_commitment_test_vectors.json`.
- Error-code registry for consent/key-wrap/policy violations.

Exit criteria:
- Deterministic vectors pass in CI across at least Rust + TypeScript implementations.
- Governance/architecture review sign-off recorded in docs.

### Gate 1 — Wallet/SDK Deterministic Crypto Core (no API dependency)

Goal: make encrypt/decrypt/commitment generation correct and reproducible before service integration.

Deliver in second PR slice:
- Streaming encrypt/decrypt primitives for file blobs.
- Field-policy payload splitter (`public`, `committed_only`, `offchain_encrypted`).
- Grant-aware unwrap checks (fail closed without active grant).
- Golden fixture tests proving stable output for same inputs.

Exit criteria:
- Round-trip + adversarial crypto tests passing.
- Non-granted wallet decrypt tests consistently fail.

### Gate 2 — API + Storage Integration Behind Feature Flag

Goal: integrate uploads/commits safely with reversible rollout.

Deliver in third PR slice:
- `POST /api/v1/files/intents`, `POST /api/v1/files/commit`, `POST /api/v1/payloads/commit`.
- Local + S3-compatible storage adapters enforcing policy constraints.
- Idempotency semantics + audit logging for file/payload commit flows.
- Feature flag: `offchain_encrypted_files_v1` (default OFF in production).

Exit criteria:
- End-to-end verification path (`receipt -> commitment -> object hash`) passes.
- Revocation/status transitions propagate to reader access checks.

### First 10 implementation tickets (ready to create now)

1. Spec: add canonical encrypted file manifest JSON schema + examples.
2. Spec: add canonical namespace field policy JSON schema + examples.
3. Crypto: implement deterministic canonicalization for manifest + field commitments.
4. Test: add shared test vectors consumed by Rust and TypeScript.
5. Wallet: implement streaming encrypt/decrypt (passphrase mode).
6. Wallet: implement hybrid ACL/DEK wrapping with per-wallet wraps.
7. SDK: implement namespace-aware payload field partitioning helper.
8. API: implement `/files/intents` with consent + policy precheck.
9. API: implement `/files/commit` and `/payloads/commit` idempotent endpoints.
10. Security: add adversarial integration suite for unauthorized decrypt + replay attempts.

### Sequencing constraints (do not violate)

- Do **not** merge API endpoints before schemas + vectors are locked.
- Do **not** expose explorer views before redaction tests prove no plaintext leaks.
- Do **not** enable production flag before cryptography + key lifecycle review is approved.
- Any namespace adding encrypted fields must include migration/version notes in the same PR.

## 2) Scope (v1)

### In scope
- Canonical file envelope schema (`file_ref`, `ciphertext_hash`, `encryption_mode`, `payload_commitment`, `consent_receipt_ref`).
- Canonical payload field-classification schema per namespace (`public_fields`, `committed_fields`, `offchain_encrypted_fields`).
- Wallet-side encrypt-then-commit for files (passphrase + ACL/DEK modes).
- Wallet/SDK helpers that split payloads by field policy and produce off-chain encrypted field blobs per payload.
- Grant-scoped key wrapping so only explicitly authorized participant wallets can decrypt.
- Deterministic commitment computation for files and metadata manifests.
- Off-chain storage adapter contract (S3-compatible + local dev backend).
- Reader access flow with DEK wrapping + rotation hooks.
- API receipts that expose file commitment verification metadata.
- Explorer read-only visibility (no plaintext) for auditability.
- Revocation/status lifecycle events and replay-safe re-verification.

### Out of scope (v1)
- Native decentralized content routing market mechanisms.
- Automatic legal retention workflows per jurisdiction.
- On-chain storage of encrypted file blobs.

## 3) Architecture Decisions (locked for implementation)

1. **Opt-in only**: default remains clear-text public payload flow unless wallet/builder explicitly selects file encryption mode.
2. **Hash-first anchoring**: chain anchors deterministic commitment values, never file plaintext/ciphertext payload bytes.
3. **Envelope compatibility**: files and encrypted payload-field blobs integrate into existing signed envelope + deterministic receipt contract.
4. **Dual privacy modes**:
   - `passphrase_file` for user-managed sharing.
   - `hybrid_file_acl_dek` for reader-scoped access control.
   - both modes must enforce that only currently granted wallets can decrypt; non-granted wallets must fail closed.
5. **No silent downgrades**: encrypted submissions fail closed if required crypto or consent metadata is missing.
6. **Namespace-governed field encryption**: field classification is a namespace policy artifact, versioned and governance-controlled.
7. **Participating-wallet decrypt set**: ACL/DEK grants must be computed from the full participating-wallet set for the record/action so each authorized participant wallet can decrypt with its own wrap.

## 4) Concrete Delivery Phases

## Phase A — Spec + Contracts

Deliverables:
- Canonical schema for encrypted file manifests.
- Canonical schema for namespace-level payload field policies.
- Commitment algorithm spec (canonical serialization, hashing order, metadata normalization).
- Consent linkage rules for file upload/update/share/revoke events.

Checklist:
- [ ] Add `ENCRYPTED_FILE_*` action set to namespace policy docs.
- [ ] Add `ENCRYPTED_PAYLOAD_FIELD_*` policy fields to namespace specifications.
- [ ] Publish canonical JSON examples for passphrase and ACL/DEK modes.
- [ ] Publish canonical examples showing per-namespace payload split (public vs off-chain encrypted fields).
- [x] Define deterministic commitment test vectors.
- [x] Define error code table for invalid/expired/missing consent or key wraps.

## Phase B — Wallet + SDK Crypto Path

Deliverables:
- Wallet encrypt/decrypt commands for file payloads.
- SDK helpers for file manifest creation + commitment validation.
- SDK helpers for per-payload field extraction/encryption based on namespace policy.

Checklist:
- [ ] Implement streaming encryption path for large files (avoid full-memory buffering).
- [ ] Reuse Argon2id + ChaCha20-Poly1305 standards for passphrase mode.
- [ ] Implement per-reader X25519 DEK wrapping for hybrid mode.
- [x] Enforce grant validation before unwrap/decrypt in wallet SDK APIs.
- [ ] Ensure participating wallets receive deterministic per-wallet key wraps when policy requires multi-party readability.
- [ ] Implement deterministic payload field canonicalization before per-field encryption.
- [ ] Add wallet UX guardrails: explicit opt-in warnings + mode disclosure.
- [ ] Add golden tests for deterministic commitments across platforms.

## Phase C — API + Storage Adapter

Deliverables:
- Upload negotiation endpoint returning pre-signed target and policy constraints.
- Receipt-compatible file submission endpoint.
- Storage adapter abstraction with local + S3-compatible implementations.
- Payload commit endpoint support for off-chain encrypted field references.

Checklist:
- [ ] Add `POST /api/v1/files/intents` (consent + policy precheck).
- [ ] Add `POST /api/v1/files/commit` (anchors file commitment via signed envelope).
- [ ] Add `POST /api/v1/payloads/commit` for entries with off-chain encrypted fields.
- [ ] Add storage policy enforcement (size caps, MIME allowlist, namespace controls).
- [ ] Persist immutable file manifest references with deterministic IDs.
- [ ] Persist encrypted field-blob references keyed by `entry_id + namespace + field_path`.
- [ ] Add retry/idempotency key semantics for commit endpoint.

## Phase D — Governance + Policy Runtime

Deliverables:
- Namespace rule enforcement for encrypted file actions.
- Governance-controlled policy parameters.
- Namespace rule enforcement for payload field classification and required off-chain encryption.

Checklist:
- [ ] Add namespace policy rules for `ENCRYPTED_FILE_UPLOAD`, `ENCRYPTED_FILE_SHARE`, `ENCRYPTED_FILE_REVOKE`.
- [ ] Add namespace policy rules requiring off-chain encryption for configured payload fields.
- [ ] Add governance-managed constraints (max file size, allowed encryption modes, required consent class).
- [ ] Add governance-managed field-policy versioning and migration rules.
- [ ] Add revocation semantics that invalidate future reads while preserving audit history.
- [ ] Add admission/runbook docs for operators handling storage credentials.

## Phase E — Explorer + Verification Tooling

Deliverables:
- Explorer display for file commitment and consent status.
- CLI/SDK verification command for `receipt_id -> file_commitment -> storage object hash`.

Checklist:
- [ ] Add explorer panels for file manifest metadata (hashes, mode, consent state).
- [ ] Ensure no plaintext or secret key material is rendered/logged.
- [ ] Add verifier command examples in docs and runbooks.
- [ ] Add operator alerting for commitment mismatch/revocation conflicts.

## Phase F — Release Gate + Security Validation

Deliverables:
- End-to-end test matrix and release checklist.
- Threat model + security review sign-off packet.

Checklist:
- [ ] Add integration tests for happy path (upload, commit, verify, retrieve, revoke).
- [ ] Add integration tests for per-namespace payload field encryption (serialize -> encrypt off-chain -> commit -> verify).
- [ ] Add adversarial tests (tampered ciphertext, stale consent, unauthorized reader, replayed intent).
- [x] Add adversarial tests ensuring non-granted wallets cannot decrypt and granted participant wallets can decrypt.
- [ ] Add performance tests for 10MB / 100MB / 1GB encrypted file paths.
- [ ] Add performance tests for high-field-count payloads with mixed clear/encrypted fields.
- [ ] Complete cryptography review + key lifecycle review.
- [ ] Publish production readiness report.

## 5) Cross-Team Task Board (Execution Checklist)

### Protocol / Ledger
- [ ] Define canonical commitment derivation for file manifests.
- [ ] Add namespace action validation and revocation events.
- [ ] Add deterministic receipt fields for file commitments.
- [ ] Define canonical commitment derivation for off-chain encrypted payload fields (`field_path -> ciphertext_hash`).

### Wallet / SDK
- [ ] Implement file encryption/decryption APIs.
- [ ] Implement reader ACL + DEK wrapping flows.
- [x] Enforce "grant required" decrypt checks in wallet runtime and SDK helpers.
- [ ] Ship verification helper for off-chain object hash reconciliation.
- [ ] Implement namespace-aware payload partitioning and field-level off-chain encryption helper.

### API / Node
- [ ] Implement file intent + commit endpoints.
- [ ] Add storage adapter interfaces and policy hooks.
- [ ] Add rate limits and abuse controls for file flows.
- [ ] Enforce namespace field policy at submission time (reject missing encrypted off-chain refs).

### Explorer / Indexer
- [ ] Index encrypted-file events and consent status transitions.
- [ ] Add high-signal privacy + revocation UI labels.
- [ ] Index and display encrypted payload field references by namespace and field path (never plaintext).

### Operations / Governance
- [ ] Add credential custody runbook for storage/KMS secrets.
- [ ] Add incident response playbook for encrypted-file compromise scenarios.
- [ ] Add governance proposal templates for file-policy changes.

## 6) Acceptance Criteria (Definition of Done)

This work is complete only when all of the following are true:

- [ ] A user can opt into encrypted file upload from wallet/SDK without plaintext leakage.
- [ ] Namespace field policy deterministically enforces which payload fields are off-chain encrypted.
- [ ] A builder can verify file commitments deterministically from receipt + off-chain object hash.
- [ ] A builder can verify per-payload encrypted field commitments from receipt + field blob hashes.
- [ ] Only wallets with active grants can decrypt; decrypt attempts from non-granted wallets always fail.
- [ ] All authorized participating wallets for a shared record can decrypt via their own wallet-specific key wraps.
- [ ] Reader ACL changes and revocations are reflected in on-chain events and enforced in retrieval paths.
- [ ] Explorer exposes auditable file metadata while revealing no sensitive plaintext.
- [ ] Security review signs off cryptography, key handling, and abuse controls.
- [ ] Runbooks exist for operator deployment, rotation, backup, and incident response.

## 7) Immediate Next Actions (this sprint, execution-start)

### Sprint Goal
Ship **Gate 0 complete** and open **Gate 1 crypto core PR**.

### Committed outcomes
- [ ] Approve this implementation order in governance/architecture review.
- [ ] Create and assign the first 10 tickets above with owners and due dates.
- [x] Merge schemas + deterministic vectors as the first implementation PR.
- [x] Wire CI job to validate vectors in both Rust and TypeScript SDK paths.
- [ ] Open wallet crypto-core PR (streaming encryption + grant-aware unwrap checks).
- [ ] Schedule security design review focused on DEK wrapping, revocation, and replay resistance.

### Hard sprint guardrails
- [ ] No API/storage endpoint merges until Gate 0 artifacts are merged.
- [ ] No production flag enablement until Phase F security sign-off is complete.
