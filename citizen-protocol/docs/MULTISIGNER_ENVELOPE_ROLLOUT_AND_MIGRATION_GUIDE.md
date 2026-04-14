# Multisigner Envelope Rollout and Migration Guide

This guide documents the operator + builder rollout sequence for runtime-native
multi-signer envelopes, now that API/ledger/SDK/wallet support exists in the
current workspace.

## 1) Phase 4 activation strategy (selected namespaces/actions)

Enable `envelope_multisig_policy` only for explicitly targeted actions in
governed namespaces. This keeps migration blast radius narrow while preserving
single-signer compatibility elsewhere.

### Default runtime pilot

The default node namespace bootstrap now includes a pilot namespace:

- `ops.multisig`
- targeted action: `APPROVAL_RECORD`
- `allowed_signers`: fixed DID allowlist
- `threshold`: `2`
- `signature_scope`: `canonical_payload_v1`

This is intentionally isolated from existing high-traffic namespaces and can be
used to validate operational behavior before broader policy rollout.

## 2) Builder migration guidance

1. Keep existing single-signer envelope paths unchanged for namespaces/actions
   that are not governance-configured for envelope multisig.
2. For targeted multisig actions:
   - build canonical payload once,
   - collect co-signatures against immutable canonical preimage,
   - submit only after threshold is satisfied.
3. Prefer SDK + wallet compose flows (`wrapEnvelopeMulti`,
   `appendCoSignature`, `finalizeEnvelope`, and wallet compose commands) instead
   of ad-hoc custom signing.

## 3) Phase 5 monitoring + controlled legacy deprecation

Before deprecating single-signer fallback paths for any namespace/action:

1. Track deterministic receipt validation metadata:
   - `receipt.validation.multisig.signature_scope`
   - `receipt.validation.multisig.threshold`
   - `receipt.validation.multisig.signers`
2. Review rejection patterns for:
   - threshold shortfall,
   - unauthorized signer,
   - duplicate signer,
   - signature scope mismatch.
3. Only after sustained healthy acceptance in the targeted namespace/action:
   - propose governance updates that expand `envelope_multisig_policy` targets,
   - tighten or remove legacy submission expectations where safe.

## 4) Governance change template (recommended)

For each namespace/action rollout increment, include:

- explicit target action list,
- signer allowlist source and ownership,
- threshold rationale,
- signature scope version,
- rollback plan,
- builder migration communication date.
