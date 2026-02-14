# Citizen Wallet React App

User-facing wallet scaffold for Citizen Protocol.

## Delivered Scope

- Onboarding and key management UI (create key, rotate/archive).
- Namespace-aware entry builder for `identity.citizen`, `registry.land`, `audit.procurement`, and `governance.vote`.
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
npm run test
npm run build
```
