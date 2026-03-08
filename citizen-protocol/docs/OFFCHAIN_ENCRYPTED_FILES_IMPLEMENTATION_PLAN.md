# Off-Chain Encrypted Files Implementation Plan

Status: 🚧 Planned (not yet implemented)

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
- [ ] Define deterministic commitment test vectors.
- [ ] Define error code table for invalid/expired/missing consent or key wraps.

## Phase B — Wallet + SDK Crypto Path

Deliverables:
- Wallet encrypt/decrypt commands for file payloads.
- SDK helpers for file manifest creation + commitment validation.
- SDK helpers for per-payload field extraction/encryption based on namespace policy.

Checklist:
- [ ] Implement streaming encryption path for large files (avoid full-memory buffering).
- [ ] Reuse Argon2id + ChaCha20-Poly1305 standards for passphrase mode.
- [ ] Implement per-reader X25519 DEK wrapping for hybrid mode.
- [ ] Enforce grant validation before unwrap/decrypt in wallet SDK APIs.
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
- [ ] Add adversarial tests ensuring non-granted wallets cannot decrypt and granted participant wallets can decrypt.
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
- [ ] Enforce "grant required" decrypt checks in wallet runtime and SDK helpers.
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

## 7) Immediate Next Actions (this sprint)

- [ ] Approve this plan in governance/architecture review.
- [ ] Create implementation tickets for Phases A and B with owners + deadlines.
- [ ] Land schema + test vector PR first, before storage/API implementation.
- [ ] Land namespace field-classification schema + payload-field test vectors before endpoint rollout.
- [ ] Schedule security design review focused on DEK wrapping and revocation semantics.
