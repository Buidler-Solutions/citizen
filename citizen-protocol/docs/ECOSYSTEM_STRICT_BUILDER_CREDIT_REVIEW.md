# Ecosystem Review: Strict Builder Credit Grant + Sponsorship Implementation

## Scope reviewed
- Runtime policy and API enforcement (`crates/ledger`, `crates/api`)
- SDK helper coverage (`sdk/nodejs`)
- Wallet surfaces (`wallet/cli`, `wallet/react`, `wallet/browser`)
- Demo ecosystem apps (`dapp`, `demo`)
- Runbooks/scripts (`docs/*runbook*`, `scripts/smoke_test_node_entry.sh`)

## Executive status
- **Runtime + SDK + runbooks/scripts + dApp/demo submission flows:** aligned with strict builder-credit enforcement.
- **Wallet surfaces:** React/browser wallet include strict builder-credit guidance, and wallet CLI now exposes dedicated grant/sponsorship signing commands.

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

### 4) Wallet CLI (Aligned)
- CLI includes `sign-builder-credit-proof` helper for multisig grant proof generation.
- CLI now includes dedicated strict-flow helpers:
  - `sign-builder-credit-grant` for `builder.credits` + `MULTISIG_CREDIT_GRANT` envelopes.
  - `sign-sponsor-usage` for `builder.credits` + `SPONSOR_USAGE` envelopes with direct `credit_grant_id` linkage.

### 5) Wallet React (Aligned)
- React wallet now includes `builder.credits` in namespace options and strict payload validation for non-bootstrap writes.
- Dedicated draft loaders generate runtime-compatible `MULTISIG_CREDIT_GRANT` and `SPONSOR_USAGE` payloads using `payload.amount`, `credit_grant_id`, `sponsor_builder_id`, `sponsorship_id`, and `sponsored_did`.

### 6) Browser wallet / extension (Aligned)
- Browser wallet popup now includes a strict builder-credit draft builder with preset templates and checklist guidance.
- Generated draft envelopes are runtime-compatible for `builder.credits` actions (`MULTISIG_CREDIT_GRANT`, `SPONSOR_USAGE`) with builder DID object linkage and `payload.amount` semantics.

### 7) Demo dApps + demo blog (Aligned)
- DApp API article submission now includes strict linkage fields (`payload.credit_grant_id`, `payload.sponsor_builder_id`) and challenge-time grant metadata propagation.
- Demo blog server runtime envelopes include strict linkage fields and preserve sponsor fallback behavior when `sponsorBuilderId` is omitted by clients.

## Conclusion
Strict builder-credit enforcement is implemented at runtime/policy level and now reflected across SDK, runbooks, dApp/demo submission payloads, and wallet CLI helper surfaces. Remaining UX hardening is primarily around richer browser-extension authoring workflows (grant selection, sponsorship templates, and validation hints) rather than missing core linkage fields.
