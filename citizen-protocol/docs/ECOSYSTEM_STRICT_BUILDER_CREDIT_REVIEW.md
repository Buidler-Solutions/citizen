# Ecosystem Review: Strict Builder Credit Grant + Sponsorship Implementation

## Scope reviewed
- Runtime policy and API enforcement (`crates/ledger`, `crates/api`)
- SDK helper coverage (`sdk/nodejs`)
- Wallet surfaces (`wallet/cli`, `wallet/react`, `wallet/browser`)
- Demo ecosystem apps (`dapp`, `demo`)
- Runbooks/scripts (`docs/*runbook*`, `scripts/smoke_test_node_entry.sh`)

## Executive status
- **Runtime + SDK + runbooks/scripts:** mostly aligned with strict builder-credit enforcement.
- **Wallet React + browser wallet + demo dApps:** **not fully updated** for strict grant/sponsorship linkage.

## Findings by component

### 1) Runtime enforcement (Aligned)
- API submit path enforces mandatory `payload.credit_grant_id` for writes and validates linkage against active `builder.credits` grants (with `sponsor_builder_id` fallback to `entry.author`).
- `builder.credits` bootstrap actions (`MULTISIG_CREDIT_GRANT`, `PROGRAMMABLE_CREDIT_GRANT`) are exempted from pre-existing grant-link checks.
- Ledger rule enforcement includes:
  - grant action hardening (`MULTISIG_CREDIT_GRANT`/`PROGRAMMABLE_CREDIT_GRANT`),
  - sponsorship constraints (`SPONSOR_USAGE` requiring `credit_grant_id`, unique sponsorship ids, sufficient balances),
  - deterministic multisig proof verification.

### 2) SDK (Aligned)
- Node.js SDK includes first-class operation builders for `MULTISIG_CREDIT_GRANT` and `SPONSOR_USAGE`.
- SDK validation requires strict sponsorship payload fields (`credit_grant_id`, `sponsorship_id`, `sponsored_did`) before submission.

### 3) Runbooks + scripts (Aligned)
- Localnet and validator runbooks document strict write gating and required grant linkage fields.
- `scripts/smoke_test_node_entry.sh` requires `CREDIT_GRANT_ID` and injects both `credit_grant_id` and `sponsor_builder_id` in payload.

### 4) Wallet CLI (Partially aligned)
- CLI includes `sign-builder-credit-proof` helper for multisig grant proof generation.
- CLI does **not** expose dedicated high-level commands for creating/submitting strict `builder.credits` grant/sponsorship entries end-to-end; users must rely on generic `sign-entry`/manual payload flow.

### 5) Wallet React (Not aligned)
- React wallet remains a local scaffold UI with simulated pending/finalized states and no strict builder-credit grant/sponsorship workflow.
- Namespace options shown in UI do not include `builder.credits`.

### 6) Browser wallet / extension (Not aligned)
- Browser wallet focuses on account/password + generic `personal_sign` style request handling.
- No extension UX for `builder.credits` grant linkage, sponsor selection, or strict sponsorship metadata authoring.

### 7) Demo dApps + demo blog (Not aligned)
- DApp API envelope creation for article publishing submits `content.article` entries without `payload.credit_grant_id` / `payload.sponsor_builder_id`.
- Demo blog server also builds runtime submit envelopes without strict builder-credit linkage fields.
- With current strict runtime gating, these flows will be rejected unless their payload model is upgraded.

## Conclusion
The strict builder-credit model is implemented and documented at runtime/policy level, but **ecosystem app surfaces are not uniformly upgraded** yet. The primary remediation priority is to update wallet + dApp/demo submission UX and payload construction so every write path can carry valid grant linkage metadata under the strict policy.
