#![no_std]

//! # Citizen Module SDK
//!
//! Safe, zero-alloc wrappers around host functions for writing Citizen Protocol
//! WASM modules. Modules import the host functions via `extern "C"` declarations
//! and use the SDK's typed wrappers.
//!
//! ## Quick Start
//!
//! ```rust,ignore
//! use citizen_module_sdk::*;
//!
//! #[no_mangle] pub extern "C" fn alloc(size: u32) -> u32 {
//!     // your bump allocator
//! }
//!
//! #[no_mangle] pub extern "C" fn handle(ptr: u32, len: u32) -> u64 {
//!     let params = read_params_str(ptr, len);
//!     let op = field(params, "operation").unwrap_or("");
//!     let signer = field(params, "signer_did").unwrap_or("");
//!
//!     if verify_signature(signer, "0xabcd", "0x1234") {
//!         write_namespace_entry("records", r#"{"object_id":"rec1","payload":{"v":1}}"#);
//!         write_result_json(r#"{"ok":true}"#)
//!     } else {
//!         write_result_json(r#"{"ok":false,"reason":"bad sig"}"##)
//!     }
//! }
//! ```
//!
//! ## Cross-Contract Calls
//!
//! ```rust,ignore
//! let result = call_module("other-module", r#"{"query":"foo"}"#);
//! // result is Option<String> — None if module not found or call failed
//! ```

extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;

// --- Host function imports ---

extern "C" {
    #[link_name = "host_log"]
    fn _host_log(ptr: *const u8, len: u32);
    #[link_name = "host_read_namespace_entry"]
    fn _host_read_namespace_entry(
        ns_ptr: *const u8, ns_len: u32, eid_ptr: *const u8, eid_len: u32,
        out_ptr: *mut u8, out_len: u32,
    ) -> u64;
    #[link_name = "host_write_namespace_entry"]
    fn _host_write_namespace_entry(
        ns_ptr: *const u8, ns_len: u32,
        payload_ptr: *const u8, payload_len: u32,
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
    #[link_name = "host_call_module"]
    fn _host_call_module(
        target_ptr: *const u8, target_len: u32,
        params_ptr: *const u8, params_len: u32,
        out_ptr: *mut u8, out_len: u32,
    ) -> u64;
}

// --- Parameter reading ---

/// Read the raw parameter bytes from WASM memory.
pub fn read_params(ptr: u32, len: u32) -> &'static [u8] {
    unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) }
}

/// Convert WASM memory to a UTF-8 string reference.
pub fn read_params_str(ptr: u32, len: u32) -> &'static str {
    let raw = read_params(ptr, len);
    core::str::from_utf8(raw).unwrap_or("")
}

// --- JSON field extraction ---

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

