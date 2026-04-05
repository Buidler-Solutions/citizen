# Wallet Runtime / Browser Sync Progress Log

_Last updated: 2026-04-05_

This file is the implementation log for the wallet/runtime/browser synchronization work completed so far.

## Completed work (merged baseline)

### 1) WRCP vector and guide synchronization

- Added missing WRCP TX signature vector skeleton:
  - `docs/test-vectors/wrcp_tx_v1/signature_cases.json`
- Updated sync guide status to reflect vector presence and remaining shared-consumption gap.

### 2) Browser protocol-lane signing parity improvements

- Browser protocol signing now uses canonical protocol preimage bytes (not `payloadHash` bytes).
- Added explicit `protocolSigningPreimageFromEnvelope(...)` helper.
- Added local verify-before-return path for generated protocol signatures.
- Updated returned signature scope marker to `canonical_payload_v1`.

### 3) Form commitment flow support (namespace-first)

- Added `forms.commitment` namespace support in runtime defaults and network config samples.
- Enforced baseline validators for this namespace:
  - `require_signature`
  - `require_payload_fields` requiring `data_hash` and `encrypted_form_url`
- Added SDK helper:
  - `createFormCommitmentReceipt(...)`
  - with input validation for SHA-256 digest and encrypted form URL
- Added browser-side policy checks for `forms.commitment` signing requests.

### 4) Test stabilization for node admission preflight

- Updated `startup_preflight_runtime_policy_is_role_agnostic` test fixture to avoid environment-coupled failures by explicitly setting:
  - shared `startup_secret`
  - `manifest_enforce = false`

## Current status snapshot

- ✅ Browser protocol-lane signing is now canonical-preimage based.
- ✅ `forms.commitment` is defined at node bootstrap/config level.
- ✅ SDK includes first-class helper for form commitment submission payloads.
- ✅ WRCP signature vector skeleton file is present.
- ⏳ Strict WRCP completeness is still pending on shared vector consumption in wallet+ledger tests and required `wrcp-conformance` CI gating.

## Remaining high-priority gaps

1. Wire wallet and ledger tests to consume the same WRCP TX/signature/multisig vectors.
2. Add required `wrcp-conformance` release gate.
3. Complete browser multisig UX parity (`builder.credits/MULTISIG_CREDIT_GRANT`) without manual JSON editing.
4. Add runtime rejection telemetry dashboard/runbook links once implementation lands.
