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

- [x] Add a typed request envelope for inbound dApp calls:
  - [x] `requestId` (stable UUID)
  - [x] `origin` (full origin + tab URL)
  - [x] `method` (e.g., `ctzn_signCitizenTx`)
  - [x] `payload` (canonicalized JSON + hash)
  - [x] `createdAt` / `expiresAt`
  - [x] `riskFlags` (unknown origin, stale request, large payload, unsupported fields)
- [x] Add schema validation + canonical serialization before any UI render.
- [x] Ensure signature preimage is derived from canonical payload hash only.

### A2) Build a first-class approval screen in the extension

- [x] Add a **Pending Request** view (not only “Last dApp request” metadata).
- [x] Render human-readable payload sections with explicit field labels.
- [x] Add a raw payload/code view toggle for advanced users.
- [x] Show clear trust context:
  - [x] requesting origin
  - [x] method
  - [x] request timestamp
  - [x] payload hash/fingerprint
- [x] Add explicit actions:
  - [x] **Approve and sign**
  - [x] **Reject**
  - [x] **Cancel/close**
- [x] Require user interaction for every request (no background signing path).

### A3) Approval-state handling and security hardening

- [x] Introduce request lifecycle states (`pending`, `approved`, `rejected`, `expired`, `signed`).
- [x] Enforce one-time signing per `requestId`.
- [x] Add timeout/expiry handling and stale-request UX.
- [x] Add anti-clickjacking/anti-spoofing UI indicators (origin lock icon, full URL reveal).
- [x] Log immutable audit events for each state transition.

### A4) Extension messaging + dApp handshake updates

- [x] Update content-script/background/popup contracts for request queueing.
- [x] Return deterministic error codes to dApps (rejected, expired, malformed, unsupported).
- [x] Ensure idempotent reply handling when popup closes/reopens.
- [x] Add concurrency policy (single active request vs queue) and enforce it consistently.

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

## Cross-stack sync guardrails (wallet tech stack)

When implementing any wallet data-isolation task, keep these surfaces synchronized:

- [ ] wallet browser extension request/signing flow (`wallet/browser`)
- [ ] landing-page onboarding dApp submission flow (`landing-page/frontend`)
- [ ] wallet/backend verification + session/relay paths (`wallet/backend`)
- [ ] landing-page backend validation + network relay (`landing-page/backend`)
- [ ] builder SDK contracts (`sdk/nodejs`, `wallet/sdk/typescript-auth`)
- [ ] wallet CLI operational guidance (`wallet/cli`)

For every signed submission flow, explicitly document and enforce:

- [ ] **on-chain commitment fields** (payload hash, signer DID, verifying key, signature, signature scope, algorithm)
- [ ] **off-chain custody fields** (PII/business payload, storage location, retention policy, access policy)
- [ ] a deterministic mapping from off-chain payload → on-chain commitment hash.
