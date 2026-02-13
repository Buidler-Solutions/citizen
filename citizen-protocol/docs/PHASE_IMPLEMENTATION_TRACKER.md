# Citizen Implementation Phase Tracker

This file is the handoff source of truth for implementation progress.

## Update Rule (for every agent)
After each phase-related delivery:
1. Update the relevant phase section below.
2. Mark completed items with `[x]` and remaining items with `[ ]`.
3. Add a short note in **Last Update** and include the commit hash.

---

## Phase 1 — Foundation
Baseline reference: `docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md` (Phase 1 section).

### Scope
- [ ] Canonical API unification
- [x] Signed envelope and receipt standardization (initial foundation)
- [ ] Explorer/indexer contract alignment

### Completed
- [x] Added protocol types for canonical envelope/receipt contract:
  - `SignedEnvelope<T>`
  - `DeterministicReceipt`
  - `ValidationSummary`
  - `FinalityProof`
  - `ReceiptStatus`
- [x] Added API endpoints:
  - `POST /api/v1/envelopes/submit`
  - `GET /api/v1/receipts/:receipt_id`
- [x] Kept legacy compatibility:
  - `POST /api/v1/entries/submit` now routes through envelope flow.

### Remaining for Phase 1 completion
- [x] Populate deterministic receipt finality payload (`block_height`, `block_hash`, `commit_proof`) when entries are finalized.
- [ ] Align explorer backend/frontend contracts with canonical API and receipt model.
- [ ] Remove/replace mock legacy explorer assumptions with canonical contract responses.
- [x] Add end-to-end integration tests for envelope submit -> receipt retrieval -> finality proof visibility.

### Last Update
- 2026-02-13: Added deterministic finality payload wiring for canonical receipts and API integration coverage for submit->receipt->finality flow.
- Commit: this commit.

---

## Phase 2 — Identity/Data Ownership
### Scope
- [ ] DID registry operations
- [ ] Resolver service and SDK verification primitives
- [ ] Consent receipt namespace and policy checks

### Last Update
- 2026-02-13: Not started.

---

## Phase 3 — Builder Fee Credits
### Scope
- [ ] Non-transferable fee credits and sponsorship
- [ ] Builder registry policies and anti-abuse instrumentation

### Last Update
- 2026-02-13: Not started.

---

## Phase 4 — Asset Controls
### Scope
- [ ] Governed asset module + trustline-like holding model
- [ ] Controlled policy flags and disclosure UX

### Last Update
- 2026-02-13: Not started.

---

## Phase 5 — Scoped WASM + Interop
### Scope
- [ ] Deterministic audited module runtime
- [ ] Standards-based interoperability adapters

### Last Update
- 2026-02-13: Not started.
