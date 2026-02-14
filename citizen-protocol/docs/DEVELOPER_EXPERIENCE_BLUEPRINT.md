# Citizen Developer Experience Blueprint

This guide consolidates how to run Citizen in a way that can be **seen in action** end-to-end:

- validator node setup,
- builder dApp development flow,
- signer-keeper browser extension usage,
- explorer-based verification,
- and a proposed Citizen Laboratory surface (similar to Stellar Laboratory).

It is intended for builders, integrators, and demo operators.

---

## 1) Validator Setup (Blockchain Node)

Citizen validator setup starts from the local three-node network runbook.

### 1.1 Quick local validator bring-up

```bash
cd citizen-protocol
scripts/run_localnet.sh
```

Default local interfaces:

- QUIC peers: `127.0.0.1:9100-9102`
- API endpoints: `http://127.0.0.1:8081`, `http://127.0.0.1:8082`, `http://127.0.0.1:8083`

Quick API check:

```bash
curl http://127.0.0.1:8081/health
```

### 1.2 Validator production hand-off checklist

Before real deployment:

1. Replace local signing keys with institutional/HSM-managed keys.
2. Update validator allowlists (`[[validators]]`) with approved validator identities + verifying keys.
3. Bind routable network interfaces and distinct API ports.
4. Tune quorum + timing settings for real latency profile.
5. Keep namespace governance metadata (`rules_hash`, `governed_by`) aligned with governance-approved policy versions.

Use `docs/LOCALNET_RUNBOOK.md` as the canonical validator operations reference.

---

## 2) Builder Flow: How to Build a Citizen dApp

Citizen dApps should follow the governed flow:

1. **Frontend** asks signer keeper for account and signature.
2. **Signer keeper (browser extension)** returns user-approved signature.
3. **Backend/API** verifies signature and creates canonical ledger payload.
4. **Backend/API** submits to configured Citizen node endpoint.
5. **Explorer** and API queries verify chain inclusion and deterministic receipts.

### 2.1 Start the dApp stack

```bash
cd citizen-protocol/dapp
npm install
npm run dev:api
npm run dev:web
```

Default surfaces:

- Web app: `http://localhost:3000`
- dApp API: `http://localhost:4000`

### 2.2 Configure network targets for submission

Set API environment values:

- `CITIZEN_TESTNET_SUBMIT_URL`
- `CITIZEN_FUTURENET_SUBMIT_URL`
- `CITIZEN_MAINNET_SUBMIT_URL`

For local validator trio, use:

- `testnet` → `http://127.0.0.1:8081/api/v1/envelopes/submit`
- `futurenet` → `http://127.0.0.1:8082/api/v1/envelopes/submit`
- `mainnet` → `http://127.0.0.1:8083/api/v1/envelopes/submit`

---

## 3) Signer Keeper: Browser Extension Usage for dApp Users

Citizen signer keeper is the `wallet/browser` extension project.

### 3.1 Build and load extension

```bash
cd citizen-protocol/wallet/browser
npm install
npm run build -- --watch
```

Then in Chromium browser:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `citizen-protocol/wallet/browser/dist`
5. Pin extension and open popup

### 3.2 User signing experience (current model)

- User opens dApp and initiates action.
- dApp requests account + signature from injected provider.
- User reviews signing request in extension popup.
- User confirms or rejects.
- Signature returns to dApp for backend verification and submission.

> Important: signer keeper currently signs user requests and does not submit directly to validator nodes. Submission is performed by dApp backend/API.

---

## 4) Blockchain Explorer Verification Flow

Run the explorer stack:

### 4.1 Explorer backend

```bash
cd citizen-protocol/explorer/backend
npm install
PORT=4010 CITIZEN_NODE_URL=http://127.0.0.1:8081 npm run start:dev
```

### 4.2 Explorer frontend

```bash
cd citizen-protocol/explorer/frontend
npm install
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4010 npm run dev -- --port 4020
```

### 4.3 What to verify as a user

1. API health and block visibility:
   - `GET http://127.0.0.1:4010/status`
   - `GET http://127.0.0.1:4010/blocks`
2. Explorer UI at `http://127.0.0.1:4020`:
   - latest block visibility,
   - namespace entries,
   - deterministic receipt/finality proof visibility (when receipt ID supplied).

---

## 5) Citizen Laboratory (Stellar-Laboratory-like Surface)

Citizen should include a dedicated **Laboratory web app** to exercise protocol operations without writing custom code for every test.

### 5.1 Purpose

- Developer onboarding in minutes.
- Canonical operation playground for governance-first namespaces.
- QA/repro harness for demos and integration debugging.

### 5.2 Proposed capabilities

1. **Network selector** (localnet / testnet / futurenet / mainnet).
2. **Identity tools**: DID registration/revocation payload builder.
3. **Consent tools**: consent receipt creation + policy check request builder.
4. **Namespace operation builder**: governed template forms per namespace.
5. **Envelope/entry signing assistant** with signer keeper integration.
6. **Submit + receipt panel** for deterministic receipt tracking.
7. **Read/query console** for blocks, entries, identities, receipts.
8. **Governance operations console** (proposal submission, voting payloads, status).
9. **Interop utilities** for standards-based identifier link/proof flows.
10. **Export/import fixtures** for reproducible QA scenarios.

