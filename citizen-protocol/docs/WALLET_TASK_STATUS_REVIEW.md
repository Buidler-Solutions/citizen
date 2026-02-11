# Wallet Task Status Review (Evidence Pass)

Date: 2026-02-11

This review re-checks `docs/WALLET_IMPLEMENTATION_TASKS.md` against concrete repository evidence.

## Summary

- Tracker view: all tasks are currently marked `[x] done`.
- Evidence view: most tasks are implemented; a few are better classified as **partially complete** if interpreted strictly as production-grade deliverables.

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

### Phase 5 — QA & Release
- CLI E2E smoke script exists (`scripts/run_wallet_cli_e2e.sh`) — complete (smoke level).
- React integration + accessibility tests exist (`@testing-library/*`, `vitest-axe`) — complete.
- Versioned changelog entry exists for wallet phases (`0.1.0-wallet-phases`) — complete.

## Partially complete / needs hardening before strict “done”

### Phase 4 — Security & Hardening
1. **Hardware-backed key provider abstraction (TPM/HSM)**
   - A generic `KeyProvider` abstraction exists and software provider is implemented.
   - No concrete TPM or HSM provider implementation appears in tree.
   - Recommended status under strict interpretation: **[~] in progress**.

2. **Policy controls (multisig/approvals) for high-impact actions**
   - `ActionPolicy` with threshold approval evaluation exists in wallet core.
   - Not yet wired into CLI/React governance execution flow as enforceable runtime policy controls.
   - Recommended status under strict interpretation: **[~] in progress**.

3. **Threat model + storage/encryption security review**
   - Security review document exists and wallet encryption primitives are implemented.
   - Recommended status: complete for documentation/baseline implementation.

## Recommended status call

- If “done” means **MVP feature presence**: keep all tasks as done.
- If “done” means **production-grade, fully integrated controls**: move the two hardening items above to in-progress until TPM/HSM provider(s) and policy enforcement are integrated end-to-end.
