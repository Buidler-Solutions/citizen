# Wallet Task Status Review (Evidence Pass)

Date: 2026-02-11

This review re-checks `docs/WALLET_IMPLEMENTATION_TASKS.md` against concrete repository evidence.

## Summary

- Tracker view: all tasks are currently marked `[x] done`.
- Evidence view: wallet phases now satisfy the implementation checklist, including previously flagged phase-4 hardening gaps.

## Complete (implemented with direct evidence)

### Phase 0 — Repository Prep
- Confirm wallet crate API surface exists (`keygen/import/sign/verify`) — complete.
- CLI keystore format decision documented (JSON) — complete.
- Wallet submission API base URL/versioning alignment documented — complete.

### Phase 1 — CLI Wallet
- Standalone CLI binary exists as `citizen-wallet-cli` — complete.
- Key lifecycle commands implemented (`init`, `keygen`, `import-key`, `list-keys`, `public-key`, `export-key`) — complete.
- Namespace authoring helpers implemented (`sign-identity-register`, `sign-governance-vote`, `sign-registry-transfer`, `sign-audit-record`) — complete.
- `submit` command implemented with configurable API URL + endpoint — complete.
- Receipt persistence + listing implemented (`wallet-receipts.json`, `list-receipts`) — complete.
- Receipt verification command implemented (`verify-receipt`) — complete.
- Localnet usage docs present in wallet CLI README — complete.

### Phase 2 — React Wallet
- React app scaffold exists (Vite) — complete.
- Onboarding + key management UI exists (create/rotate/list) — complete.
- Namespace entry builder exists (identity/registry/audit/governance) — complete.
- Submission + status tracking UI exists — complete.
- Receipt viewer + export bundle UI exists — complete.

### Phase 3 — Governance + Validator Support
- Proposal creation flow exists — complete.
- Vote action with signature-preview affordance exists (UI control) — complete.
- Governance history/finality display exists — complete.

### Phase 4 — Security & Hardening
1. **Hardware-backed key provider abstraction (TPM/HSM)**
   - Generic `KeyProvider` abstraction exists.
   - Concrete mock TPM and mock HSM provider implementations now exist in wallet core and are covered by tests.

2. **Policy controls (multisig/approvals) for high-impact actions**
   - `ActionPolicy` threshold evaluation exists in wallet core.
   - Governance vote signing now supports runtime policy enforcement via CLI flags (`--required-approvals`, `--policy-approver`, `--approval`).

3. **Threat model + storage/encryption security review**
   - Security review document exists and wallet encryption primitives are implemented.

### Phase 5 — QA & Release
- CLI E2E smoke script exists (`scripts/run_wallet_cli_e2e.sh`) — complete (smoke level).
- React integration + accessibility tests exist (`@testing-library/*`, `vitest-axe`) — complete.
- Versioned changelog entry exists for wallet phases (`0.1.0-wallet-phases`) — complete.

## Recommended status call

- Implementation checklist status remains **[x] done** across phases, with phase-4 hardening work now represented in code paths and tests.
