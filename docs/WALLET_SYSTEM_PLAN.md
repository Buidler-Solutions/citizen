# Wallet System Plan (Implementation-Synchronized)

This document was originally a forward-looking plan. It has been updated to reflect the implemented wallet architecture in this repository while preserving the long-term direction.

Date synced: 2026-02-23

---

## 1) Scope & Positioning

Citizen wallet surfaces are governance-first, namespace-first tools for secure signing, submission, and verification workflows.

Primary delivered surfaces:

- Rust wallet core: `crates/wallet`
- CLI wallet app: `wallet/cli`
- React wallet console: `wallet/react`
- Browser signer extension: `wallet/browser`

Primary goals:

- secure key custody and deterministic signing,
- namespace-aware entry authoring/submission,
- deterministic receipt verification and audit export,
- policy-gated flows for high-impact governance/builder operations.

Explicit non-goals:

- speculative trading UX,
- exchange integrations,
- anonymous/unanchored validator activity.

---

## 2) Implemented Functional Capabilities

### 2.1 Key Management

Implemented now:

- key generation/import/export/listing in CLI,
- encrypted keystore support,
- reusable wallet-core key primitives,
- provider abstraction hooks for software/hardware-backed strategies.

### 2.2 Namespace Authoring + Signing

Implemented now:

- generic `sign-entry` path,
- helper commands for identity/governance/registry/audit entry families,
- browser/web UX pathways that produce signed payloads for backend/runtime submission.

### 2.3 Submission + Receipts

Implemented now:

- CLI submission to canonical envelope endpoint,
- local receipt persistence/listing,
- receipt verification tooling,
- runtime-aligned deterministic receipt flows.

### 2.4 Governance + Policy Controls

Implemented now:

- governance vote signing helpers,
- approval-threshold policy checks for high-impact actions,
- multisig builder-credit proof workflow support.

### 2.5 Privacy ACL + DEK Controls

Implemented now:

- hybrid privacy mode using per-entry DEKs and per-reader wrapped key material,
- field-level reader ACL maps (`field_reader_acls`) for selective disclosure,
- deterministic per-payload commitments preserved in signing payloads and consent receipts,
- verification/decryption helpers that require caller-specific DEK wrap ownership.

### 2.6 Privacy option model (explicit)

Implemented now (four practical choices):

- `none` (default): clear-text payload, no encrypt-then-commit.
- `passphrase`: opt-in full-payload encrypt-then-commit.
- `hybrid_full_payload`: opt-in ACL + DEK full-payload encrypt-then-commit.
- `hybrid_selective_fields`: opt-in ACL + DEK selective-field encrypt-then-commit (`field_reader_acls`).

Implementation note: the last two choices map to `privacy_mode = hybrid` and are distinguished by selective-field ACL metadata.

---

## 3) Current Architecture (As Built)

### 3.1 Shared wallet core (`crates/wallet`)

- cryptographic operations + canonical signing helpers,
- policy primitives,
- encrypted key material handling,
- reusable API consumed by CLI and other app surfaces.

### 3.2 CLI wallet (`wallet/cli`)

- operational interface for key lifecycle, signing, submission, and verification,
- suitable for operator automation and runbook-driven validation.

### 3.3 React wallet (`wallet/react`)

- broader user-facing console for onboarding, namespace operations, receipts, governance experience.

### 3.4 Browser wallet (`wallet/browser`)

- popup-focused signer surface for explicit transaction/event review and sign/reject actions.

---

## 4) Integration Contract

Wallet tooling is aligned with canonical runtime APIs:

- `POST /api/v1/envelopes/submit`
- `GET /api/v1/receipts/:receipt_id`
- governance/namespace read surfaces as exposed by the node API

Reference docs:

- `docs/PHASE_IMPLEMENTATION_TRACKER.md`
- `docs/DEVELOPER_EXPERIENCE_BLUEPRINT.md`
- `docs/STACK_TESTING_GUIDE.md`

---

## 5) Post-Implementation Backlog

1. Continue API-contract parity checks as runtime evolves.
2. Keep wallet UI disclosures synchronized with governed policy changes.
3. Expand hardware-backed key-provider integrations beyond mock adapters where required by operator policy.
4. Maintain cross-surface parity tests across CLI, React wallet, browser extension, and explorer visibility.

---

## 6) Operational References

- Wallet implementation tracker: `docs/WALLET_IMPLEMENTATION_TASKS.md`
- Evidence review: `docs/WALLET_TASK_STATUS_REVIEW.md`
- Readiness review: `docs/WALLET_READINESS_REVIEW.md`
- Security review: `docs/WALLET_SECURITY_REVIEW.md`
- Multisig runbook: `docs/MULTISIG_3_OF_5_IMPLEMENTATION_HOWTO.md`
- CLI usage: `wallet/cli/README.md`
- Browser extension usage: `wallet/browser/README.md`
