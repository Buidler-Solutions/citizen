# Credit-Grant-Gated Write Access Model

## Goal

Make credit grants the hard gating mechanism for ledger writes so no dApp user
or builder can submit write operations without an active issued grant.

This model aligns with the protocol direction on non-transferable builder fee
credits and sponsored user actions, while keeping deterministic and auditable
authorization receipts.

## Short Answer: API Key **and** Credit Grant Should Work Together

Use both controls, each for a different trust boundary:

- **API key** = identifies and rate-limits the calling integration client
  (ingress/authN + coarse authZ at API edge).
- **Credit grant** = authorizes economic write capacity for a specific builder
  policy and (optionally) sponsored user action (economic/authZ at ledger
  policy layer).

Neither should replace the other.

## Recommended Enforcement Layers

1. **API edge (ingress control)**
   - Require `x-api-key` for write endpoints.
   - Enforce endpoint scopes (for example, `entries:write`,
     `governance:write`).
   - Apply per-key rate limits and abuse controls.

2. **Ledger admission policy (economic authorization)**
   - Require `payload.credit_grant_id` (or equivalent canonical field) on every
     write action that consumes capacity.
   - Validate grant existence, active status, expiry, revocation state, and
     namespace/action allowance.
   - Validate grant ownership binding (`builder_id`, `dapp_id`, and optional
     wallet/subject constraints).

3. **Sponsorship path (builder sponsors wallet holder)**
   - Wallet holder signs the business payload.
   - Builder sponsors submission by referencing its active grant allocation.
   - Ledger records deterministic sponsorship receipt (`sponsorship_id`,
     grant id, builder id, sponsored DID).

If any layer fails, the write is rejected.

## Normative Decision Matrix

For write endpoints, enforce all of the following:

- Missing/invalid API key: reject.
- API key scope does not include write: reject.
- Missing `credit_grant_id`: reject.
- Grant revoked/expired/exhausted: reject.
- Grant namespace/action mismatch: reject.
- Sponsored action without unique `sponsorship_id`: reject.
- Sponsored action exceeding daily cap or available credits: reject.
- Otherwise: accept and emit deterministic receipt.

## Suggested Request Shape

```http
POST /api/v1/entries
x-api-key: builder-ingest-key
content-type: application/json
```

```json
{
  "entry": {
    "entry_id": "01JXX...",
    "namespace": "builder.credits",
    "action": "SPONSOR_USAGE",
    "object_id": "did:builder:acme",
    "author": "did:builder:acme",
    "payload": {
      "amount": 1,
      "credit_grant_id": "grant-2026-q1-001",
      "sponsorship_id": "spn-2026-03-01-00001",
      "sponsored_did": "did:user:wallet-holder-123"
    },
    "signature": "...",
    "timestamp": 1760000000
  }
}
```

## Grant Lifecycle Expectations

- **Issue**: governance/multisig credit grant creation recorded on-ledger.
- **Activate**: usable from effective height/time.
- **Consume**: each sponsored write debits available grant budget.
- **Revoke/Expire**: future writes fail deterministically.
- **Audit**: queryable receipts for compliance and dispute resolution.

## Why This Composition Is Strong

- Separates integration identity (API key) from economic authorization
  (credit grant).
- Prevents direct-write bypass by clients with keys but without credits.
- Preserves builder-first sponsorship UX for wallet holders.
- Keeps control governance-friendly and fully auditable.

## Implementation Note for Current Stack

Current stack enforces API-key write gating and builder credit policy checks
(including multisig grant controls and sponsorship anti-abuse constraints), and
`SPONSOR_USAGE` now requires `payload.credit_grant_id` to reference an existing
builder grant entry (`MULTISIG_CREDIT_GRANT` or `PROGRAMMABLE_CREDIT_GRANT`) for
the same builder. This gives deterministic reject behavior when sponsorship is
submitted without a valid issued grant linkage.
