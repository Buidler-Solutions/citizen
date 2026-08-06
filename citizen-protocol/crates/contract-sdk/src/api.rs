//! Host function FFI bindings — raw extern declarations and ergonomic wrappers.
//!
//! These are the Citizen Protocol WASM host functions exposed to smart contracts
//! during execution. Each function is imported from the `"env"` module and
//! validated by the execution engine's import whitelist.

use alloc::string::String;

use alloc::vec::Vec;

// ── Host function imports (match execution engine whitelist exactly) ──

extern "C" {
    fn host_log(ptr: *const u8, len: u32);
    fn host_read_namespace_entry(
        ns_ptr: *const u8, ns_len: u32,
        eid_ptr: *const u8, eid_len: u32,
        out_ptr: *mut u8, out_len: u32,
    ) -> u64;
    fn host_write_namespace_entry(
        ns_ptr: *const u8, ns_len: u32,
        payload_ptr: *const u8, payload_len: u32,
    ) -> u32;
    fn host_verify_signature(
        did_ptr: *const u8, did_len: u32,
        msg_ptr: *const u8, msg_len: u32,
        sig_ptr: *const u8, sig_len: u32,
    ) -> u32;
    fn host_check_governance_approval(
        pid_ptr: *const u8, pid_len: u32,
    ) -> u32;
    fn host_verify_signature_batch(
        batch_ptr: *const u8, batch_len: u32,
    ) -> u32;
    fn host_current_block_height() -> u64;
    fn host_store_state(
        key_ptr: *const u8, key_len: u32,
        val_ptr: *const u8, val_len: u32,
    ) -> u32;
    fn host_load_state(
        key_ptr: *const u8, key_len: u32,
        out_ptr: *mut u8, out_len: u32,
    ) -> u64;
    fn host_call_module(
        target_ptr: *const u8, target_len: u32,
        params_ptr: *const u8, params_len: u32,
    ) -> u64;
}

// ── Ergonomic wrappers ──

/// Store a key-value pair in contract state. Returns `true` on success.
pub fn store_state(key: &str, value: &str) -> bool {
    unsafe {
        host_store_state(
            key.as_ptr(), key.len() as u32,
            value.as_ptr(), value.len() as u32,
        ) == 0
    }
}

/// Load a value from contract state by key. Returns `None` if not found.
pub fn load_state(key: &str) -> Option<String> {
    let mut buf: [u8; 1024] = [0; 1024];
    let packed = unsafe {
        host_load_state(
            key.as_ptr(), key.len() as u32,
            buf.as_mut_ptr(), buf.len() as u32,
        )
    };
    let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
    let status = packed & 0xFFFF_FFFF;
    if status == 0 && written > 0 && written <= buf.len() {
        let s = core::str::from_utf8(&buf[..written]).unwrap_or("");
        Some(String::from(s))
    } else {
        None
    }
}

/// Verify an Ed25519 signature on-chain.
///
/// - `signer_did`: The DID of the purported signer (e.g. `did:key:ed25519:...`)
/// - `message_hex`: Hex-encoded message bytes
/// - `signature_hex`: Hex-encoded signature bytes
///
/// Returns `true` if the signature is valid for the given DID and message.
pub fn verify_signature(signer_did: &str, message_hex: &str, signature_hex: &str) -> bool {
    unsafe {
        host_verify_signature(
            signer_did.as_ptr(), signer_did.len() as u32,
            message_hex.as_ptr(), message_hex.len() as u32,
            signature_hex.as_ptr(), signature_hex.len() as u32,
        ) == 1
    }
}

/// Check whether a governance proposal has been approved on-chain.
///
/// Returns `true` if the proposal with the given ID has an explicit
/// `APPROVED` entry in the `governance` namespace.
pub fn check_governance(proposal_id: &str) -> bool {
    unsafe {
        host_check_governance_approval(
            proposal_id.as_ptr(), proposal_id.len() as u32,
        ) == 1
    }
}

/// Get the current block height.
pub fn current_block_height() -> u64 {
    unsafe { host_current_block_height() }
}

/// Emit a log message visible in node logs and execution receipts.
pub fn log_str(msg: &str) {
    unsafe { host_log(msg.as_ptr(), msg.len() as u32); }
}

/// Read an entry from any namespace on the ledger.
///
/// Returns the entry payload as a JSON string, or `None` if not found.
pub fn read_namespace_entry(namespace: &str, entry_id: &str) -> Option<String> {
    let mut buf: [u8; 4096] = [0; 4096];
    let packed = unsafe {
        host_read_namespace_entry(
            namespace.as_ptr(), namespace.len() as u32,
            entry_id.as_ptr(), entry_id.len() as u32,
            buf.as_mut_ptr(), buf.len() as u32,
        )
    };
    let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
    let status = packed & 0xFFFF_FFFF;
    if status == 0 && written > 0 && written <= buf.len() {
        let s = core::str::from_utf8(&buf[..written]).unwrap_or("");
        Some(String::from(s))
    } else {
        None
    }
}

/// Write an entry to any namespace on the ledger (requires authorization).
///
/// Returns `true` on success.
pub fn write_namespace_entry(namespace: &str, payload_json: &str) -> bool {
    unsafe {
        host_write_namespace_entry(
            namespace.as_ptr(), namespace.len() as u32,
            payload_json.as_ptr(), payload_json.len() as u32,
        ) == 0
    }
}

/// Verify a batch of signatures in a single host call.
///
/// `batch_json` is a JSON array of `{ did, message_hex, signature_hex }` objects.
/// Returns the number of valid signatures.
pub fn verify_signature_batch(batch_json: &str) -> u32 {
    unsafe {
        host_verify_signature_batch(
            batch_json.as_ptr(), batch_json.len() as u32,
        )
    }
}

/// Call another activated module (cross-contract call).
///
/// Returns the module's JSON response, or `None` if the call failed.
pub fn call_module(target_module_id: &str, params_json: &str) -> Option<String> {
    let mut buf: [u8; 8192] = [0; 8192];
    let packed = unsafe {
        host_call_module(
            target_module_id.as_ptr(), target_module_id.len() as u32,
            params_json.as_ptr(), params_json.len() as u32,
        )
    };
    let ptr = ((packed >> 32) & 0xFFFF_FFFF) as u32;
    let len = (packed & 0xFFFF_FFFF) as usize;
    if ptr != 0 && len > 0 && len <= buf.len() {
        unsafe {
            core::ptr::copy_nonoverlapping(ptr as *const u8, buf.as_mut_ptr(), len);
        }
        let s = core::str::from_utf8(&buf[..len]).unwrap_or("");
        Some(String::from(s))
    } else {
        None
    }
}

/// Encode bytes to a hex string (needed for `host_verify_signature` message format).
pub fn hex_encode(input: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(input.len() * 2);
    for &b in input {
        result.push(HEX[(b >> 4) as usize] as char);
        result.push(HEX[(b & 0xf) as usize] as char);
    }
    result
}
