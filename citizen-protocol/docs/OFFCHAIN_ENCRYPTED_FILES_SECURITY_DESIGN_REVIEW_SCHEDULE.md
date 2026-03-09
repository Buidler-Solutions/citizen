# Off-Chain Encrypted Files Security Design Review Schedule

Status: Scheduled (Gate 1 -> Gate 2 prerequisite)

Owner: Security + Protocol + Wallet + API

Related plan: `docs/OFFCHAIN_ENCRYPTED_FILES_IMPLEMENTATION_PLAN.md`

## 1) Review Objective

Run a focused security design review for DEK wrapping, revocation enforcement, and replay resistance before enabling broader Gate 2 API/storage rollout.

## 2) Proposed Session

- **Window:** 2026-03-12 15:00–16:30 UTC
- **Fallback window:** 2026-03-13 16:00–17:30 UTC
- **Format:** Architecture review + adversarial walk-through + sign-off vote
- **Facilitator:** Security lead

## 3) Required Participants

- Security reviewer (chair)
- Protocol maintainer
- Wallet/SDK maintainer
- API/Node maintainer
- Operations representative (for incident/runbook impacts)
- Governance representative (for release-gate sign-off)

## 4) Scope (Must Be Covered)

1. **DEK wrapping model**
   - Per-wallet wrap generation and storage.
   - Grant-only decrypt enforcement and fail-closed behavior.
   - Rotation and re-wrap behavior for membership changes.

2. **Revocation lifecycle**
   - Consent expiry/revocation checks in read paths.
   - Event propagation and eventual consistency boundaries.
   - Reconciliation behavior for stale grants and stale manifests.

3. **Replay resistance**
   - Intent/commit idempotency semantics.
   - Nonce and timestamp assumptions in signed envelope handling.
   - Adversarial request replay and partial-commit replay failure paths.

4. **Abuse controls and observability**
   - Rate limiting and auth scope coverage for file endpoints.
   - Alerting for ciphertext mismatch and revoked-reader attempts.
   - Audit evidence requirements and retention windows.

## 5) Pre-Read Checklist

All attendees should review these artifacts before the session:

- `docs/OFFCHAIN_ENCRYPTED_FILES_IMPLEMENTATION_PLAN.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_CRYPTO_KEY_LIFECYCLE_REVIEW.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_INCIDENT_RESPONSE_PLAYBOOK.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_CREDENTIAL_CUSTODY_RUNBOOK.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_PRODUCTION_READINESS_REPORT.md`

## 6) Meeting Agenda (90 min)

1. 10 min — Threat model recap and current implementation status.
2. 25 min — DEK wrapping and decrypt authorization flow deep dive.
3. 20 min — Revocation/read-path and replay-path adversarial scenarios.
4. 15 min — Operations controls, alerting, and incident handoffs.
5. 10 min — Open risks and owner assignments.
6. 10 min — Gate recommendation and sign-off decision.

## 7) Exit Criteria

The review is considered complete only when all are true:

- Security chair records one of: **Approved**, **Approved with conditions**, or **Rejected**.
- Any conditions are ticketed with owners and due dates.
- Gate 2 blockers are explicitly listed and linked to work items.
- Final decision and evidence links are recorded in the implementation plan and phase tracker.

## 8) Deliverables After Session

- Signed review minutes in `docs/` with attendee list.
- Updated risk register entries for accepted residual risks.
- Updated implementation-plan checklist status and gating note.
- Governance-facing summary suitable for release decision discussion.