/// Extract a u64 JSON field by name. Returns 0 if not found or unparseable.
pub fn field_u64(json: &str, name: &str) -> u64 {
    field(json, name)
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

/// Extract an i64 JSON field by name. Returns 0 if not found or unparseable.
pub fn field_i64(json: &str, name: &str) -> i64 {
    field(json, name)
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

/// Extract a bool JSON field by name (checks for `true`). Returns false otherwise.
pub fn field_bool(json: &str, name: &str) -> bool {
    field(json, name)
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

// --- Result packing ---

/// Pack a pointer and length into the `u64` return format expected by the engine.
/// Use this at the end of your `handle()` function after writing the result
/// into linear memory via your allocator.
#[inline]
pub fn pack_result(ptr: u32, len: u32) -> u64 {
    ((ptr as u64) << 32) | (len as u64)
}

/// Write a JSON result string into a buffer and return the packed result.
/// The buffer must be large enough to hold the JSON string.
pub fn write_result_to_buf(buf: &mut [u8], json: &str) -> u64 {
    let bytes = json.as_bytes();
    let written = bytes.len().min(buf.len());
    buf[..written].copy_from_slice(&bytes[..written]);
    pack_result(buf.as_ptr() as u32, written as u32)
}

// --- Host functions ---

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
/// Uses a dynamic `Vec<u8>` buffer for arbitrary-size responses.
pub fn read_namespace_entry(namespace: &str, entry_id: &str) -> Option<String> {
    read_namespace_entry_dynamic(namespace, entry_id, 8192)
}

/// Read a namespace entry with a caller-specified initial buffer size.
pub fn read_namespace_entry_dynamic(namespace: &str, entry_id: &str, initial_buf: usize) -> Option<String> {
    let mut buf: Vec<u8> = alloc::vec![0u8; initial_buf];
    loop {
        let packed = unsafe {
            _host_read_namespace_entry(
                namespace.as_ptr(), namespace.len() as u32,
                entry_id.as_ptr(), entry_id.len() as u32,
                buf.as_mut_ptr(), buf.len() as u32,
            )
        };
        let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
        let status = packed & 0xFFFF_FFFF;
        match status {
            0 if written > 0 && written <= buf.len() => {
                return Some(String::from_utf8_lossy(&buf[..written]).into_owned());
            }
            0 if written > buf.len() => {
                buf.resize(written, 0);
                continue;
            }
            _ => return None,
        }
    }
}

/// Write an entry to a namespace. The `payload_json` must include at least
/// `"object_id"` (string). Optional fields: `"action"` (defaults to
/// `"MODULE_WRITE"`), `"payload"` (the data to store).
///
/// Returns the receipt JSON on success, or `None` on error.
pub fn write_namespace_entry(namespace: &str, payload_json: &str) -> Option<String> {
    let mut buf: Vec<u8> = alloc::vec![0u8; 2048];
    loop {
        let packed = unsafe {
            _host_write_namespace_entry(
                namespace.as_ptr(), namespace.len() as u32,
                payload_json.as_ptr(), payload_json.len() as u32,
                buf.as_mut_ptr(), buf.len() as u32,
            )
        };
        let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
        let status = packed & 0xFFFF_FFFF;
        match status {
            0 if written > 0 && written <= buf.len() => {
                return Some(String::from_utf8_lossy(&buf[..written]).into_owned());
            }
            0 if written > buf.len() => {
                buf.resize(written, 0);
                continue;
            }
            0 => return Some(String::new()),
            _ => return None,
        }
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
/// Uses a dynamic buffer for arbitrary-size values.
pub fn load_state(key: &str) -> Option<String> {
    load_state_dynamic(key, 4096)
}

/// Load a value from module state with a caller-specified initial buffer size.
pub fn load_state_dynamic(key: &str, initial_buf: usize) -> Option<String> {
    let mut buf: Vec<u8> = alloc::vec![0u8; initial_buf];
    loop {
        let packed = unsafe {
            _host_load_state(
                key.as_ptr(), key.len() as u32,
                buf.as_mut_ptr(), buf.len() as u32,
            )
        };
        let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
        let status = packed & 0xFFFF_FFFF;
        match status {
            0 if written > 0 && written <= buf.len() => {
                return Some(String::from_utf8_lossy(&buf[..written]).into_owned());
            }
            0 if written > buf.len() => {
                buf.resize(written, 0);
                continue;
            }
            _ => return None,
        }
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

/// Execute another registered and activated module, returning its result.
/// Enables cross-contract composition.
///
/// Returns `None` if the target module is not found, not activated,
/// or if call depth is exceeded.
pub fn call_module(target_module_id: &str, params_json: &str) -> Option<String> {
    call_module_dynamic(target_module_id, params_json, 8192)
}

/// Cross-contract call with a caller-specified initial buffer size.
pub fn call_module_dynamic(target_module_id: &str, params_json: &str, initial_buf: usize) -> Option<String> {
    let mut buf: Vec<u8> = alloc::vec![0u8; initial_buf];
    loop {
        let packed = unsafe {
            _host_call_module(
                target_module_id.as_ptr(), target_module_id.len() as u32,
                params_json.as_ptr(), params_json.len() as u32,
                buf.as_mut_ptr(), buf.len() as u32,
            )
        };
        let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
        let status = packed & 0xFFFF_FFFF;
        match status {
            0 if written > 0 && written <= buf.len() => {
                return Some(String::from_utf8_lossy(&buf[..written]).into_owned());
            }
            0 if written > buf.len() => {
                buf.resize(written, 0);
                continue;
            }
            0 => return Some(String::new()),
            _ => return None,
        }
    }
}
