# Wallet Tech Stack Exercise: Citizen Node Runtime Implementation Checklist

This checklist is implementation-driven and intended for exercising the **real `citizen-node` runtime** with the wallet stack (CLI wallet + browser wallet + landing-page onboarding app + explorer + demo blog), not a mock chain.

Use this as an operator worksheet: mark each item complete before moving to the next phase.

## Implementation status (continued)

The checklist now has three executable helpers:

- `citizen-protocol/scripts/wallet_runtime_node_preflight.sh`
- `citizen-protocol/scripts/run_wallet_cli_e2e.sh`
- `citizen-protocol/scripts/stack_runtime_smoke_test.sh`

Use the preflight helper to automate environment + localnet config readiness gates (sections 1 and 2), the wallet CLI helper to automate the baseline signed-submit flow (section 4), then use the stack smoke helper after the full multi-surface stack is running (section 6).

Quick start:

```bash
cd citizen-protocol
scripts/wallet_runtime_node_preflight.sh
# run this after localnet is up
scripts/run_wallet_cli_e2e.sh
```

---

## 0) What this checklist validates

- The Rust node runtime boots with admission preflight and namespace bootstrap.
- A local validator set is reachable on QUIC + HTTP APIs.
- Wallet flows submit signed envelopes to the runtime API.
- Landing-page onboarding app, demo blog, and explorer surfaces read/write against runtime-backed endpoints.
- Runtime/data/log artifacts are captured for debugging and repeatability.

---

## 1) Environment + dependency gate

- [ ] Run automated preflight gate:
  - [ ] `cd citizen-protocol && scripts/wallet_runtime_node_preflight.sh`
- [ ] Confirm toolchain availability:
  - [ ] `cargo --version`
  - [ ] `node --version`
  - [ ] `npm --version`
  - [ ] `pnpm --version`
  - [ ] `curl --version`
  - [ ] `python3 --version`
- [ ] From `citizen-protocol/`, install JS dependencies used by wallet/landing-page onboarding/explorer/demo:
  - [ ] `pnpm --dir ../landing-page install`
  - [ ] `npm --prefix ../demo install`
  - [ ] `npm --prefix ../wallet/browser install`
  - [ ] `npm --prefix ../explorer/backend install`
  - [ ] `npm --prefix ../explorer/frontend install`
- [ ] Confirm localnet launcher prerequisites are satisfied (`cargo` in `PATH`).

---

## 2) Node runtime config readiness gate

- [ ] (Recommended) Use automated checks first from section 1 preflight script output.
- [ ] Validate that localnet validator configs exist:
  - [ ] `config/localnet/validator-alpha.toml`
  - [ ] `config/localnet/validator-beta.toml`
  - [ ] `config/localnet/validator-gamma.toml`
- [ ] Verify API ports and peer ports are unique and consistent:
  - [ ] HTTP APIs: `8081`, `8082`, `8083`
  - [ ] QUIC peers: `9100`, `9101`, `9102`
- [ ] Verify `content.article` namespace is present in localnet config (required by demo + explorer runtime flow checks).
- [ ] Verify each validator has:
  - [ ] `validator_id`
  - [ ] `signing_key_hex`
  - [ ] `[[validators]]` admission allowlist entries for the other validators
  - [ ] `[[peers]]` entries mapping validator IDs to QUIC addresses
- [ ] Decide test mode for API edge auth:
  - [ ] **Open local mode** (default localnet style).
  - [ ] **Auth-required mode** (`api_auth_required=true` + scoped API clients) if testing wallet submission under gated write endpoints.

---

## 3) Start node runtime (authoritative step)

- [ ] Launch the three-validator runtime from `citizen-protocol/`:
  - [ ] `scripts/run_localnet.sh`
- [ ] Confirm startup artifacts:
  - [ ] `data/validator-alpha.log`
  - [ ] `data/validator-beta.log`
  - [ ] `data/validator-gamma.log`
  - [ ] RocksDB directories: `data/alpha`, `data/beta`, `data/gamma`
- [ ] Confirm node runtime health on primary node:
  - [ ] `curl http://127.0.0.1:8081/health`
  - [ ] `curl http://127.0.0.1:8081/blocks/0`
  - [ ] `curl http://127.0.0.1:8081/namespaces`

---

## 4) Wallet-runtime API path validation (CLI first)

- [ ] Run automated wallet CLI E2E first (after section 3 runtime launch):
  - [ ] `cd citizen-protocol && scripts/run_wallet_cli_e2e.sh`
  - [ ] Optional custom node URL (if your runtime primary is not `8081`):
    - [ ] `cd citizen-protocol && NODE_URL=http://127.0.0.1:8082 scripts/run_wallet_cli_e2e.sh`
- [ ] Initialize wallet material (isolated test path):
  - [ ] `cargo run -p citizen-wallet-cli -- init --path .tmp-wallet-e2e/wallet.json`
  - [ ] `cargo run -p citizen-wallet-cli -- keygen --path .tmp-wallet-e2e/wallet.json --label e2e --password test-pass`
