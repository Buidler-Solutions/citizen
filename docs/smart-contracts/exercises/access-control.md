# Exercise 3: Access Control

Build a role-based access control contract with an owner, admin management, and permission-gated operations. This exercise practices signature verification, role checks, and the fail-closed authorization pattern.

## Problem statement

Create an access control contract with the following operations:

| Operation | Parameters | Behavior |
|-----------|-----------|----------|
| `configure` | `proposal_id`, `owner_did` | Initialize the contract (governance-gated) |
| `assign_role` | `admin_did`, `admin_sig`, `target_did`, `role` | Assign a role to a DID (admin or owner only) |
| `revoke_role` | `admin_did`, `admin_sig`, `target_did` | Remove a role from a DID |
| `check_role` | `did` | Return the DID's role (or none) |
| `list_admins` | — | List all active admins |
| `protected_op` | `caller_did`, `caller_sig` | An operation only admins can call |

### Roles

| Role | Permissions |
|------|------------|
| `owner` | Everything: assign/revoke roles, call protected ops |
| `admin` | Assign/revoke roles (except owner), call protected ops |
| _(none)_ | Read-only (check_role, list_admins) |

### Requirements

1. `configure` requires governance approval (prevents self-appointment)
2. `assign_role` and `revoke_role` require a valid Ed25519 signature from an admin or owner
3. The owner role cannot be revoked
4. Only `admin` and `owner` can call `protected_op`
5. Signature messages must be operation-specific to prevent replay
6. `list_admins` returns only active (non-revoked) admins
7. Emit events on all mutations

## Starter code

```rust
#![no_std]
#![no_main]

extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;
use serde::{Serialize, Deserialize};

// TODO: Define AdminRecord type

#[contract]
mod contract {
    use super::*;

    // TODO: configure
    pub fn configure(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: assign_role
    pub fn assign_role(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: revoke_role
    pub fn revoke_role(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: check_role
    pub fn check_role(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: list_admins
    pub fn list_admins(ctx: Context) -> Result<Response> {
        todo!()
    }

    // TODO: protected_op
    pub fn protected_op(ctx: Context) -> Result<Response> {
        todo!()
    }
}
```

## Hints

??? tip "Hint 1: Data types"
    ```rust
    #[derive(Serialize, Deserialize)]
    struct AdminRecord {
        did: String,
        role: String,
        assigned_block: u64,
        revoked: bool,
    }
    ```

??? tip "Hint 2: Signature message format"
    Make messages operation-specific:
    ```rust
    let message = format!("assign_role:{target_did}:{role}");
    ctx.require_signature(&admin_did, &message, &admin_sig)?;
    ```

??? tip "Hint 3: Authorization helper"
    Create a helper to check if a DID is an active admin or owner:
    ```rust
    fn is_authorized(storage: &Storage, did: &str) -> bool {
        // Check owner
        if let Some(owner) = storage.get_str("owner") {
            if owner == did { return true; }
        }
        // Check admin map
        let admins = storage.map::<String, AdminRecord>("admin");
        if let Some(Some(admin)) = admins.load(&did.to_string()).ok() {
            return !admin.revoked;
        }
        false
    }
    ```

??? tip "Hint 4: Fail-closed pattern"
    Always return an error when authorization fails — never silently continue:
    ```rust
    if !is_authorized(&ctx.storage(), &admin_did) {
        return Err(ContractError::Unauthorized("not an active admin".into()));
    }
    ```

??? tip "Hint 5: Owner protection"
    Before revoking, check the target isn't the owner:
    ```rust
    let owner = ctx.storage().get_str("owner");
    if owner.as_deref() == Some(target_did) {
        return Err(ContractError::msg("cannot revoke owner role"));
    }
    ```

## Complete solution

