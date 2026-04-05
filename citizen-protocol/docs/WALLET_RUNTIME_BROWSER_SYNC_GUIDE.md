# Wallet Runtime Browser Sync Guide

_Date: 2026-04-04_

This guide captures the conclusions from a runtime-alignment review of:

- `citizen-protocol/docs/WALLET_RUNTIME_COMPAT_PROFILE.md`
- Rust runtime/wallet implementation (`citizen-protocol/crates/*`)
- Browser extension implementation (`wallet/browser/*`)

Use this as the working baseline for follow-up synchronization PRs.

## Executive Summary

The Rust wallet + CLI have meaningful WRCP implementation progress, but the browser extension is **not yet strict-runtime complete**.

- Rust wallet crate implements WRCP TX payload helpers and multisig proof/dry-run primitives.
- Wallet CLI exposes multisig proof authoring and dry-run commands.
- Browser extension supports auth lane and dApp signing flow, but currently signs `payloadHash` scope artifacts rather than the full WRCP-TX-V1 runtime canonical preimage contract.
- WRCP document itself marks browser/mobile parity as in progress and strict-compat gates as not complete.

## What is Implemented Today

### Rust wallet/runtime-aligned pieces

1. WRCP TX payload model + canonical serializer are implemented in wallet crate:
   - `WrcpTxV1SigningPayload`
   - `build_wrcp_tx_v1_signing_payload`
   - `wrcp_tx_v1_canonical_json`

2. WRCP multisig primitives are implemented in wallet crate:
   - `WrcpMsigV1Proof`
   - `WrcpMsigV1DryRunReport`
   - `build_wrcp_msig_v1_proof`
   - `dry_run_wrcp_msig_v1`

3. CLI commands are present for multisig flow:
   - `sign-builder-credit-proof`
   - `dry-run-builder-credit-grant`
   - `sign-builder-credit-grant` with `--multisig-proofs-json`

4. Ledger enforces multisig builder-credit policy checks and validates proof fields/signatures.

## What is Not Complete Yet

### Browser extension strict runtime compatibility

1. Extension dApp protocol flow currently signs `payloadHash` bytes with `signatureScope: payload_hash_v1`.
2. WRCP strict contract expects deterministic signing over the canonical WRCP entry preimage, including runtime-required fields.
3. Therefore, extension flow is not yet a 1:1 WRCP-TX-V1 runtime signing replacement.

### WRCP process gaps

1. WRCP conformance CI gate (`wrcp-conformance`) is not wired as a required release blocker.
2. Shared WRCP vectors are incomplete/partially wired.
3. Wallet/ledger parity vector consumption is incomplete.
4. Runtime-rejection telemetry checklist remains open.

### Documentation drift noted

The WRCP profile checklist claims `docs/test-vectors/wrcp_tx_v1/signature_cases.json` is present, but repository state during review only showed:

- `docs/test-vectors/wrcp_tx_v1/canonical_payloads.json`
- `docs/test-vectors/wrcp_msig_v1/proof_matrix.json`

## Browser Extension Current Capability (Accurate Positioning)

The browser extension is currently best described as:

- **Auth-lane ready** for dApp sign-in flows (`personal_sign`, `ctzn_signTypedData_v4`).
- **Protocol-adjacent** for canonicalized dApp payload envelope signing and payload-hash commitments.
- **Not yet strict WRCP complete** against Rust runtime canonical preimage + conformance gate requirements.

## Recommended Synchronization Work Plan

### Phase A — Browser WRCP canonical preimage parity

1. Add browser utility that builds WRCP-TX-V1 canonical payload identically to Rust wallet crate.
2. Add local verify-before-submit against same preimage bytes.
3. Introduce fixture tests using WRCP vectors for canonical payload parity.

### Phase B — Multisig parity on browser surface

1. Add policy-aware proof composition UX for `builder.credits/MULTISIG_CREDIT_GRANT`.
2. Add browser-side dry-run output schema aligned with wallet crate reason codes.
3. Ensure proof payload shape and signature composition match ledger verifier expectations.

### Phase C — Cross-crate vectors + CI release gate

1. Complete WRCP vectors (`canonical_payloads`, `signature_cases`, `proof_matrix`).
2. Ensure wallet + ledger tests consume same WRCP vectors.
3. Add required `wrcp-conformance` CI stage for release candidates.

### Phase D — Docs and operational synchronization

1. Update `WALLET_RUNTIME_COMPAT_PROFILE.md` checklist truthfully per merged changes.
2. Sync top-level status lines in `citizen-protocol/README.md` and deep-research baseline.
3. Add telemetry/monitoring implementation and runbook links when code exists.

## Definition of Done for “Browser runtime complete”

Do not mark browser extension as runtime-complete until all are true:

1. Browser signer emits WRCP-TX-V1 canonical payload/signature verified by Rust runtime verifier.
2. Browser supports WRCP-MSIG-V1 proofs without manual JSON editing.
3. Browser dry-run parity matches ledger negative-vector outcomes for supported cases.
4. Required WRCP conformance CI passes on release candidates.
5. Auth lane and protocol lane are visibly and cryptographically separated.

## Practical Usage of This Guide

For every related PR:

1. Reference this file in PR description.
2. State which phase (A/B/C/D) the PR addresses.
3. Update WRCP checklist statuses in the same PR.
4. Include evidence (tests/fixtures/CI links) for any status change from `[ ]`/`[~]` to `[x]`.

