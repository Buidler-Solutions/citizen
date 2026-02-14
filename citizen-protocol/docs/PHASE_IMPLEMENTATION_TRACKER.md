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
- [x] Canonical API unification
- [x] Signed envelope and receipt standardization (initial foundation)
- [x] Explorer/indexer contract alignment

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
- [x] Align explorer backend/frontend contracts with canonical API and receipt model.
- [x] Remove/replace mock legacy explorer assumptions with canonical contract responses.
- [x] Add end-to-end integration tests for envelope submit -> receipt retrieval -> finality proof visibility.

### Last Update
- 2026-02-13: Reviewed Phase 1 foundation implementation; all scope and remaining checklist items are now complete with canonical API + deterministic receipt + explorer alignment coverage.
- 2026-02-13: Added legacy compatibility integration coverage for `POST /api/v1/entries/submit` to assert canonical receipt retrieval + finality proof visibility through `/api/v1/receipts/:receipt_id`.
- 2026-02-13: Aligned explorer backend/frontend to canonical node contracts (`/blocks/:height`, `/entries/:namespace`, `/api/v1/receipts/:receipt_id`) and removed mock fallback payloads.
- Commit: 5c7c746

---

## Phase 2 — Identity/Data Ownership
### Scope
- [x] DID registry operations
- [x] Resolver service and SDK verification primitives
- [x] Consent receipt namespace and policy checks

### Completed
- [x] Enforced DID subject ownership for identity writes via `author_matches_object_id` namespace rule.
- [x] Expanded consent namespace policy with explicit action allowlist (`CONSENT_GRANTED` / `CONSENT_REVOKED`) and subject-ownership checks.
- [x] Updated consent verification endpoint to evaluate latest on-chain consent status and reject revoked receipts.
- [x] Added regression coverage for identity subject mismatch and consent revocation evaluation.

### Last Update
- 2026-02-13: Continued Phase 2 hardening after review by adding DID subject ownership enforcement and consent revocation-aware policy checks + tests.
- 2026-02-13: Implemented identity/data-ownership baseline: DID action enforcement, API DID resolver, consent receipt policy validation/check endpoint, and wallet SDK verification primitives.
- 2026-02-13: Readiness review completed (`docs/PHASE2_READINESS_REVIEW.md`); all Phase 2 baseline criteria confirmed complete and Phase 3 is approved to start.
- Commit: 42504be

---

## Phase 3 — Builder Fee Credits
### Scope
- [x] Non-transferable fee credits and sponsorship
- [x] Builder registry policies and anti-abuse instrumentation

### Completed
- [x] Added `builder_credit_policy` namespace rule enforcing non-transferability (no transfer action/path), sponsorship ownership (`author == object_id`), and balance-aware sponsorship debits.
- [x] Added anti-abuse instrumentation guardrails in rule validation: unique `sponsorship_id` and configurable `max_daily_spend` cap.
- [x] Added API summary endpoint `GET /api/v1/builder-credits/:builder_id` to expose credited/sponsored/available totals plus sponsorship instrumentation for builders.
- [x] Added regression coverage for builder credit policy rule checks and API reporting path.

### Last Update
- 2026-02-13: Completed Phase 3 readiness review (`docs/PHASE3_READINESS_REVIEW.md`); Phase 3 scope validated as complete and Phase 4 is approved to start.
- 2026-02-13: Started and completed initial Phase 3 builder credit implementation (rule enforcement, anti-abuse instrumentation, and API summary surface) with test coverage.
- Commit: see git history

---

## Phase 4 — Asset Controls
### Scope
- [x] Governed asset module + trustline-like holding model
- [x] Controlled policy flags and disclosure UX