```rust
#![no_std]
#![no_main]

extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
struct AdminRecord {
    did: String,
    role: String,
    assigned_block: u64,
    revoked: bool,
}

#[contract]
mod contract {
    use super::*;

    pub fn configure(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;
        let owner_did: String = ctx.param("owner_did")?;

        ctx.require_governance(&proposal_id)?;

        if ctx.storage().exists("owner") {
            return Err(ContractError::msg("already configured"));
        }

        let block = ctx.block_height();

        ctx.storage().set_str("owner", &owner_did)?;
        ctx.storage().set_str("admin_list", &owner_did)?;

        // Owner is also an admin record
        let admins = ctx.storage().map::<String, AdminRecord>("admin");
        admins.save(&owner_did, &AdminRecord {
            did: owner_did.clone(),
            role: "owner".into(),
            assigned_block: block,
            revoked: false,
        })?;

        ctx.emit("ContractConfigured", &json!({"owner": owner_did}));
        Ok(Response::success())
    }

    pub fn assign_role(ctx: Context) -> Result<Response> {
        let admin_did: String = ctx.param("admin_did")?;
        let admin_sig: String = ctx.param("admin_sig")?;
        let target_did: String = ctx.param("target_did")?;
        let role: String = ctx.param_or("role", "admin".into());

        // ── Authorization: caller must be active admin ──
        let storage = ctx.storage();
        let admins = storage.map::<String, AdminRecord>("admin");

        let _caller = admins.load(&admin_did)?
            .filter(|a| !a.revoked)
            .ok_or_else(|| ContractError::Unauthorized("not an active admin".into()))?;

        // ── Signature verification (replay-safe) ──
        let message = format!("assign_role:{target_did}:{role}");
        ctx.require_signature(&admin_did, &message, &admin_sig)?;

        // ── Business rules ──
        if role != "admin" && role != "owner" {
            return Err(ContractError::msg("invalid role"));
        }

        let block = ctx.block_height();

        // Save admin record
        admins.save(&target_did, &AdminRecord {
            did: target_did.clone(),
            role: role.clone(),
            assigned_block: block,
            revoked: false,
        })?;

        // Update index
        let mut list = storage.get_str("admin_list").unwrap_or_default();
        if !list.split(',').any(|d| d == target_did.as_str()) {
            if !list.is_empty() { list.push(','); }
            list.push_str(&target_did);
            storage.set_str("admin_list", &list)?;
        }

        ctx.emit("RoleAssigned", &json!({
            "target": target_did,
            "role": role,
            "assigned_by": admin_did,
            "block": block
        }));

        Ok(Response::data(json!({
            "did": target_did,
            "role": role
        })))
    }

    pub fn revoke_role(ctx: Context) -> Result<Response> {
        let admin_did: String = ctx.param("admin_did")?;
        let admin_sig: String = ctx.param("admin_sig")?;
        let target_did: String = ctx.param("target_did")?;

        // ── Authorization ──
        let storage = ctx.storage();
        let admins = storage.map::<String, AdminRecord>("admin");

        let _caller = admins.load(&admin_did)?
            .filter(|a| !a.revoked)
            .ok_or_else(|| ContractError::Unauthorized("not an active admin".into()))?;

        // ── Signature ──
        let message = format!("revoke_role:{target_did}");
        ctx.require_signature(&admin_did, &message, &admin_sig)?;

        // ── Owner protection ──
        let owner = storage.get_str("owner");
        if owner.as_deref() == Some(target_did.as_str()) {
            return Err(ContractError::msg("cannot revoke owner role"));
        }

        // ── Mark as revoked ──
        let mut record = admins.load(&target_did)?
            .ok_or_else(|| ContractError::msg("target is not an admin"))?;

        record.revoked = true;
        admins.save(&target_did, &record)?;

        ctx.emit("RoleRevoked", &json!({
            "target": target_did,
            "revoked_by": admin_did,
            "block": ctx.block_height()
        }));

        Ok(Response::data(json!({
            "revoked": target_did
        })))
    }

    pub fn check_role(ctx: Context) -> Result<Response> {
        let did: String = ctx.param("did")?;

        let admins = ctx.storage().map::<String, AdminRecord>("admin");
        let record = admins.load(&did)?;

        match record {
            Some(admin) if !admin.revoked => {
                Ok(Response::data(json!({
                    "did": did,
                    "role": admin.role,
                    "active": true,
                    "assigned_block": admin.assigned_block
                })))
            }
            Some(admin) => {
                Ok(Response::data(json!({
                    "did": did,
                    "role": admin.role,
                    "active": false,
                    "revoked": true
                })))
            }
            None => {
                Ok(Response::data(json!({
                    "did": did,
                    "role": null,
                    "active": false
                })))
            }
        }
    }

    pub fn list_admins(ctx: Context) -> Result<Response> {
        let storage = ctx.storage();
        let list = storage.get_str("admin_list").unwrap_or_default();
        let admins = storage.map::<String, AdminRecord>("admin");

        let mut result = Vec::new();
        for did in list.split(',') {
            if did.is_empty() { continue; }
            if let Some(admin) = admins.load(&did.to_string())? {
                if !admin.revoked {
                    result.push(json!({
                        "did": admin.did,
                        "role": admin.role,
                        "assigned_block": admin.assigned_block
                    }));
                }
            }
        }

        Ok(Response::data(json!({
            "admins": result,
            "count": result.len()
        })))
    }

    pub fn protected_op(ctx: Context) -> Result<Response> {
        let caller_did: String = ctx.param("caller_did")?;
        let caller_sig: String = ctx.param("caller_sig")?;

        // ── Authorization: must be active admin ──
        let admins = ctx.storage().map::<String, AdminRecord>("admin");
        let caller = admins.load(&caller_did)?
            .filter(|a| !a.revoked)
            .ok_or_else(|| ContractError::Unauthorized("not authorized".into()))?;

        // ── Signature ──
        let message = format!("protected_op:{}", ctx.block_height());
        ctx.require_signature(&caller_did, &message, &caller_sig)?;

        ctx.emit("ProtectedOpExecuted", &json!({
            "caller": caller_did,
            "role": caller.role,
            "block": ctx.block_height()
        }));

        Ok(Response::data(json!({
            "executed": true,
            "by": caller_did,
            "role": caller.role
        })))
    }
}
```

