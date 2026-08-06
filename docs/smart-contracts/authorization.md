# Authorization

Citizen contracts have three built-in authorization mechanisms. These are the Solidity `modifier` equivalents.

## 1. Signature verification

Verify that the caller signed a specific message with their Ed25519 key:

```rust
pub fn assign_admin(ctx: Context) -> Result<Response> {
    let admin_did: String = ctx.param("admin_did")?;
    let admin_sig: String = ctx.param("admin_sig")?;
    let target_did: String = ctx.param("target_did")?;

    // Verify the caller signed this exact message
    let message = format!("assign_admin:{target_did}");
    ctx.require_signature(&admin_did, &message, &admin_sig)?;

    // If we get here, the signature is valid
    // ...

    Ok(Response::success())
}
```

### How it works

1. The caller (e.g., a wallet extension) signs the message string with their private key
2. The signature is hex-encoded and passed as a parameter
3. `ctx.require_signature()` calls `host_verify_signature` which:
   - Extracts the Ed25519 public key from the DID
   - Hex-decodes the message and signature
   - Verifies with `ed25519-dalek` `verify_strict`

### Signature message conventions

The message should be **deterministic and operation-specific** to prevent replay attacks:

```rust
// Good: includes operation name and all relevant parameters
let message = format!("assign_admin:{target_did}:{role}:{scope}");

// Good: includes operation name and target
let message = format!("revoke_admin:{target_did}");

// Good: includes operation name and value
let message = format!("set_kyc_key:{public_key}");

// Bad: generic message, could be replayed for a different operation
let message = format!("authorized");
```

### Client-side signing

The wallet extension provides signing methods:

```typescript
// Browser extension (dApp)
const message = `assign_admin:${targetDid}:${role}:${scope}`;
const result = await provider.request({
  method: "ctzn_signAuthChallenge",
  params: [message],
});
// result.signature is base64url — convert to hex for the contract
const sigHex = Array.from(atob(result.signature.replace(/-/g,'+').replace(/_/g,'/')))
  .map(b => b.toString(16).padStart(2, '0')).join('');
```

### Manual verification (low-level)

```rust
use citizen_contract_sdk::prelude::*;

let msg_hex = hex_encode(message.as_bytes());
let valid = verify_signature(&signer_did, &msg_hex, &sig_hex);
if !valid {
    return Err(ContractError::Unauthorized("bad signature".into()));
}
```

## 2. Governance approval

Require an on-chain governance proposal to be approved:

```rust
pub fn configure(ctx: Context) -> Result<Response> {
    let proposal_id: String = ctx.param("proposal_id")?;

    // Will fail if proposal is not approved in the governance namespace
    ctx.require_governance(&proposal_id)?;

    // Bootstrap logic only governance can authorize
    let admin: String = ctx.param("bootstrap_admin")?;
    ctx.storage().set_str("admin", &admin)?;

    Ok(Response::success())
}
```

### How it works

`require_governance` calls `host_check_governance_approval` which scans the `governance` namespace for an `APPROVED` entry with the given `object_id`. This is a **fail-closed** check — if no approval entry exists, the function returns `false`.

```rust
// This is what the host function does internally:
fn check_governance_approval(&self, proposal_id: &str) -> bool {
    let entries = read_namespace("governance");
    entries.iter().any(|e| e.object_id == proposal_id && e.action == "APPROVED")
}
```

### Submitting a governance approval

```python
# Submit a proposal
submit("governance", "PROPOSE", "proposal-123", {
    "title": "Deploy my contract",
    "proposed_by": governance_did,
})

# Approve it
submit("governance", "APPROVED", "proposal-123", {
    "proposal_id": "proposal-123",
    "approved_by": governance_did,
})
```

## 3. Storage-based role checks

Check that a key exists in contract state (custom authorization):

```rust
pub fn admin_only_op(ctx: Context) -> Result<Response> {
    let caller_did: String = ctx.param("caller")?;

    // Check if caller is in the admin map
    let admins = ctx.storage().map::<String, AdminRecord>("admin");
    let admin = admins.load(&caller_did)?
        .filter(|a| !a.revoked)
        .ok_or_else(|| ContractError::Unauthorized("not an active admin".into()))?;

    // Proceed with admin logic
    Ok(Response::success())
}
```

### Pattern: Multi-role authorization

```rust
pub fn sensitive_op(ctx: Context) -> Result<Response> {
    let caller: String = ctx.param("caller")?;
    let roles = ctx.storage().map::<String, String>("role");

    match roles.load(&caller)? {
        Some(role) if role == "super-admin" => {
            // Full access
        }
        Some(role) if role == "admin" => {
            // Limited access
        }
        _ => return Err(ContractError::Unauthorized("insufficient role".into())),
    }

    Ok(Response::success())
}
```

### Pattern: Existence check

```rust
pub fn guarded_op(ctx: Context) -> Result<Response> {
    // Simple: just check if a storage key exists
    ctx.require_exists("config:initialized")?;

    Ok(Response::success())
}
```

## Combining authorization methods

Most real contracts combine multiple checks:

```rust
pub fn assign_admin(ctx: Context) -> Result<Response> {
    let admin_did: String = ctx.param("admin_did")?;
    let admin_sig: String = ctx.param("admin_sig")?;
    let target_did: String = ctx.param("target_did")?;

    let admins = ctx.storage().map::<String, AdminRecord>("admin");

    // 1. Check role (storage-based)
    let caller = admins.load(&admin_did)?
        .filter(|a| !a.revoked)
        .ok_or_else(|| ContractError::Unauthorized("not an active admin".into()))?;

    // 2. Verify signature (cryptographic)
    let message = format!("assign_admin:{target_did}");
    ctx.require_signature(&admin_did, &message, &admin_sig)?;

    // 3. Proceed
    admins.save(&target_did, &AdminRecord { ... })?;

    Ok(Response::success())
}
```

## Batch signature verification

For operations that need to verify multiple signatures efficiently:

```rust
use citizen_contract_sdk::prelude::*;

pub fn multi_sig(ctx: Context) -> Result<Response> {
    // Build batch JSON: [{"did":"...","message_hex":"...","signature_hex":"..."},...]
    let batch = r#"[
        {"did":"did:key:...","message_hex":"68656c6c6f","signature_hex":"..."},
        {"did":"did:key:...","message_hex":"776f726c64","signature_hex":"..."}
    ]"#;

    let valid_count = verify_signature_batch(batch);

    if valid_count >= 2 {
        // Threshold met
        Ok(Response::success())
    } else {
        Err(ContractError::Unauthorized("insufficient signatures".into()))
    }
}
```

## Next steps

- [Events](events.md) — Emit structured data for indexing
- [Cross-Contract Calls](cross-contract.md) — Call other contracts