### 5.3 Suggested implementation shape

- New app path: `laboratory/`
- Frontend: Next.js or React (matching current repo patterns)
- Optional lightweight backend for templates/indexing
- Reuse canonical node APIs and explorer contracts rather than parallel protocol logic

---

## 6) Applications Needed to Show Citizen “In Action”

The complete visible product surface should include the following applications:

1. **Validator Node Runtime** (existing)
   - Rust node + API + consensus networking.
2. **Observer/Read API Node Profile** (existing runtime mode)
   - read-only verification endpoint deployment profile.
3. **Builder dApp Starter** (existing base, should be expanded)
   - reusable full-stack template for namespace-first app development.
4. **Signer Keeper Browser Extension** (existing)
   - user signing and account authority surface.
5. **Blockchain Explorer** (existing)
   - block/entry/receipt visibility and finality inspection.
6. **Citizen Laboratory** (new)
   - operation playground for no-code/low-code protocol exercises.
7. **SDK + Client Libraries** (partially existing)
   - typed helpers for entry/envelope construction, signing, receipt verification.
8. **Operator Console** (recommended)
   - validator health, key rotation scheduling, governance alerts.
9. **Governance Portal** (recommended)
   - proposal lifecycle UX, voting transparency, evidence browsing.
10. **Simulation & Scenario Dashboard** (recommended)
   - 50–100 validator stress outputs, p50/p95 finality and fault-case replay.

These ten surfaces together provide an end-to-end ecosystem where builders, users, validators, and governance participants can all interact with Citizen using dedicated tools.

---

## 7) Recommended Immediate Execution Plan

1. Continue using `docs/STACK_TESTING_GUIDE.md` for local end-to-end workflow.
2. Confirm validator-node production readiness first (keys, admission policy, routable endpoints, telemetry).
3. Observer-node delivery is complete and should now be treated as a standard deployment profile:
   - use `node_role = "observer"` for read-only runtime behavior,
   - no voting/proposer rights,
   - public query + verification endpoints enabled for builder/public consumers,
   - follow `docs/OBSERVER_NODE_RUNBOOK.md` and `config/observer/observer-public.toml` for onboarding.
4. Promote this blueprint as the cross-team implementation checklist.
5. Create `laboratory/` MVP with:
   - network selector,
   - submit/query console,
   - signer keeper integration,
   - deterministic receipt verification view.
6. Expand dApp starter templates for namespace-specific modules (`identity.citizen`, `consent.receipt`, `governance.vote`).

---

## 8) Synchronization Blueprint (How Everything Works Together)

To make Citizen visibly work "in action," run the stack as an integrated loop rather than isolated apps.

### 8.1 Core synchronized demo loop

1. **Citizen node cluster (validators + optional observer)** finalizes blocks and exposes canonical APIs.
2. **Builder dApp** creates governed payloads and requests signatures.
3. **Signer keeper browser wallet** signs (user authority) and returns signed envelopes.
4. **dApp backend** verifies signatures, applies builder policy, and submits envelopes to node APIs.
5. **Explorer backend/frontend** indexes and displays finalized blocks/entries/receipts.
6. **Citizen Laboratory** drives the same APIs for no-code/low-code operation testing.

If all six are online and pointed at the same network profile, you can demonstrate end-to-end deterministic flow in minutes.

### 8.2 Minimum "show it works" application set

- Validator node runtime
- Observer node (recommended for public read traffic)
- Browser signer keeper wallet
- Demo dApp (web + API)
- Explorer (backend + frontend)
- Citizen Laboratory (or temporary operations console while Laboratory is in progress)

### 8.3 Additional toolset often forgotten (but important)

For a production-grade builder + user ecosystem, include these supporting surfaces:

1. **Indexer/event pipeline** for fast query materialization and analytics workloads.
2. **Notification service** (webhooks/queues) for receipt/finality events and governance status changes.
3. **Identity + key recovery UX** for user safety without sacrificing custody principles.
4. **Policy engine service** for namespace/business-rule checks and auditable decisioning.
5. **Observability stack** (metrics, traces, structured logs, alerting, SLO dashboards).
6. **Secrets/HSM key management integration** for validator and operator signing keys.
7. **Governance evidence archive** for dispute resolution and historical vote/proposal audit.
8. **Simulation dashboard** wired to `crates/simulation` outputs for liveness/safety regression gates.
9. **SDK conformance test harness** to keep dApp/wallet/explorer integrations deterministic across releases.
10. **Environment manager** (localnet/testnet/futurenet/mainnet profile switcher) shared by dApp, explorer, and Laboratory.

### 8.4 "GOTO" Builder Platform positioning for Citizen Laboratory

Citizen Laboratory should be positioned as the builder-first entry point:

- **Single URL for onboarding**: connect wallet, pick network, build/submit/query without scaffolding.
- **Canonical templates**: namespace forms and governance operation builders tied to protocol policy versions.
- **Deterministic verification UX**: every submit returns receipt + explorer deep link + raw proof material.
- **Team collaboration mode**: saved payload drafts, fixture export/import, and reproducible scenario runs.
- **Production migration lane**: "Generate SDK snippet" and "Export backend payload" actions for app teams.
