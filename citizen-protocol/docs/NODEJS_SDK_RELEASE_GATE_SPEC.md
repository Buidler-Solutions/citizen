# Node.js SDK Minimal Release Gate Spec

Status: Draft (fast-path to move SDK release readiness from **NO-GO** to **GO**)

Scope: `sdk/nodejs` and its runtime integration path used by `dapp/apps/api`.

## 1. Goal

Define the **minimum CI release gate** that must pass before promoting `@citizen-protocol/nodejs-sdk` for broad dApp-builder consumption.

This spec is intentionally small: it prioritizes deterministic receipts, canonical envelope correctness, and builder onboarding speed.

## 2. Release Gate Jobs (exact CI jobs)

A release candidate is valid only if all jobs below are green on the release branch/tag.

### Job A — `sdk-unit-node18`

- Runtime: Node.js 18.x
- Working dir: `sdk/nodejs`
- Commands:
  - `npm ci`
  - `npm test`

**Pass criteria**
- Test process exits `0`.
- No failing tests.

**Fail criteria**
- Any non-zero exit code.

---

### Job B — `sdk-unit-node20`

- Runtime: Node.js 20.x
- Working dir: `sdk/nodejs`
- Commands:
  - `npm ci`
  - `npm test`

**Pass criteria**
- Test process exits `0`.
- No failing tests.

**Fail criteria**
- Any non-zero exit code.

---

### Job C — `sdk-package-audit`

- Runtime: Node.js 20.x
- Working dir: `sdk/nodejs`
- Commands:
  - `npm ci`
  - `npm pack --dry-run`

**Pass criteria**
- `npm pack --dry-run` exits `0`.
- Tarball contains only expected release files:
  - `README.md`
  - `package.json`
  - `src/index.js`
  - `src/index.d.ts`

**Fail criteria**
- Pack fails, or unexpected files are included in tarball.

---

### Job D — `sdk-live-node-smoke`

- Runtime: Ubuntu latest, Rust stable + Node.js 20.x
- Scope: prove SDK can submit to a real local node endpoint and retrieve deterministic receipt state.

**Required flow**
1. Start one local node:
   - `cargo run -p citizen-node -- config/localnet/validator-alpha.toml`
2. Wait for health:
   - `curl --fail http://127.0.0.1:8081/health`
3. Run SDK smoke script (checked into repo):
   - `node sdk/nodejs/scripts/live_node_smoke.mjs`

**Smoke script contract**
- Uses `CitizenNodeClient` against `http://127.0.0.1:8081`.
- Submits one `audit.procurement` `RECORD_EVENT` transaction via a deterministic stub signer.
- Asserts submission response includes `receipt.receipt_id`.
- Polls `waitForReceipt` and exits success only on terminal state (`Accepted` or `Rejected`).

**Pass criteria**
- Node health probe passes.
- Smoke script exits `0`.
- Smoke script logs receipt id and terminal status.

**Fail criteria**
- Node never becomes healthy.
- Transaction submit fails.
- Receipt polling times out.

## 3. Branch Protection / Merge Policy

A release PR/tag is eligible only when all four required checks are green:

- `sdk-unit-node18`
- `sdk-unit-node20`
- `sdk-package-audit`
- `sdk-live-node-smoke`

No manual override for red checks on release tags.

## 4. Semver and Release Rules

Use strict semantic versioning for `@citizen-protocol/nodejs-sdk`:

- **PATCH**: bug fixes, docs-only packaging metadata changes, non-breaking internal refactors.
- **MINOR**: additive non-breaking API (new optional params, new exports).
- **MAJOR**: any API removal/rename, behavior change that can break existing dApps.

Release PR must include:
1. Version bump in `sdk/nodejs/package.json`.
2. Short changelog section in PR body:
   - Added
   - Changed
   - Fixed
   - Breaking (if any)

## 5. GO / NO-GO Decision Rule

Mark release status as **GO** only when all are true:

1. All four required CI jobs pass.
2. Package dry-run output matches expected file list.
3. Semver bump classification is documented in PR.
4. DApp compatibility check is recorded:
   - `dapp/apps/api` still resolves SDK and starts without SDK import/runtime errors.

Otherwise status is **NO-GO**.

## 6. Fast Adoption Plan (to implement this spec quickly)

1. Add `sdk/nodejs/scripts/live_node_smoke.mjs`.
2. Add CI workflow implementing the four jobs in this spec.
3. Make these checks required in branch protection.
4. Use this document as the release checklist source of truth.

---

This is the minimum gate. Additional hardening (multi-OS matrix, flaky-test quarantine policy, provenance attestation, npm provenance signing) can be layered later without blocking immediate builder readiness.
