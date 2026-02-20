# Wallet Architecture Decisions

Date: 2026-02-11

## Phase 0 Decision Log

### 1) Keystore format

**Decision:** Use JSON keystore (`wallet.json`) as the default and stable format for CLI + React parity in v0.1.

**Rationale:**
- Existing implementation already ships with JSON keystore and encrypted secrets.
- Simple auditability for governance-centric operators.
- Fastest path for localnet and E2E testing.

**Migration plan:**
- Keep top-level `version` in keystore payload.
- Introduce optional SQLite backend behind a feature flag in a future hardening release.

### 2) Node API base URL and versioning

**Decision:** Standard wallet submission endpoint is:

`http://127.0.0.1:8080/api/v1/envelopes/submit`

**Rationale:**
- Explicit versioning reduces client churn for React and CLI.
- Matches expected forward compatibility patterns for wallet release channels.

## Security and compatibility note

- Keystore entries remain encrypted with Argon2id + ChaCha20-Poly1305.
- Any API path changes in future protocol versions must be additive with `/api/v{n}` namespace.


### 3) Builder-credit multisig operating model (3-of-5)

**Decision:** Standard operator profile uses a 3-of-5 signer model for `MULTISIG_CREDIT_GRANT` in `builder.credits`.

**Rationale:**
- Aligns with governance-first safety (no unilateral grant issuance).
- Preserves operational liveness during single-signer outages.
- Keeps verification deterministic via approver allowlist and key binding.

**Implementation reference:**
- `docs/MULTISIG_3_OF_5_IMPLEMENTATION_HOWTO.md`
