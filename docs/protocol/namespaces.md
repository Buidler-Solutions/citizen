# Namespaces

Namespaces are the fundamental unit of organization in Citizen. Each namespace operates as an independent governed domain with its own policies, rules, and entry types.

## What is a Namespace?

A namespace is a scoped partition of the ledger where:

- Entries are validated against namespace-specific policies
- Signers must be authorized by the namespace
- Data custody and privacy rules are enforced per-namespace
- Governance proposals can modify namespace behavior

## Namespace Policies

Each namespace can configure the following policies:

| Policy | Purpose |
|--------|---------|
| **Signature policy** | Which signature schemes and key types are accepted |
| **Consent policy** | Whether consent receipts are required for entries |
| **Builder-credit policy** | Rules for fee credits and sponsored usage |
| **Privacy policy** | Field-level encryption and selective disclosure |
| **Asset-control policy** | Asset issuance, transfer, and clawback rules |
| **WASM runtime policy** | Whether scoped execution is enabled and its limits |
| **Interop adapter policy** | Rules for cross-system bridges |
| **Off-chain encrypted file policy** | Allowed MIME types, size limits for encrypted attachments |

## Creating a Namespace

New namespaces are created through governance proposals:

```bash
citizen-wallet-cli propose-namespace \
  --name "civic-records" \
  --signature-policy ed25519 \
  --consent-policy required \
  --builder-credit-policy standard
```

The proposal goes through the standard governance lifecycle (proposal → voting → activation).

## Opposite Policies on the Same Network

Because each namespace enforces its own policies independently, two namespaces on the **same** Citizen network can enforce completely opposite rules. The ledger validates entries against each namespace's own policy set — there is no global network-wide policy that applies uniformly.

| Policy | Namespace A | Namespace B |
|--------|-------------|-------------|
| **Signature** | Require Ed25519 only | Accept multiple signature schemes |
| **Consent** | Mandatory consent receipts per entry | No consent required |
| **Privacy** | All fields encrypted off-chain by default | All entries fully public |
| **Identity gating** | Gold-tier CTZN citizenship required | Open to any DID |
| **WASM execution** | Governance-gated, audited modules only | Disabled entirely (data plane only) |
| **Asset transfers** | Allowed with clawback controls | Prohibited |
| **Builder credits** | Per-entry fee in builder credits | Sponsored usage (free to end-users) |
| **Encrypted files** | Only PDF, max 5 MB | Any MIME type, max 100 MB |

### Real-World Example

On a single Citizen network, these namespaces could coexist simultaneously:

```
Network: citizen-mainnet
│
├── civic.election        → gold citizenship required, public ballots, no WASM
├── civic.land-registry   → silver citizenship required, encrypted deeds, WASM escrow
├── rideshare.trips       → open to any DID, consent receipts mandatory, privacy-by-default
├── audit.procurement     → admin-gated, fully public, no encrypted files
└── research.anonymous    → no KYC, no consent, fully encrypted, no asset transfers
```

What constitutes a valid entry in `civic.election` (gold-tier citizen, public payload) would be rejected in `research.anonymous` (no KYC enforced). Conversely, an anonymous encrypted submission valid in `research.anonymous` would fail in `civic.election` where citizenship gating is required. The same validators enforce both sets of rules on the same block — the namespace, not the network, defines what is permitted.



## Cross-Namespace Interconnection

Namespaces are not isolated silos. The protocol supports three forms of cross-namespace interaction:

### 1. Policy-Level Cross-References

Namespace policies can reference and read entries from other namespaces. This is enforced at the ledger level — no smart contracts required:

| Policy | Reads From | Purpose |
|--------|-----------|---------|
| `civic_voting_policy` | `civic.proposal` | Verifies a proposal exists and is open before accepting a ballot |
| `election_ballot_policy` | `civic.election` | Validates candidate eligibility, race structure, and max selections |
| `ctzn_citizenship_policy` | `execution.module` | Checks the author's CTZN token state (tier, schema, expiry, revocation) |
| `kyc_verification_policy` | Admin namespace | Verifies the signer is an authorized KYC administrator |

### 2. WASM Contract Cross-Namespace R/W

Smart contracts can read and write across namespaces via host functions:

```rust
// Read an entry from any namespace
let entry = read_namespace_entry("civic.admin", "entry-uuid-123");

// Write an entry to another namespace (if allowed by target policy)
write_namespace_entry("civic.election", r#"{"action":"OPEN_ELECTION"}"#);
```

The target namespace's WASM runtime policy controls whether external contracts are permitted as writers. A contract in `rideshare.trips` can read driver verification records from `transit.drivers`, or a voting contract can query `admin-registry` to check voter eligibility — all on the same block, validated by the same validators.

### 3. Governance Inter-Namespace Actions

Governance proposals approved in the `governance` namespace can:

- Create and activate new namespaces
- Modify namespace policies (signature, consent, privacy, etc.)
- Deactivate or archive namespaces
- Admit validators to the consensus set
- Change protocol-level parameters

## Namespace Readiness

Before activation, the governance engine validates that a namespace has:

- A valid signature scheme
- All required policies configured
- No conflicts with existing namespaces
- Proper admission criteria

## Default Namespace

The protocol includes a `default` namespace that is always available. It uses standard policies and is suitable for testing and initial onboarding.

## Rate Limiting & Spam Prevention for Fungible Tokens

Citizen Protocol provides four layers of spam prevention designed specifically for fungible token economies. When governance approves a new fungible token, these defenses activate automatically.

### Layer 1: Per-Writer API Rate Limiting (Edge)

