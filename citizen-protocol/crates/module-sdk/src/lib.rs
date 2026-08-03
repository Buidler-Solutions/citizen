#![no_std]

//! # Citizen Module SDK
//!
//! Safe, zero-alloc wrappers around host functions for writing Citizen Protocol
//! WASM modules. Modules import the host functions via `extern "C"` declarations
//! and use the SDK's typed wrappers.
//!
//! ```rust,ignore
//! use citizen_module_sdk::*;
//!
//! #[no_mangle] pub extern "C" fn handle(ptr: u32, len: u32) -> u64 {
//!     let params = read_params(ptr, len);
//!     let op = field(&params, "operation").unwrap_or("");
//!     let did = field(&params, "signer_did").unwrap_or("");
//!     let valid = verify_signature(did, "...", "...");
//!     // ... respond with manual write_result ...
//! }
//! ```

extern crate alloc;
use alloc::string::String;

// --- Host function imports (module must also declare these) ---

extern "C" {
    #[link_name = "host_log"]
    fn _host_log(ptr: *const u8, len: u32);
    #[link_name = "host_read_namespace_entry"]
    fn _host_read_namespace_entry(
        ns_ptr: *const u8, ns_len: u32, eid_ptr: *const u8, eid_len: u32,
        out_ptr: *mut u8, out_len: u32,
    ) -> u64;
    #[link_name = "host_verify_signature"]
    fn _host_verify_signature(
        did_ptr: *const u8, did_len: u32,
        msg_ptr: *const u8, msg_len: u32,
        sig_ptr: *const u8, sig_len: u32,
    ) -> u32;
    #[link_name = "host_verify_signature_batch"]
    fn _host_verify_signature_batch(json_ptr: *const u8, json_len: u32) -> u32;
    #[link_name = "host_check_governance_approval"]
    fn _host_check_governance_approval(pid_ptr: *const u8, pid_len: u32) -> u32;
    #[link_name = "host_current_block_height"]
    fn _host_current_block_height() -> u64;
    #[link_name = "host_store_state"]
    fn _host_store_state(
        key_ptr: *const u8, key_len: u32,
        val_ptr: *const u8, val_len: u32,
    ) -> u32;
    #[link_name = "host_load_state"]
    fn _host_load_state(
        key_ptr: *const u8, key_len: u32,
        out_ptr: *mut u8, out_len: u32,
    ) -> u64;
}

// --- Public API ---

/// Read the raw parameter bytes from WASM memory.
pub fn read_params(ptr: u32, len: u32) -> &'static [u8] {
    unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) }
}

/// Convert WASM memory to a UTF-8 string reference.
pub fn read_params_str(ptr: u32, len: u32) -> &'static str {
    let raw = read_params(ptr, len);
    core::str::from_utf8(raw).unwrap_or("")
}

/// Extract a JSON field value by name. No heap allocation.
pub fn field<'a>(json: &'a str, name: &str) -> Option<&'a str> {
    let s = json.trim();
    if !s.starts_with('{') || !s.ends_with('}') { return None; }
    let inner = &s[1..s.len() - 1];
    let bytes = inner.as_bytes();
    let mut i = 0;
    let max = bytes.len();
    while i < max {
        while i < max && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= max || bytes[i] == b'}' { break; }
        if bytes[i] != b'"' { return None; }
        i += 1;
        let key_start = i;
        while i < max && bytes[i] != b'"' {
            if bytes[i] == b'\\' { i += 1; }
            i += 1;
        }
        if i >= max { return None; }
        let key = &inner[key_start..i];
        i += 1;
        while i < max && (bytes[i].is_ascii_whitespace() || bytes[i] == b':') { i += 1; }
        if i >= max { return None; }
        let val_start = i;
        let is_target = key.as_bytes() == name.as_bytes();
        if bytes[i] == b'"' {
            i += 1;
            while i < max && bytes[i] != b'"' {
                if bytes[i] == b'\\' { i += 1; }
                i += 1;
            }
            i += 1;
            if is_target { return Some(&inner[val_start + 1..i - 1]); }
        } else {
            while i < max && bytes[i] != b',' && bytes[i] != b'}' { i += 1; }
            if is_target { return Some(&inner[val_start..i]); }
        }
        if i < max && bytes[i] == b',' { i += 1; }
    }
    None
}

/// Log a message to the engine's log collector.
pub fn log(msg: &str) {
    let b = msg.as_bytes();
    unsafe { _host_log(b.as_ptr(), b.len() as u32); }
}

/// Verify a signature from a signer DID.
pub fn verify_signature(signer_did: &str, message_hex: &str, signature_hex: &str) -> bool {
    unsafe {
        _host_verify_signature(
            signer_did.as_ptr(), signer_did.len() as u32,
            message_hex.as_ptr(), message_hex.len() as u32,
            signature_hex.as_ptr(), signature_hex.len() as u32,
        ) == 1
    }
}

/// Read a namespace entry, returning its JSON payload.
pub fn read_namespace_entry(namespace: &str, entry_id: &str) -> Option<String> {
    let mut buf = [0u8; 1024];
    let packed = unsafe {
        _host_read_namespace_entry(
            namespace.as_ptr(), namespace.len() as u32,
            entry_id.as_ptr(), entry_id.len() as u32,
            buf.as_mut_ptr(), buf.len() as u32,
        )
    };
    let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
    let status = packed & 0xFFFF_FFFF;
    if status == 0 && written > 0 && written <= buf.len() {
        Some(String::from_utf8_lossy(&buf[..written]).into_owned())
    } else {
        None
    }
}

/// Store a key-value pair in module persistent state. Returns true on success.
pub fn store_state(key: &str, value: &str) -> bool {
    unsafe {
        _host_store_state(
            key.as_ptr(), key.len() as u32,
            value.as_ptr(), value.len() as u32,
        ) == 0
    }
}

/// Load a value from module persistent state. Returns None if not found.
pub fn load_state(key: &str) -> Option<String> {
    let mut buf = [0u8; 1024];
    let packed = unsafe {
        _host_load_state(
            key.as_ptr(), key.len() as u32,
            buf.as_mut_ptr(), buf.len() as u32,
        )
    };
    let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
    let status = packed & 0xFFFF_FFFF;
    if status == 0 && written > 0 && written <= buf.len() {
        Some(String::from_utf8_lossy(&buf[..written]).into_owned())
    } else {
        None
    }
}

/// Get the current block height.
pub fn current_block_height() -> u64 {
    unsafe { _host_current_block_height() }
}

/// Check if a governance proposal has been approved.
pub fn check_governance_approval(proposal_id: &str) -> bool {
    unsafe { _host_check_governance_approval(proposal_id.as_ptr(), proposal_id.len() as u32) == 1 }
}

/// Verify a batch of signatures in a single host call.
/// Takes a JSON array: `[{"signer_did":"...","message_hex":"...","signature_hex":"..."}]`
/// Returns the count of valid signatures.
pub fn verify_signature_batch(batch_json: &str) -> u32 {
    unsafe { _host_verify_signature_batch(batch_json.as_ptr(), batch_json.len() as u32) }
}
