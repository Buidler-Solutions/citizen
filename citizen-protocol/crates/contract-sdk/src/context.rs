//! Execution context — the Solidity `msg.*` equivalent.
//!
//! [`Context`] provides typed parameter extraction, authorization helpers
//! (modifiers), storage access, and event emission.

use crate::api::*;
use crate::storage::Storage;
use crate::{ContractError, read_memory};
use alloc::string::String;
use alloc::string::ToString;
use alloc::format;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Execution context passed to every contract entry point.
///
/// Holds the parsed JSON parameters and provides ergonomic access to
/// host functions, storage, and authorization checks.
pub struct Context {
    params: Value,
}

impl Context {
    /// Create a context from parsed JSON parameters.
    pub fn from_json(params: Value) -> Self {
        Self { params }
    }

    /// Parse parameters from WASM memory and extract the operation name.
    /// Returns `None` if the input is not valid JSON.
    pub fn parse(ptr: u32, len: u32) -> Option<(Self, String)> {
        let s = read_memory(ptr, len);
        let json: Value = serde_json::from_str(&s).ok()?;
        let op = json
            .get("operation")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Some((Self::from_json(json), op))
    }

    // ── Parameter extraction ──

    /// Extract a typed parameter (required). Errors if missing or wrong type.
    ///
    /// ```ignore
    /// let did: String = ctx.param("did")?;
    /// let amount: u64 = ctx.param("amount")?;
    /// ```
    pub fn param<T: DeserializeOwned>(&self, key: &str) -> Result<T, ContractError> {
        let val = self
            .params
            .get(key)
            .ok_or_else(|| ContractError::Param(format!("missing parameter: {key}")))?;
        serde_json::from_value(val.clone())
            .map_err(|e| ContractError::Param(format!("invalid {key}: {e}")))
    }

    /// Extract a typed parameter with a default value.
    ///
    /// ```ignore
    /// let role: String = ctx.param_or("role", "admin".into());
    /// ```
    pub fn param_or<T: DeserializeOwned>(&self, key: &str, default: T) -> T {
        match self.params.get(key) {
            Some(val) => serde_json::from_value(val.clone()).unwrap_or(default),
            None => default,
        }
    }

    /// Extract an optional typed parameter.
    ///
    /// ```ignore
    /// let expiry: Option<u64> = ctx.param_opt("expiry_block")?;
    /// ```
    pub fn param_opt<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, ContractError> {
        match self.params.get(key) {
            Some(val) => {
                let parsed = serde_json::from_value(val.clone())
                    .map_err(|e| ContractError::Param(format!("invalid {key}: {e}")))?;
                Ok(Some(parsed))
            }
            None => Ok(None),
        }
    }

    /// Raw JSON value access for a parameter key.
    pub fn raw_param(&self, key: &str) -> Option<&Value> {
        self.params.get(key)
    }

    // ── Block context ──

    /// Current block height (Solidity `block.number`).
    pub fn block_height(&self) -> u64 {
        current_block_height()
    }

    // ── Storage ──

    /// Get a storage accessor (Solidity state variable access).
    pub fn storage(&self) -> Storage {
        Storage
    }

    // ── Authorization (Solidity modifiers) ──

    /// Require governance approval for a proposal ID.
    /// Solidity equivalent: `require(governanceApproved(proposalId))`.
    pub fn require_governance(&self, proposal_id: &str) -> Result<(), ContractError> {
        if !check_governance(proposal_id) {
            return Err(ContractError::Unauthorized(format!(
                "governance proposal '{proposal_id}' not approved"
            )));
        }
        Ok(())
    }

    /// Verify an Ed25519 signature on-chain.
    /// Solidity equivalent: `require(verify(did, message, sig))`.
    ///
    /// - `signer_did`: DID of the purported signer
    /// - `message`: plain-text message that was signed
    /// - `signature_hex`: hex-encoded Ed25519 signature
    pub fn require_signature(
        &self,
        signer_did: &str,
        message: &str,
        signature_hex: &str,
    ) -> Result<(), ContractError> {
        let msg_hex = hex_encode(message.as_bytes());
        if !verify_signature(signer_did, &msg_hex, signature_hex) {
            return Err(ContractError::Unauthorized(
                "signature verification failed".into(),
            ));
        }
        Ok(())
    }

    /// Require that a storage key exists (simple admin/role check).
    /// For custom authorization, use `storage().get()` directly.
    pub fn require_exists(&self, key: &str) -> Result<(), ContractError> {
        if !load_state(key).is_some() {
            return Err(ContractError::Unauthorized(format!(
                "access denied: '{key}' not found"
            )));
        }
        Ok(())
    }

    // ── Events ──

    /// Emit a named event with JSON data. Visible in node logs and receipts.
    /// Solidity equivalent: `emit AdminAssigned(admin)`.
    pub fn emit(&self, event_name: &str, data: &Value) {
        let json_str = serde_json::to_string(data).unwrap_or_default();
        let msg = format!("[event:{event_name}]: {json_str}");
        log_str(&msg);
    }
}