### Last Update
- 2026-02-13: Completed Phase 4 readiness review (`docs/PHASE4_READINESS_REVIEW.md`); Phase 4 scope validated as complete and Phase 5 is approved to start.
- 2026-02-13: Implemented governed asset controls in `asset.control` with trustline-enforced holdings, issuer/holder authorization checks, and policy-flag/disclosure validation + regression tests.
- 2026-02-13: Added builder-facing asset disclosure endpoint (`GET /api/v1/assets/:account_id`) exposing trustline status, held balances, policy flags, and disclosure mode summary.
- Commit: see git history

---

## Phase 5 — Scoped WASM + Interop
### Scope
- [x] Deterministic audited module runtime
- [x] Standards-based interoperability adapters

### Completed
- [x] Added `wasm_runtime_policy` namespace rule for `execution.module` to enforce governance-approved module classes, audit artifact requirements, deterministic gas bounds, and deterministic execution receipt commitments.
- [x] Added `interop_adapter_policy` namespace rule for `interop.adapter` to enforce governance-approved standards and explicit adapter/link/proof payload requirements.
- [x] Added builder-facing endpoints:
  - `GET /api/v1/modules/:module_id` for deterministic module runtime/audit status.
  - `GET /api/v1/interop/:object_id` for standards-based interop linkage/proof visibility.
- [x] Added regression coverage for scoped WASM policy enforcement and interop policy/endpoint behavior.

### Last Update
- 2026-02-13: Completed Phase 5 readiness review (`docs/PHASE5_READINESS_REVIEW.md`); Phase 5 scope validated as complete against baseline criteria.
- 2026-02-13: Implemented Phase 5 scoped WASM runtime and standards-led interop adapters with new governance-aware namespace rules, builder-facing status endpoints, and regression test coverage.
- Commit: see git history

---

## Post-Phase Operational Backlog
### Next Priority Tasks
- [ ] Confirm validator-node rollout readiness across target operators (keys, peer admission policy, telemetry, and runbooks).
- [ ] Add a dedicated watcher/observer node delivery track immediately after validator readiness sign-off:
  - explicit read-only runtime profile,
  - no consensus voting/proposer participation,
  - public query + verification endpoint deployment template,
  - operator runbook for builder/public watcher onboarding.
- [x] **Critical**: Make deterministic receipt retrieval durable across restarts by moving receipt storage from in-memory API state to persistent/indexed storage with replay/rebuild tooling.
  - Why now: `ApiServer` currently keeps receipts only in `Arc<RwLock<BTreeMap<Uuid, DeterministicReceipt>>>`, so a node restart can drop historical `GET /api/v1/receipts/:receipt_id` lookups.
  - 2026-02-14 update: receipt persistence was moved into the storage layer (`LedgerStorage::store_receipt` / `get_receipt`) with Memory and RocksDB implementations; API handlers now write/read receipts via ledger storage instead of in-memory API state.
- [ ] **Critical**: Establish production API edge controls before public rollout (authn/authz profile, rate limiting, and abuse controls for write endpoints).
  - Why now: submission routes are directly exposed in the router (`/api/v1/entries/submit`, `/api/v1/envelopes/submit`) without an operational gateway policy defined in runbooks.
- [ ] Add a disaster-recovery workstream for validator and observer operators:
  - scheduled RocksDB snapshot/restore drills,
  - signed backup retention policy,
  - quorum-safe regional restore runbook and RTO/RPO targets.
- [ ] Add a mandatory simulation-release gate for Section 19 coverage (50/75/100 validators and all adversarial scenarios) with artifact publication per release.
  - Why now: the simulation runner currently defaults to a single `50-validator + Normal` config in `crates/simulation/src/bin/run.rs`, so release readiness is not yet tied to the full stress matrix.
- [ ] Document and validate opt-in clawback flag behavior for builder-created assets (`asset.control`):
  - publish a normative behavior matrix (enabled vs disabled clawback flags, authorization rules, and expected holder-facing outcomes),
  - add regression coverage for flag-driven hold/release/revocation paths,
  - expose clear wallet/explorer disclosure text so holders can understand clawback risk before opting into a trustline.
