# Wallet Signed Submission Architecture Decision (B1)

Date: 2026-04-02  
Status: Accepted  
Checklist reference: `wallet/docs/WALLET_DATA_ISOLATION_IMPLEMENTATION_CHECKLIST.md` (Gap B1)

## Decision

Citizen wallet-tech-stack integrations standardize on **Model 1 (current + hardened)**:

- The onboarding/builder dApp frontend requests wallet signing.
- The wallet extension returns only signed artifacts and commitment metadata to the dApp.
- The dApp submits signed payloads to its backend.
- The backend performs verification and conditionally relays commitment metadata to a configured Citizen runtime endpoint.

## Why Model 1 now

1. Preserves existing implemented flow in the landing-page onboarding stack.
2. Keeps relay controls, retries, idempotency keys, and operator policy checks in backend infrastructure.
3. Minimizes extension network egress and keeps runtime endpoint topology out of default wallet UX.

## Trust boundaries

### Wallet extension trust boundary

- Trusted for local key custody and deterministic signature generation over request-scoped preimages.
- Not trusted to persist or relay full onboarding payloads by default.
- Returns signatures, signer identity, payload hash, and signing-scope metadata to the requesting dApp.

### dApp/frontend trust boundary

- Builds and displays user form data and initiates signing requests.
- Must treat wallet response as cryptographic evidence only; cannot assume relay acceptance.

### Backend trust boundary

- Verifies signed metadata before persistence/relay.
- Owns relay policy enforcement, retry behavior, traceability, and network credential handling.
- Rejects malformed/mismatched signatures and hashes before any upstream call.

## Custody boundaries

### On-chain commitment fields (relay payload / commitment path)

- Payload hash (`walletPayloadHash`)
- Signer DID (`walletSignerDid`)
- Verifying key (`walletVerifyingKey`)
- Signature (`walletSignature`)
- Signature scope (`walletSignatureScope`)
- Algorithm (`walletAlgorithm`)

### Off-chain custody fields

- Business/PII form payload submitted to backend application storage.
- Backend-defined retention and access policy.
- Local browser memory/state during dApp form composition.

The deterministic mapping is:

1. dApp canonicalizes the signing payload.
2. Wallet signs a request scope bound to origin/method/requestId/timestamps/payload hash.
3. Backend recomputes and verifies payload hash/signature linkage before relay.

## Failure domains

1. **Wallet/UI failure**: request expires, rejected, cancelled, or wallet locked → deterministic client error codes; no relay occurs.
2. **dApp/frontend failure**: submit interrupted after signing → signature exists but no backend acceptance.
3. **backend verification failure**: malformed or mismatched signature metadata → request rejected before relay.
4. **relay/network failure**: runtime unavailable or non-2xx response → backend retry/terminal failure handling with trace IDs and deduplication keys.

## Implications

- Wallet-mediated direct runtime submission (Model 2) remains optional future work.
- Documentation and UI copy must explicitly state that signed submissions are backend-relayed under current architecture.