Every write request — including token transfers — passes through a sliding-window rate limiter at the API layer. This caps how many entries a single author can submit per minute to a given namespace.

**Node configuration (TOML):**

```toml
# Default limit for all namespaces (writes per author per minute)
default_writer_rate_limit_per_minute = 30

# Per-namespace overrides — tighten for token namespaces
[writer_rate_limits]
"ft.transfers" = 10
"builder.credits" = 10
"gov.civic" = 5
```

When a writer exceeds the limit, the API returns HTTP 429:

```json
{
  "error": "writer rate limit exceeded",
  "author": "did:web:example.com:user",
  "namespace": "ft.transfers",
  "limit_per_minute": 10
}
```

### Layer 2: Consensus-Level `rate_limit_policy` with Wash-Trade Detection (Ledger)

The `rate_limit_policy` namespace rule enforces per-author write limits at the ledger validation level. For fungible tokens, it also includes **wash-trade detection** — it blocks A→B→A ping-pong transfer patterns that artificially inflate transaction volume.

```json
{
  "name": "rate_limit_policy",
  "config": {
    "max_writes_per_window": 10,
    "window_secs": 3600,
    "wash_trade_window_secs": 600,
    "max_wash_trade_cycles": 3
  }
}
```

- `max_writes_per_window` — max entries from one author in the time window
- `wash_trade_window_secs` — time window for detecting circular transfers (0 = disabled)
- `max_wash_trade_cycles` — max bidirectional transfers between two accounts before blocking

This means even if a writer bypasses a single node's API rate limit, the consensus-level policy still rejects entries — and wash trades are detected across all validators.

### Layer 3: Per-Author Block Proposal Cap (Consensus)

When validators propose blocks, the consensus engine caps the number of entries a single author can have in a single block. This prevents one writer from filling an entire block and crowding out other token transfers.

The cap is automatically set to `max_entries_per_block / 4`. With the default `max_entries_per_block = 100`, each author is limited to 25 entries per block.

### Layer 4: Faucet Contract with Transfer Limits (Economic)

The **faucet WASM module** (`modules/faucet/`) is a purpose-built fungible token distribution contract. It includes:

- **KYC verification required** — users must prove identity before claiming tokens
- **Cooldown period** — configurable delay between claims (default: 24 hours)
- **Daily cap** — maximum tokens claimable per day per user
- **Transfer rate limiting** — caps transfers per user per 10-minute window
- **Wash-trade detection** — blocks circular A→B→A transfers after 3 cycles
- **Balance tracking** — real fungible token balances with mint/transfer operations
- **Admin-gated** — can be paused/resumed by governance

**Faucet operations:**

| Operation | Parameters | Description |
|---|---|---|
| `configure` | `admin_did`, `admin_sig`, `token_code`, `claim_amount`, `cooldown_secs`, `daily_cap`, `max_transfers_per_window`, `proposal_id?` | Initialize faucet (governance-gated) |
| `claim` | `claimant_did`, `kyc_proof`, `kyc_signature` | Claim fungible tokens (KYC + cooldown enforced) |
| `transfer` | `from_did`, `to_did`, `amount`, `signature` | Transfer tokens between accounts (balance + rate checked) |
| `balance` | `did` | Get token balance, total claimed, and claim count |
| `status` | `claimant_did` | Check cooldown, daily remaining, and current balance |
| `admin_stats` | `admin_did`, `admin_sig?` | Get global supply, distribution, and faucet stats |
| `pause` | `admin_did`, `admin_sig` | Pause faucet (emergency) |
| `resume` | `admin_did`, `admin_sig` | Resume faucet |

### Fungible Token Transfer Support

The `asset_control_policy` now supports `TRANSFER` actions for fungible tokens:

```json
{
  "action": "TRANSFER",
  "object_id": "did:web:sender.example",
  "payload": {
    "issuer": "did:web:token-issuer.example",
    "asset_code": "CITY",
    "amount": 500,
    "to": "did:web:recipient.example"
  }
}
```

Transfer validation:
- Sender must have sufficient balance (computed from event-sourced history)
- Recipient must have an open trustline (unless `require_recipient_trustline` is false)
- Recipient trustline capacity is checked (`current + amount <= max_holding`)
- Self-transfers are rejected

### Example: Complete Fungible Token Namespace with Anti-Spam

```json
{
  "namespace": "ft.city-token",
  "writers": [],
  "validators": [
    { "name": "require_signature" },
    { "name": "allowed_actions", "config": { "actions": ["TRUSTLINE_OPEN", "TRUSTLINE_CLOSE", "ASSET_HOLD", "ASSET_RELEASE", "ASSET_REVOKE", "TRANSFER"] } },
    { "name": "asset_control_policy", "config": { "transfer_action": "TRANSFER", "owner_field": "owner_did", "require_recipient_trustline": true } },
    { "name": "rate_limit_policy", "config": { "max_writes_per_window": 10, "window_secs": 60, "wash_trade_window_secs": 600, "max_wash_trade_cycles": 3 } }
  ]
}
```

### Defense-in-Depth Summary

| Layer | Scope | Mechanism | FT-Specific Feature |
|---|---|---|---|
| API rate limit | Per-node | Sliding window per author+namespace | Tighter limits for `ft.*` namespaces |
| Ledger policy | Consensus | `rate_limit_policy` with wash-trade detection | Blocks A→B→A cycles within configurable window |
| Block proposal cap | Consensus | Max entries per author per block | Prevents block stuffing with micro-transfers |
| Faucet contract | Economic | KYC + cooldown + daily cap + transfer limits + balance tracking | Purpose-built for fungible token distribution |
