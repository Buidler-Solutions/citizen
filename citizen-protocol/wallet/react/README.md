# Citizen Wallet React App

User-facing wallet scaffold for Citizen Protocol with strict builder-credit authoring aids.

## Delivered Scope

- Onboarding and key management UI (create key, rotate/archive).
- Namespace-aware entry builder for `identity.citizen`, `registry.land`, `audit.procurement`, `governance.vote`, and `builder.credits`.
- Strict write validation for non-bootstrap writes (`payload.credit_grant_id` required).
- Builder-credit draft templates for:
  - `MULTISIG_CREDIT_GRANT` using runtime-compatible `payload.amount` and `multisig_threshold`.
  - `SPONSOR_USAGE` using runtime-compatible `payload.amount`, `sponsorship_id`, and `sponsored_did`.
- Submission status panel with receipt finalization and export bundle.
- Governance UX skeleton for proposal creation, vote action affordance, and finality display.
- API alignment note: submissions target `http://127.0.0.1:8080/api/v1/envelopes/submit`.

## Development

```bash
npm install
npm run dev
```

## Validation

```bash
npm run check:minimatch
npm run test
npm run build
```