## Test cases

```python
#!/usr/bin/env python3
"""Integration test for access control exercise."""
import json, urllib.request
import nacl.signing, nacl.hash, nacl.encoding

BASE = "http://127.0.0.1:8091"

def execute(module_id, params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/modules/{module_id}/execute",
        data=data, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())

# Generate test keys
admin_key = nacl.signing.SigningKey.generate()
admin_did = f"did:key:ed25519:{admin_key.verify_key.encode(encoder=nacl.encoding.RawEncoder).hex()}"
user_key = nacl.signing.SigningKey.generate()
user_did = f"did:key:ed25519:{user_key.verify_key.encode(encoder=nacl.encoding.RawEncoder).hex()}"

def sign(key, message):
    return key.sign(message.encode()).signature.hex()

# Test 1: Check role — unknown user
result = execute("access-control", {"operation": "check_role", "did": user_did})
assert result["result"]["active"] is False
assert result["result"]["role"] is None
print("✓ Unknown user has no role")

# Test 2: Assign role (admin signs)
assign_msg = f"assign_role:{user_did}:admin"
result = execute("access-control", {
    "operation": "assign_role",
    "admin_did": admin_did,
    "admin_sig": sign(admin_key, assign_msg),
    "target_did": user_did,
    "role": "admin"
})
assert result["success"]
print("✓ Assigned admin role to user")

# Test 3: Check role — now active
result = execute("access-control", {"operation": "check_role", "did": user_did})
assert result["result"]["active"] is True
assert result["result"]["role"] == "admin"
print("✓ User is now an active admin")

# Test 4: Revoke role
revoke_msg = f"revoke_role:{user_did}"
result = execute("access-control", {
    "operation": "revoke_role",
    "admin_did": admin_did,
    "admin_sig": sign(admin_key, revoke_msg),
    "target_did": user_did
})
assert result["success"]
print("✓ Revoked user's role")

# Test 5: Check role — now inactive
result = execute("access-control", {"operation": "check_role", "did": user_did})
assert result["result"]["active"] is False
print("✓ User's role is now inactive")

# Test 6: Unauthorized assign fails
result = execute("access-control", {
    "operation": "assign_role",
    "admin_did": "did:key:ed25519:nobody",
    "admin_sig": "0000",
    "target_did": user_did,
    "role": "admin"
})
assert not result["success"]
print("✓ Unauthorized caller correctly rejected")

print("\nAll tests passed!")
```

## Key concepts learned

- **Signature verification** — `ctx.require_signature()` with operation-specific messages
- **Replay prevention** — Messages include operation name, target, and role
- **Fail-closed pattern** — `filter(!revoked)` + `ok_or_else(error)` ensures denied access
- **Role hierarchy** — Owner > admin > none
- **Owner protection** — Cannot revoke the contract owner
- **Soft delete** — Marking records as `revoked: true` instead of deleting

## Next exercise

[Exercise 4: Voting →](voting.md)
