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

## 2) Scope (v1)

### In scope
- Canonical file envelope schema (`file_ref`, `ciphertext_hash`, `encryption_mode`, `payload_commitment`, `consent_receipt_ref`).
- Wallet-side encrypt-then-commit for files (passphrase + ACL/DEK modes).
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
3. **Envelope compatibility**: files integrate into existing signed envelope + deterministic receipt contract.
4. **Dual privacy modes**:
   - `passphrase_file` for user-managed sharing.
   - `hybrid_file_acl_dek` for reader-scoped access control.
5. **No silent downgrades**: encrypted submissions fail closed if required crypto or consent metadata is missing.

## 4) Concrete Delivery Phases

## Phase A — Spec + Contracts

Deliverables:
- Canonical schema for encrypted file manifests.
- Commitment algorithm spec (canonical serialization, hashing order, metadata normalization).
- Consent linkage rules for file upload/update/share/revoke events.

Checklist:
- [ ] Add `ENCRYPTED_FILE_*` action set to namespace policy docs.
- [ ] Publish canonical JSON examples for passphrase and ACL/DEK modes.
- [ ] Define deterministic commitment test vectors.
- [ ] Define error code table for invalid/expired/missing consent or key wraps.

## Phase B — Wallet + SDK Crypto Path

Deliverables:
- Wallet encrypt/decrypt commands for file payloads.
- SDK helpers for file manifest creation + commitment validation.

Checklist:
- [ ] Implement streaming encryption path for large files (avoid full-memory buffering).
- [ ] Reuse Argon2id + ChaCha20-Poly1305 standards for passphrase mode.
- [ ] Implement per-reader X25519 DEK wrapping for hybrid mode.
- [ ] Add wallet UX guardrails: explicit opt-in warnings + mode disclosure.
- [ ] Add golden tests for deterministic commitments across platforms.

## Phase C — API + Storage Adapter

Deliverables:
- Upload negotiation endpoint returning pre-signed target and policy constraints.
- Receipt-compatible file submission endpoint.
- Storage adapter abstraction with local + S3-compatible implementations.

Checklist:
- [ ] Add `POST /api/v1/files/intents` (consent + policy precheck).
- [ ] Add `POST /api/v1/files/commit` (anchors file commitment via signed envelope).
- [ ] Add storage policy enforcement (size caps, MIME allowlist, namespace controls).
- [ ] Persist immutable file manifest references with deterministic IDs.
- [ ] Add retry/idempotency key semantics for commit endpoint.

## Phase D — Governance + Policy Runtime

Deliverables:
- Namespace rule enforcement for encrypted file actions.
- Governance-controlled policy parameters.

Checklist:
- [ ] Add namespace policy rules for `ENCRYPTED_FILE_UPLOAD`, `ENCRYPTED_FILE_SHARE`, `ENCRYPTED_FILE_REVOKE`.
- [ ] Add governance-managed constraints (max file size, allowed encryption modes, required consent class).
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
- [ ] Add adversarial tests (tampered ciphertext, stale consent, unauthorized reader, replayed intent).
- [ ] Add performance tests for 10MB / 100MB / 1GB encrypted file paths.
- [ ] Complete cryptography review + key lifecycle review.
- [ ] Publish production readiness report.

## 5) Cross-Team Task Board (Execution Checklist)

### Protocol / Ledger
- [ ] Define canonical commitment derivation for file manifests.
- [ ] Add namespace action validation and revocation events.
- [ ] Add deterministic receipt fields for file commitments.

### Wallet / SDK
- [ ] Implement file encryption/decryption APIs.
- [ ] Implement reader ACL + DEK wrapping flows.
- [ ] Ship verification helper for off-chain object hash reconciliation.

### API / Node
- [ ] Implement file intent + commit endpoints.
- [ ] Add storage adapter interfaces and policy hooks.
- [ ] Add rate limits and abuse controls for file flows.

### Explorer / Indexer
- [ ] Index encrypted-file events and consent status transitions.
- [ ] Add high-signal privacy + revocation UI labels.

### Operations / Governance
- [ ] Add credential custody runbook for storage/KMS secrets.
- [ ] Add incident response playbook for encrypted-file compromise scenarios.
- [ ] Add governance proposal templates for file-policy changes.

## 6) Acceptance Criteria (Definition of Done)

This work is complete only when all of the following are true:

- [ ] A user can opt into encrypted file upload from wallet/SDK without plaintext leakage.
- [ ] A builder can verify file commitments deterministically from receipt + off-chain object hash.
- [ ] Reader ACL changes and revocations are reflected in on-chain events and enforced in retrieval paths.
- [ ] Explorer exposes auditable file metadata while revealing no sensitive plaintext.
- [ ] Security review signs off cryptography, key handling, and abuse controls.
- [ ] Runbooks exist for operator deployment, rotation, backup, and incident response.

## 7) Immediate Next Actions (this sprint)

- [ ] Approve this plan in governance/architecture review.
- [ ] Create implementation tickets for Phases A and B with owners + deadlines.
- [ ] Land schema + test vector PR first, before storage/API implementation.
- [ ] Schedule security design review focused on DEK wrapping and revocation semantics.