- [ ] Generate and sign a test entry (identity or content namespace compatible with local rules).
- [ ] Submit signed envelope to runtime:
  - [ ] `cargo run -p citizen-wallet-cli -- submit --api-url http://127.0.0.1:8081 --entry-json '<ENTRY_JSON>' --receipts-path .tmp-wallet-e2e/receipts.json`
- [ ] Verify receipt persistence and retrieval:
  - [ ] `cargo run -p citizen-wallet-cli -- list-receipts --receipts-path .tmp-wallet-e2e/receipts.json`
- [ ] If running auth-required API mode, verify expected behavior:
  - [ ] Missing/invalid key fails with `401`.
  - [ ] Missing scope fails with `403`.
  - [ ] Correct scoped key succeeds.

---

## 5) Browser wallet + landing-page onboarding app + explorer + demo runtime integration gate

Use the six-terminal topology for a realistic wallet-stack exercise and to satisfy smoke-test prerequisites.

- [ ] Terminal A: node runtime
  - [ ] `cd citizen-protocol && scripts/run_localnet.sh`
- [ ] Terminal B: landing-page backend/frontend
  - [ ] `cd landing-page && pnpm run dev`
- [ ] Terminal C: wallet browser extension watch build
  - [ ] `cd wallet/browser && npm run build -- --watch`
- [ ] Terminal D: demo blog runtime-backed mode
  - [ ] `cd demo && CITIZEN_NODE_URL=http://127.0.0.1:8081 CITIZEN_CONTENT_NAMESPACE=content.article npm run start`
- [ ] Terminal E: explorer backend wired to runtime
  - [ ] `cd explorer/backend && PORT=4010 CITIZEN_NODE_URL=http://127.0.0.1:8081 npm run start:dev`
- [ ] Terminal F: explorer frontend wired to explorer backend
  - [ ] `cd explorer/frontend && NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4010 npm run dev -- --port 4020`
- [ ] Optional landing-page relay-mode check (backend-relayed signed onboarding path):
  - [ ] `curl http://127.0.0.1:3001/interest/signed-submission-contract`
  - [ ] If `relayMode=database_plus_network_relay`, ensure `CITIZEN_SIGNED_SUBMISSION_RELAY_URL` points to a **compatible relay adapter endpoint** that accepts onboarding signed metadata and translates it for runtime submission.
  - [ ] If no relay adapter is running, leave `CITIZEN_SIGNED_SUBMISSION_RELAY_URL` unset and confirm `relayMode=database_only` for this exercise.
- [ ] Load unpacked extension from `wallet/browser/dist` and create/unlock wallet.
- [ ] Submit onboarding interest from landing-page UI and approve signature in extension.
- [ ] Submit demo article flow and approve signature in extension.
- [ ] Confirm runtime read models update:
  - [ ] `curl http://127.0.0.1:8081/entries/content.article`
  - [ ] `curl http://localhost:4300/api/articles`
  - [ ] `curl http://127.0.0.1:4010/entries/content.article`

---

## 6) Smoke test + evidence capture gate

- [ ] Execute stack smoke checks:
  - [ ] `cd citizen-protocol && scripts/stack_runtime_smoke_test.sh`
- [ ] Collect logs for run evidence:
  - [ ] Node logs (`data/validator-*.log`)
  - [ ] Landing-page/backend/frontend logs
  - [ ] Demo log output
  - [ ] Explorer backend/frontend logs
- [ ] Record deterministic test metadata in your test notes:
  - [ ] Git commit SHA
  - [ ] Runtime config set used
  - [ ] Timestamp and operator
  - [ ] Pass/fail status per checklist section

---

## 7) Common failure checkpoints (fast triage)

- [ ] `node_runtime_unavailable` in landing-page onboarding app:
  - [ ] Node process running?
  - [ ] If relay mode enabled, `CITIZEN_SIGNED_SUBMISSION_RELAY_URL` points to a live compatible adapter endpoint?
- [ ] Demo checks fail in smoke script:
  - [ ] Demo process running on `localhost:4300`?
  - [ ] `CITIZEN_NODE_URL=http://127.0.0.1:8081` configured for demo process?
- [ ] Explorer empty/stale:
  - [ ] Explorer backend running on `4010`?
  - [ ] `NEXT_PUBLIC_API_BASE_URL` points to `http://127.0.0.1:4010`?
  - [ ] `content.article` entries present on node API?
- [ ] Wallet extension not detected:
  - [ ] `wallet/browser/dist/manifest.json` exists?
  - [ ] Extension reloaded after watch build?
- [ ] Runtime API writes rejected:
  - [ ] Namespace policy mismatch (payload fields/signature)?
  - [ ] API auth/scope mismatch when auth-required mode enabled?

---

## 8) Exit criteria for this exercise

Mark the exercise complete only when all are true:

- [ ] Local three-validator runtime is healthy.
- [ ] Wallet-signed submission reaches runtime and yields receipts.
- [ ] Landing-page onboarding app (signed-submit), demo blog, and explorer all reflect runtime-backed data changes.
- [ ] Smoke checks pass end-to-end.
- [ ] Logs and run evidence are archived for reproducibility.
