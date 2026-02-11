# Citizen Wallet

This directory contains the Citizen wallet applications:

- `cli/` — standalone command-line wallet client (built on `crates/wallet`).
- `react/` — user-facing React wallet app (onboarding, key management, entry builders, receipts, governance UX).

Current status:
- Rust wallet core (`crates/wallet`) provides key custody, signing, verification, hardware-provider abstraction hooks, concrete mock TPM/HSM providers, and action policy checks.
- CLI app supports key lifecycle, namespace signing helpers, policy-gated governance vote signing, submission, and receipt verification.
- React app provides phase-2 and phase-3 UX flows with local persistence and export support.

Key docs:
- `docs/WALLET_IMPLEMENTATION_TASKS.md`
- `docs/WALLET_DECISIONS.md`
- `docs/WALLET_SECURITY_REVIEW.md`
