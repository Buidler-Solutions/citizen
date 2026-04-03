# Wallet Data Isolation Cross-Stack Sync Guardrails

Date: 2026-04-03  
Status: Active (Model 1 hardened)

This document operationalizes the cross-stack sync checklist for signed submission flows.

## Required synchronized surfaces

- `wallet/browser`: request model, canonicalization, approval UI, signature-scope binding.
- `landing-page/frontend`: onboarding form signing UX and signed-submit gating.
- `wallet/backend`: signature/session verification primitives used by wallet-auth flows.
- `landing-page/backend`: signed onboarding verification, relay, retry/dedup telemetry.
- `sdk/nodejs` and `wallet/sdk/typescript-auth`: contract-level payload/signature interoperability.
- `wallet/cli`: operator guidance for custody, relay, and auditing workflows.

## Canonical signed submission contract

### On-chain commitment fields

The signed/relay commitment path must include:

- `walletPayloadHash`
- `walletSignerDid`
- `walletVerifyingKey`
- `walletSignature`
- `walletSignatureScope`
- `walletAlgorithm`

### Off-chain custody fields

PII and business payload remain off-chain and backend-custodied, including:

- onboarding user data (`fullName`, `institution`, `email`, `country`, role/mission fields)
- persistence location and retention policy
- access policy and operator controls

## Deterministic mapping requirement

All participating surfaces must preserve the mapping:

1. dApp canonicalizes payload bytes.
2. Wallet derives hash and signs request scope bound to origin/method/requestId/timestamps.
3. Backend recomputes hash and verifies signature against submitted metadata.
4. Only verified commitment metadata is eligible for runtime relay.

Any contract change to canonicalization, field names, signature scope, or relay payload shape must be updated atomically across the six surfaces above.

## Release-gate checks

Before promoting rollout stage:

1. Wallet/browser tests for canonicalization + lifecycle + replay safety pass.
2. Landing-page backend signed-submit verification tests pass.
3. Relay failure telemetry includes direct-submit failure rate.
4. SDK docs/examples remain compatible with current request/signature envelope.
5. Runbook evidence exists for manual D2 scenarios.
