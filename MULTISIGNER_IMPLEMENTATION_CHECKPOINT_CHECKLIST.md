# Implementation Checkpoint Checklist: Option B (Runtime-Native Multi-Signer Envelopes)

This checklist captures the implementation checkpoints for upgrading Citizen from a single-signer envelope model to true protocol-level multi-signer envelope support, while preserving backward compatibility.

## 0) Baseline Reality Check (Current)

- [ ] Confirm `SignedEnvelope<T>` currently contains only single `signer` and single `signature` fields.
- [ ] Confirm API currently enforces `envelope.signer == payload.author` and envelope/payload signature match semantics.
- [ ] Confirm ledger submission signature verification currently validates one canonical entry signature.
- [ ] Confirm client surfaces (wallet CLI, SDK, browser extension) currently emit and submit single-signer envelopes.

---

## 1) Protocol Types: Backward-Compatible Extension

- [x] Extend envelope schema with optional multisig fields (do **not** remove existing `signer` + `signature`):
  - [x] `signature_scope` (e.g., `canonical_payload_v1`)
  - [x] `co_signatures: Vec<EnvelopeCoSignature>` (default empty)
  - [x] `multisig_policy: Option<EnvelopeMultisigPolicy>`
- [x] Keep serde defaults so legacy envelopes deserialize unchanged.
- [x] Add unit tests for:
  - [x] legacy envelope decode/encode parity
  - [x] multisig envelope decode/encode parity

---

## 2) API Validation Path Upgrades

### 2.1 `/api/v1/envelopes/submit`

- [ ] Preserve legacy validation branch when `co_signatures` is empty.
- [ ] Add multisig validation branch when `co_signatures` is present:
  - [ ] Verify canonical preimage consistency.
  - [ ] Verify each co-signature against declared signer key material.
  - [ ] Enforce signer uniqueness.
  - [ ] Enforce threshold from `multisig_policy`.
  - [ ] Enforce author participation requirement (unless policy explicitly allows otherwise).

### 2.2 `/api/v1/envelopes/submit-batch`

- [ ] Mirror the same legacy + multisig branching logic used in single submit.
- [ ] Ensure deterministic per-envelope error semantics for failed items.

### 2.3 API Tests

- [ ] Add tests for legacy acceptance (no regression).
- [ ] Add tests for valid multisig acceptance.
- [ ] Add tests for threshold failures.
- [ ] Add tests for unauthorized signer failures.
- [ ] Add tests for duplicate signer failures.
- [ ] Add tests for signature scope mismatch failures.

---

## 3) Ledger Rule: Targeted Namespace/Action Enforcement

- [ ] Add a new namespace rule (recommended name: `envelope_multisig_policy`).
- [ ] Rule inputs should support:
  - [ ] `allowed_signers`
  - [ ] `threshold`
  - [ ] `required_roles` (optional)
  - [ ] `signature_scope`
- [ ] Enforce policy only where configured (targeted namespaces/actions).
- [ ] Keep single-signer namespaces unaffected unless governance enables multisig.
- [ ] Add ledger tests for:
  - [ ] policy pass
  - [ ] policy threshold fail
  - [ ] signer allowlist fail
  - [ ] role mismatch fail (if role-based mode enabled)

---

## 4) SDK + Wallet CLI + Browser Extension Changes

### 4.1 Node SDK

- [ ] Keep existing `wrapEnvelope` behavior for legacy compatibility.
- [ ] Add multisig helpers:
  - [ ] `wrapEnvelopeMulti(...)`
  - [ ] `appendCoSignature(...)`
  - [ ] `finalizeEnvelope(...)`
- [ ] Extend TypeScript types with optional multisig envelope fields.
- [ ] Add tests for canonical payload determinism and multi-signature aggregation.

### 4.2 Wallet CLI

- [ ] Add compose/sign/finalize commands:
  - [ ] `compose-envelope-init`
  - [ ] `compose-envelope-sign --as <did>`
  - [ ] `compose-envelope-finalize`
  - [ ] `submit-envelope`
- [ ] Preserve current single-signer submit behavior.

### 4.3 Browser Extension (Compose tab)

- [ ] Add draft import/export flow for handoff (Alice → Bob).
- [ ] Ensure immutable canonical preimage once draft is created.
- [ ] Add signer collection UI and threshold progress indicator.
- [ ] Block submission until threshold satisfied.
- [ ] Keep current single-sign flow available.

---

## 5) Compose Multisigner Draft Artifact (Compatibility-Friendly)

- [ ] Standardize draft schema: `citizen.compose.multisig-draft.v1`.
- [ ] Include immutable canonical payload/hash and signer policy metadata.
- [ ] Include collected signatures as an append-only list.
- [ ] Include `runtime_compat.envelope_v1` snapshot for legacy tooling during migration.
- [ ] Validate draft integrity before accepting imported signatures.

---

## 6) Rollout Strategy

- [ ] Phase 1: Add optional fields + API dual-path support.
- [ ] Phase 2: Introduce ledger policy rule and gate by namespace config.
- [ ] Phase 3: Ship SDK/CLI/extension multisig compose UX.
- [ ] Phase 4: Enable multisig policies on selected namespaces/actions.
- [ ] Phase 5: Monitor and deprecate non-required legacy paths only when safe.

---

## 7) Security & Determinism Guardrails

- [ ] Canonical preimage must be byte-stable across signers.
- [ ] Reject mutated drafts after first signature.
- [ ] Enforce signature scope and anti-replay binding (request ID/timestamps where applicable).
- [ ] Enforce signer uniqueness in threshold count.
- [ ] Record auditable signer metadata in receipts/logs.

---

## 8) Definition of Done

- [ ] Legacy single-signer envelopes still submit successfully.
- [ ] Multisig envelopes pass end-to-end (compose → collect signatures → submit → receipt).
- [ ] Namespace policy can require multisig and reject insufficient signatures.
- [ ] SDK/CLI/Browser extension all support multisig compose flow.
- [ ] Documentation updated for operators/builders with migration guidance.
