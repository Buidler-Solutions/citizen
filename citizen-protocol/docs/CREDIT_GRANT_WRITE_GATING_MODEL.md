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
   - Enforce endpoint scopes (for example, `entries.submit`, `envelopes.submit`,
     `files.commit`, `payloads.commit`, `files.revoke`).
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

Current stack enforces strict API-edge builder-credit gating on ledger submit
paths (`/api/v1/entries/submit`, `/api/v1/envelopes/submit`) and on offchain
envelope write flows (`/api/v1/files/commit`, `/api/v1/payloads/commit`,
`/api/v1/files/revoke`) before ledger admission. Writes must include
`payload.credit_grant_id` referencing an active `builder.credits` grant for
`payload.sponsor_builder_id` (or `entry.author` when omitted).

At ledger policy level, `SPONSOR_USAGE` also requires `payload.credit_grant_id`,
unique `sponsorship_id`, and sufficient available builder credits, preserving
deterministic rejection when sponsorship linkage or spend conditions are invalid.
