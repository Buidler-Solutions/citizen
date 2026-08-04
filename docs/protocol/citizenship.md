# Digital Citizenship with CTZN Tokens

Citizen Protocol uses soulbound (non-transferable) CTZN tokens to represent verifiable digital credentials on-chain. The most powerful application is **digital citizenship**: a government-issued, cryptographically verifiable identity token that gates access to civic services, voting, property registration, and social benefits.

## Why Soulbound for Citizenship

| Property | Citizenship Requirement |
|----------|------------------------|
| Non-transferable | Citizenship cannot be sold, gifted, or assigned to another person |
| Government-issued | Only authorized state bodies can issue credentials |
| Revocable | Denaturalization, residency revocation, or disciplinary action |
| Expiry-aware | Visas, temporary residencies, and renewable licenses have time limits |
| Tiered | Full citizens, permanent residents, and temporary residents have different rights |
| Schema-typed | One person holds multiple credentials: citizenship, voter registration, professional license |

## Citizenship Tiers

| Tier | Numeric | Status | Rights |
|------|---------|--------|--------|
| Gold | 2 | Full Citizen (born or naturalized) | Voting, property, all services, passport |
| Silver | 1 | Permanent Resident / Dual Citizen | Property, business, social services; no national voting |
| Bronze | 0 | Temporary Resident (visa holder) | Limited services, time-bound, employer-linked |

## Architecture

```
Government (State)
  |
  |  Governance proposal approved
  |  -> CTZN minted to citizen DID
  |
  v
+-------------------+     +-------------------+     +-------------------+
|   Voting Ballot   |     |  Land Registry    |     |  Social Services  |
|                   |     |                   |     |                   |
|  ctzn_citizenship |     |  ctzn_citizenship |     |  ctzn_citizenship |
|  _policy          |     |  _policy          |     |  _policy          |
|                   |     |                   |     |                   |
|  schema: citizen  |     |  schema: citizen  |     |  schema: citizen  |
|  tier >= 2 (gold) |     |  tier >= 1 (silver)|    |  tier >= 0 (bronze)|
+-------------------+     +-------------------+     +-------------------+
```

Each namespace configures its own citizenship requirements via the `ctzn_citizenship_policy` rule. The policy is enforced at the ledger level before any entry is committed.

## Policy Configuration

The `ctzn_citizenship_policy` namespace rule checks that the entry author holds an active CTZN token with the required schema and tier. It scans the execution module's state entries to verify token ownership.

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ctzn_module_id` | string | `"ctzn-token.v1"` | The deployed CTZN token module ID |
| `required_schema` | string | (any) | Required token schema type (e.g., `"citizenship"`) |
| `required_tier` | number | `0` (bronze) | Minimum tier: 0=bronze, 1=silver, 2=gold |
| `current_block_height` | number | (none) | Current chain height for expiry checking |

### Example: Voter Registration Namespace

```json
{
    "namespace": "voting.ballot",
    "version": 1,
    "rules_hash": "voting-v1",
    "governed_by": "governance.vote"
}
```

Validators:

```json
[
    {
        "name": "require_signature",
        "config": {}
    },
    {
        "name": "ctzn_citizenship_policy",
        "config": {
            "ctzn_module_id": "ctzn-token.v1",
            "required_schema": "citizenship",
            "required_tier": 2,
            "current_block_height": 500000
        }
    }
]
```

Only gold-tier citizens with active (non-revoked, non-burned, non-expired) citizenship tokens can submit ballot entries.

### Example: Land Registry Namespace

```json
{
    "name": "ctzn_citizenship_policy",
    "config": {
        "ctzn_module_id": "ctzn-token.v1",
        "required_schema": "citizenship",
        "required_tier": 1
    }
}
```

Silver-tier and above (permanent residents and full citizens) can register land titles.

## Validation Logic

When an entry is submitted to a namespace with `ctzn_citizenship_policy`, the ledger performs the following checks:

1. **Lookup holdings** - Reads `held:{author_did}` from the CTZN module state to find the author's token IDs
2. **Filter per token** - For each token, checks in order:
   - **Burned?** - Skip if `burned:{token_id}` is `"true"`
   - **Revoked?** - Skip if `revoked:{token_id}` is `"true"`
   - **Schema match?** - Skip if `schema:{token_id}` does not match `required_schema`
   - **Tier sufficient?** - Skip if `tier:{token_id}` is below `required_tier`
   - **Expired?** - Skip if `expiry:{token_id}` is set and `current_block_height >= expiry`
3. **Decision** - If any token passes all checks, the entry is accepted. Otherwise, it is rejected.

## Use Cases

### 1. Verifiable Elections

Only citizens with gold-tier citizenship tokens can vote. Each ballot is cryptographically tied to a verified identity. No duplicate voting, no non-citizen participation, full audit trail.

### 2. Land Ownership Enforcement

Foreign ownership restrictions enforced at the protocol level. Only silver-tier and above can acquire land titles. The policy check is deterministic and cannot be bypassed.

### 3. Social Services Distribution

Eliminates ghost recipients and duplicate claims. Only verified citizens with active tokens can claim benefits. When a citizen dies (token revoked by civil registry), claims are automatically blocked.

### 4. Professional Licensing

Government agencies issue professional licenses as CTZN tokens with `schema_type: "professional-license"`. Medical licenses, engineering credentials, legal bar memberships - all verifiable on-chain with automatic expiry and revocation.

### 5. Procurement Authority

Only CTZN-authorized procurement officers can create entries in `audit.procurement`. The token's tier determines signing authority limits, ensuring accountable public spending.

### 6. Passport-Free Travel

CTZN citizenship tokens can be verified cross-chain via the `interop.adapter` namespace. Partner nations can verify citizenship cryptographically without physical documents.

## Security Properties

- **Non-repudiable**: Token ownership is recorded on-chain and cannot be denied
- **Tamper-proof**: State changes require valid issuer signatures (N-of-M threshold)
- **Governance-gated**: Initial module configuration requires governance approval - no self-appointment
- **Transparent revocation**: All revocations and burns are auditable on-chain
- **Automatic enforcement**: Policy is checked at the ledger level, not in application code
- **No bypass**: The check runs inside `validate_entry` before any entry is committed

## Implementation Reference

The policy is implemented as a built-in namespace rule handler in `crates/ledger/src/lib.rs`:

- **Rule name**: `ctzn_citizenship_policy`
- **Method**: `Ledger::ctzn_citizenship_policy(entry, config)`
- **Tests**: 9 test cases covering active tokens, non-holders, revoked, burned, insufficient tier, schema mismatch, expired tokens, unspecified schema, and multiple-token scenarios

The implementation reads CTZN module state directly from the ledger's `execution.module` namespace entries (STATE_WRITE records), requiring no external service or database lookup.
