#![no_std]
#![no_main]

/// Admin Registry v2 — written with the Citizen Contract SDK.
///
/// Compare this file to `../admin-registry/src/lib.rs` (600 lines of raw WASM)
/// to see the DX improvement. Same functionality, 70% less code.

extern crate alloc;

#[global_allocator]
static ALLOC: citizen_contract_sdk::Allocator = citizen_contract_sdk::Allocator;

use alloc::vec::Vec;
use citizen_contract_sdk::prelude::*;
use citizen_contract_derive::contract;
use serde::{Serialize, Deserialize};

// ── State types (Solidity structs) ─────────────────────────────

#[derive(Serialize, Deserialize)]
struct AdminRecord {
    did: String,
    role: String,
    scope: String,
    assigned_by: String,
    revoked: bool,
}

impl ToString for AdminRecord {
    fn to_string(&self) -> String {
        format!("{}:{}", self.role, self.scope)
    }
}

// ── Contract module ────────────────────────────────────────────

#[contract]
mod contract {
    use super::*;

    // ── Init: governance-gated bootstrap ───────────────────────

    pub fn configure(ctx: Context) -> Result<Response> {
        let proposal_id: String = ctx.param("proposal_id")?;
        let bootstrap_did: String = ctx.param("bootstrap_admin_did")?;
        let role: String = ctx.param_or("role", "admin".into());
        let scope: String = ctx.param_or("scope", "national".into());

        let storage = ctx.storage();

        // Guard: already configured
        if storage.exists("config:initialized") {
            return Err(ContractError::msg("already configured"));
        }

        // Modifier: require governance approval
        ctx.require_governance(&proposal_id)?;

        // Store bootstrap admin
        let admins = storage.map::<String, AdminRecord>("admin");
        admins.save(&bootstrap_did, &AdminRecord {
            did: bootstrap_did.clone(),
            role: role.clone(),
            scope: scope.clone(),
            assigned_by: "governance".into(),
            revoked: false,
        })?;

        storage.set_str("config:initialized", "1")?;
        storage.set_str("admin_list", &bootstrap_did)?;

        // Event
        ctx.emit("AdminConfigured", &json!({
            "admin": bootstrap_did,
            "role": role,
            "scope": scope
        }));

        Ok(Response::success())
    }

    // ── Execute: assign a new admin (requires signature) ───────

    pub fn assign_admin(ctx: Context) -> Result<Response> {
        let admin_did: String = ctx.param("admin_did")?;
        let admin_sig: String = ctx.param("admin_sig")?;
        let target_did: String = ctx.param("target_did")?;
        let role: String = ctx.param_or("role", "admin".into());
        let scope: String = ctx.param_or("scope", "national".into());

        let storage = ctx.storage();
        let admins = storage.map::<String, AdminRecord>("admin");

        // Authorization: caller must be an active admin
        let caller: AdminRecord = admins
            .load(&admin_did)?
            .filter(|a| !a.revoked)
            .ok_or_else(|| ContractError::Unauthorized("caller is not an active admin".into()))?;

        // Signature verification
        let message = format!("assign_admin:{target_did}:{role}:{scope}");
        ctx.require_signature(&admin_did, &message, &admin_sig)?;

        // Write
        admins.save(&target_did, &AdminRecord {
            did: target_did.clone(),
            role: role.clone(),
            scope: scope.clone(),
            assigned_by: admin_did.clone(),
            revoked: false,
        })?;

        // Update admin list
        let mut list = storage.get_str("admin_list").unwrap_or_default();
        if !list.contains(&target_did) {
            if !list.is_empty() {
                list.push(',');
            }
            list.push_str(&target_did);
            storage.set_str("admin_list", &list)?;
        }

        ctx.emit("AdminAssigned", &json!({
            "admin": target_did,
            "role": role,
            "scope": scope,
            "assigned_by": admin_did
        }));

        Ok(Response::success())
    }

    // ── Execute: revoke an admin ───────────────────────────────

    pub fn revoke_admin(ctx: Context) -> Result<Response> {
        let admin_did: String = ctx.param("admin_did")?;
        let admin_sig: String = ctx.param("admin_sig")?;
        let target_did: String = ctx.param("target_did")?;

        let storage = ctx.storage();
        let admins = storage.map::<String, AdminRecord>("admin");

        // Authorization
        let _caller = admins
            .load(&admin_did)?
            .filter(|a| !a.revoked)
            .ok_or_else(|| ContractError::Unauthorized("not an active admin".into()))?;

        // Signature
        let message = format!("revoke_admin:{target_did}");
        ctx.require_signature(&admin_did, &message, &admin_sig)?;

        // Update record
        let mut target: AdminRecord = admins
            .load(&target_did)?
            .ok_or_else(|| ContractError::msg("target is not an admin"))?;
        target.revoked = true;
        admins.save(&target_did, &target)?;

        ctx.emit("AdminRevoked", &json!({"admin": target_did}));
        Ok(Response::success())
    }

    // ── Execute: set KYC encryption key ────────────────────────

    pub fn set_kyc_key(ctx: Context) -> Result<Response> {
        let admin_did: String = ctx.param("admin_did")?;
        let admin_sig: String = ctx.param("admin_sig")?;
        let public_key: String = ctx.param("public_key")?;

        let storage = ctx.storage();
        let admins = storage.map::<String, AdminRecord>("admin");

        // Authorization
        admins
            .load(&admin_did)?
            .filter(|a| !a.revoked)
            .ok_or_else(|| ContractError::Unauthorized("not an active admin".into()))?;

        // Signature
        let message = format!("set_kyc_key:{public_key}");
        ctx.require_signature(&admin_did, &message, &admin_sig)?;

        storage.set_str("kyc_key", &public_key)?;

        ctx.emit("KycKeySet", &json!({"set_by": admin_did}));
        Ok(Response::success())
    }

    // ── Query: check admin status ──────────────────────────────

    pub fn check_admin(ctx: Context) -> Result<Response> {
        let did: String = ctx.param("did")?;

        let admins = ctx.storage().map::<String, AdminRecord>("admin");
        let admin = admins.load(&did)?;

        let (is_admin, role, scope) = match admin {
            Some(a) if !a.revoked => (true, a.role, a.scope),
            _ => (false, String::new(), String::new()),
        };

        Ok(Response::data(json!({
            "is_admin": is_admin,
            "role": role,
            "scope": scope,
        })))
    }

    // ── Query: list all active admins ──────────────────────────

    pub fn list_admins(ctx: Context) -> Result<Response> {
        let storage = ctx.storage();
        let list = storage.get_str("admin_list").unwrap_or_default();
        let admins_map = storage.map::<String, AdminRecord>("admin");

        let mut active: Vec<serde_json::Value> = Vec::new();

        for did in list.split(',') {
            if did.is_empty() { continue; }
            if let Some(a) = admins_map.load(&did.to_string())? {
                if !a.revoked {
                    active.push(json!({
                        "did": a.did,
                        "role": a.role,
                        "scope": a.scope,
                    }));
                }
            }
        }

        Ok(Response::data(json!({
            "admins": active,
            "count": active.len(),
        })))
    }

    // ── Query: get KYC encryption key ──────────────────────────

    pub fn get_kyc_key(ctx: Context) -> Result<Response> {
        let key = ctx.storage().get_str("kyc_key");
        Ok(Response::data(json!({
            "public_key": key,
        })))
    }
}
