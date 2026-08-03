# CTZN Token

CTZN is a **soulbound (non-transferable) identity token** module built on the Citizen WASM execution engine. Once minted to a recipient, a CTZN token is permanently bound to that identity - the `transfer` operation is always rejected.

**Location:** `citizen-protocol/modules/ctzn-token/`

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-issuer authority** | Configure authorized issuer DIDs with N-of-M signature thresholds. Initial configuration requires governance approval - no one can self-appoint as admin. |
| **Custom metadata schemas** | Each token has a `schema_type` (e.g., `degree`, `reputation`, `identity`) and free-form JSON metadata. |
| **Hierarchical tiers** | Tokens are assigned `bronze` (0), `silver` (1), or `gold` (2). Per-tier supply is tracked independently. |
| **Time-locked / revocable** | Optional `expiry_block` makes tokens expire at a future block height. Issuers can `revoke` tokens at any time. |
| **Attribute-based access control** | `check_access` verifies token ownership with tier/schema requirements. Supports direct token lookup or enumeration of a DID's holdings. |

## Governance Gate

The initial `configure` call requires a `proposal_id` that passes `host_check_governance_approval`. This means:

- No one can self-appoint as admin by simply calling `configure` first
- The admin keypair must be established through a governance-approved proposal
- Subsequent reconfiguration calls require the admin's signature

This prevents unauthorized privilege escalation at the protocol level.

## Operations

| Operation | Parameters | Purpose |
|-----------|-----------|---------|
| `configure` | `admin_did`, `admin_sig`, `proposal_id`, `issuers`, `threshold` | Set authorized issuers and minimum signature count. Initial call requires governance-approved `proposal_id`; subsequent calls require admin signature. |
| `mint` | `issuer_dids`, `signatures`, `token_id`, `recipient_did`, `tier?`, `schema_type?`, `metadata?`, `expiry_block?` | Mint a new CTZN token (backward-compatible with singular `issuer_did`/`signature_hex`) |
| `owner_of` | `token_id` | Get owner and full token status (burned, revoked, expired) |
| `total_supply` | - | Get global and per-tier supply counts |
| `get_metadata` | `token_id` | Get token metadata, tier, schema, and revocation/expiry status |
| `burn` | `issuer_did`, `signature_hex`, `token_id` | Permanently destroy a token |
| `revoke` | `issuer_did`, `signature_hex`, `token_id` | Issuer-revoke a token (keeps record, marks invalid) |
| `transfer` | (any) | Always rejected - CTZN tokens are non-transferable |
| `check_access` | `did`, `token_id?`, `required_tier?`, `required_schema?` | Verify a DID holds a qualifying token |

## Minting Flow

Minting requires signatures from authorized issuers meeting the configured threshold:

```json
{
  "operation": "mint",
  "issuer_dids": ["did:key:ed25519:issuer-a", "did:key:ed25519:issuer-b"],
  "signatures": ["sig_a_hex", "sig_b_hex"],
  "token_id": "degree-2026-001",
  "recipient_did": "did:key:ed25519:student",
  "tier": "gold",
  "schema_type": "degree",
  "metadata": {"university": "Example U", "degree": "BSc Computer Science"},
  "expiry_block": 500000
}
```

The module supports both multi-issuer (`issuer_dids` / `signatures` array) and singular (`issuer_did` / `signature_hex`) formats for backward compatibility.

## Access Control

The `check_access` operation supports two modes:

### Direct token lookup

```json
{
  "operation": "check_access",
  "did": "did:key:ed25519:user",
  "token_id": "degree-2026-001",
  "required_tier": "silver",
  "required_schema": "degree"
}
```

### Enumeration (find any qualifying token)

```json
{
  "operation": "check_access",
  "did": "did:key:ed25519:user",
  "required_tier": "gold",
  "required_schema": "reputation"
}
```

When `token_id` is omitted, the module scans all tokens held by the DID and returns the first match that satisfies the tier and schema requirements.

## State Keys

| Key Pattern | Content |
|-------------|---------|
| `config:admin` | Admin DID |
| `config:issuers` | Authorized issuer DID list |
| `config:threshold` | Minimum signature count |
| `owner:{token_id}` | Recipient DID |
| `meta:{token_id}` | JSON metadata blob |
| `tier:{token_id}` | Numeric tier (0/1/2) |
| `schema:{token_id}` | Schema type string |
| `expiry:{token_id}` | Expiry block height |
| `burned:{token_id}` | Burn marker |
| `revoked:{token_id}` | Revocation marker |
| `supply:{tier}` | Per-tier minted count |
| `total_supply` | Global minted count |
| `held:{did}` | Comma-separated token IDs |

## Building

```bash
cd citizen-protocol/modules/ctzn-token
RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
```

## Testing

```bash
cd citizen-protocol
cargo test -p citizen-execution --test integration_test -- ctzn
```

The integration test suite includes 22 CTZN-specific tests covering minting, multi-issuer threshold verification, governance gating, tiers, schemas, expiry, revocation, and access control.
