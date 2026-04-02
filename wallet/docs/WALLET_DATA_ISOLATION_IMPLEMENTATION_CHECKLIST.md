# Wallet Tech Stack Implementation Checklist for User Data Isolation

This checklist translates the current flow and known gaps into concrete implementation tasks.

## Current baseline (validated behavior)

- [x] Onboarding form constructs and passes a payload into `ctzn_signCitizenTx` before backend submit.
- [x] Form flow is already split into two explicit states in UI:
  - [x] **Unsigned** → show `Sign submission` action.
  - [x] **Signed** → show `Submit signed form` action.
- [x] Backend submit call is gated on signed state in the form flow.

## Gap A: Dedicated payload approval for dApp requests is missing

### A1) Define an explicit dApp signing request model

- [ ] Add a typed request envelope for inbound dApp calls:
  - [ ] `requestId` (stable UUID)
  - [ ] `origin` (full origin + tab URL)
  - [ ] `method` (e.g., `ctzn_signCitizenTx`)
  - [ ] `payload` (canonicalized JSON + hash)
  - [ ] `createdAt` / `expiresAt`
  - [ ] `riskFlags` (unknown origin, stale request, large payload, unsupported fields)
- [ ] Add schema validation + canonical serialization before any UI render.
- [ ] Ensure signature preimage is derived from canonical payload hash only.

### A2) Build a first-class approval screen in the extension

- [ ] Add a **Pending Request** view (not only “Last dApp request” metadata).
- [ ] Render human-readable payload sections with explicit field labels.
- [ ] Add a raw payload/code view toggle for advanced users.
- [ ] Show clear trust context:
  - [ ] requesting origin
  - [ ] method
  - [ ] request timestamp
  - [ ] payload hash/fingerprint
- [ ] Add explicit actions:
  - [ ] **Approve and sign**
  - [ ] **Reject**
  - [ ] **Cancel/close**
- [ ] Require user interaction for every request (no background signing path).

### A3) Approval-state handling and security hardening

- [ ] Introduce request lifecycle states (`pending`, `approved`, `rejected`, `expired`, `signed`).
- [ ] Enforce one-time signing per `requestId`.
- [ ] Add timeout/expiry handling and stale-request UX.
- [ ] Add anti-clickjacking/anti-spoofing UI indicators (origin lock icon, full URL reveal).
- [ ] Log immutable audit events for each state transition.

### A4) Extension messaging + dApp handshake updates

- [ ] Update content-script/background/popup contracts for request queueing.
- [ ] Return deterministic error codes to dApps (rejected, expired, malformed, unsupported).
- [ ] Ensure idempotent reply handling when popup closes/reopens.
- [ ] Add concurrency policy (single active request vs queue) and enforce it consistently.

## Gap B: Wallet does not directly submit to Citizen runtime + builder backend

### B1) Choose target submission architecture

- [ ] Decide and document one of two supported models:
  - [ ] **Model 1 (current + hardened):** dApp frontend submits signed payload to backend; backend relays to network conditionally.
  - [ ] **Model 2 (wallet-mediated):** wallet extension submits signed payload directly to configured Citizen runtime and/or builder endpoint.
- [ ] Document trust boundaries, custody boundaries, and failure domains for chosen model.

### B2) If staying on Model 1, harden backend relay path

- [ ] Make relay behavior explicit in API contract and UI copy.
- [ ] Add signed metadata verification before relay.
- [ ] Validate/normalize `CITIZEN_SIGNED_SUBMISSION_RELAY_URL` and fail closed when invalid.
- [ ] Add relay observability:
  - [ ] request trace ID
  - [ ] signed payload hash
  - [ ] upstream status code / latency
- [ ] Add retry policy + deduplication key strategy.

### B3) If adopting Model 2, implement wallet-side submit pipeline

- [ ] Add wallet network client with allowlisted endpoints.
- [ ] Add user-visible confirmation for destination endpoint per submit.
- [ ] Support signed submission receipt retrieval and local persistence.
- [ ] Add safe fallback when runtime endpoint is unavailable.
- [ ] Maintain privacy defaults (only signed metadata leaves extension unless user consents).

## User data isolation controls (required regardless of model)

### C1) Data minimization and storage isolation

- [ ] Keep raw form PII out of extension long-term storage by default.
- [ ] Store only minimal signed artifacts required for receipt/audit.
- [ ] Encrypt sensitive local state at rest (where platform APIs allow).
- [ ] Add deterministic retention windows and secure deletion job.

### C2) Cryptographic and policy guarantees

- [ ] Bind signature to:
  - [ ] origin
  - [ ] method
  - [ ] canonical payload hash
  - [ ] nonce/requestId
  - [ ] timestamp/expiry
- [ ] Prevent replay across origins/environments.
- [ ] Add namespace/policy checks prior to signature prompt where feasible.

### C3) UX controls for isolation assurance

- [ ] Add a “What will be shared” summary before approval.
- [ ] Add per-origin permission controls and revocation.
- [ ] Add explicit consent text for network relay/direct submit behaviors.

## Testing and rollout checklist

### D1) Automated tests

- [ ] Unit tests: canonicalization, hashing, lifecycle transitions, expiry logic.
- [ ] Integration tests: dApp → extension → signed response happy path.
- [ ] Integration tests: reject/timeout/cancel/error-code paths.
- [ ] Regression tests: ensure backend submit is impossible without signed state.
- [ ] Security tests: replay attempts, malformed payloads, concurrent request races.

### D2) Manual QA scenarios

- [ ] Unknown origin request.
- [ ] Payload mismatch between preview and signed bytes.
- [ ] Popup close/reopen mid-request.
- [ ] Network outage during submission/relay.
- [ ] Duplicate submit attempt with same signature.

### D3) Release controls

- [ ] Feature flag dedicated approval UI.
- [ ] Ship behind staged rollout (internal → beta → general).
- [ ] Monitor key metrics:
  - [ ] approval rate
  - [ ] rejection rate
  - [ ] timeout rate
  - [ ] relay/direct submit failure rate
- [ ] Prepare rollback runbook.

## Suggested implementation order

1. [ ] A1 request model + schema/canonicalization.
2. [ ] A2 approval UI + approve/reject actions.
3. [ ] A3 lifecycle security controls.
4. [ ] A4 handshake/error-code updates.
5. [ ] B1 architecture decision record.
6. [ ] B2 or B3 implementation (based on B1).
7. [ ] C1–C3 isolation controls.
8. [ ] D1–D3 testing, staged rollout, and monitoring.
