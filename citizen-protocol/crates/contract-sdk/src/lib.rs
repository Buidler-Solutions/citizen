//! Citizen Contract SDK — runtime library for WASM smart contracts.
//!
//! Provides Solidity-like ergonomics for writing Citizen Protocol smart contracts
//! that compile to `wasm32-unknown-unknown`. Eliminates the need for manual
//! memory management, JSON parsing, and host function FFI.
//!
//! # Quick Start
//!
//! ```ignore
//! #![no_std]
//! #![no_main]
//!
//! citizen_contract::contract! {
//!     use citizen_contract_sdk::prelude::*;
//!
//!     #[derive(Serialize, Deserialize)]
//!     pub struct Admin {
//!         pub did: String,
//!         pub role: String,
//!     }
//!
//!     #[init]
//!     pub fn configure(ctx: Context) -> Result<Response> {
//!         let proposal_id: String = ctx.param("proposal_id")?;
//!         let admin: String = ctx.param("bootstrap_admin")?;
//!         ctx.require_governance(&proposal_id)?;
//!         ctx.storage().set(&format!("admin:{admin}"), &Admin {
//!             did: admin.clone(), role: "admin".into()
//!         })?;
//!         Ok(Response::success())
//!     }
//!
//!     #[query]
//!     pub fn check_admin(ctx: Context) -> Result<Response> {
//!         let did: String = ctx.param("did")?;
//!         let admin: Option<Admin> = ctx.storage().get(&format!("admin:{did}"))?;
//!         Ok(Response::json(json!({"is_admin": admin.is_some()})))
//!     }
//! }
//! ```

#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::string::ToString;

pub mod api;
pub mod storage;
pub mod context;
pub mod response;

pub use api::{store_state, load_state, verify_signature, check_governance,
              current_block_height, log_str, read_namespace_entry,
              write_namespace_entry, verify_signature_batch, call_module,
              hex_encode};
pub use storage::{Storage, Item, Map};
pub use context::Context;
pub use response::Response;

/// Global allocator for WASM contracts.
pub use CitizenAllocator as Allocator;

/// Error type returned by contract operations.
#[derive(Debug)]
pub enum ContractError {
    /// Serialization/deserialization failure.
    Serde(String),
    /// Missing or invalid parameter.
    Param(String),
    /// Authorization failure (signature verification, governance, admin check).
    Unauthorized(String),
    /// Storage operation failure.
    Storage(String),
    /// Generic contract error.
    Other(String),
}

impl ContractError {
    pub fn msg(s: &str) -> Self {
        ContractError::Other(s.to_string())
    }
}

impl core::fmt::Display for ContractError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ContractError::Serde(e) => write!(f, "serde: {e}"),
            ContractError::Param(e) => write!(f, "param: {e}"),
            ContractError::Unauthorized(e) => write!(f, "unauthorized: {e}"),
            ContractError::Storage(e) => write!(f, "storage: {e}"),
            ContractError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<serde_json::Error> for ContractError {
    fn from(e: serde_json::Error) -> Self {
        ContractError::Serde(e.to_string())
    }
}

/// Result alias for contract operations.
pub type Result<T = Response> = core::result::Result<T, ContractError>;

// ── Bump allocator (memory offset 0 stores the bump pointer) ──

static mut BUMP: u32 = 1024;

/// Allocate `size` bytes in WASM linear memory. Exported as `alloc`.
#[no_mangle]
pub extern "C" fn sdk_alloc(size: u32) -> u32 {
    unsafe {
        let aligned = (size + 3) & !3;
        let ptr = BUMP;
        let next = BUMP.checked_add(aligned).unwrap_or(0);
        if next > 65536 {
            return 0;
        }
        BUMP = next;
        ptr
    }
}

/// Simple bump allocator for Rust's `alloc` crate (Vec, String, Box, etc.).
/// Use with `#[global_allocator]` in contract crates.
pub struct CitizenAllocator;

unsafe impl core::alloc::GlobalAlloc for CitizenAllocator {
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        let size = layout.size() as u32;
        let ptr = sdk_alloc(size);
        if ptr == 0 {
            return core::ptr::null_mut();
        }
        ptr as *mut u8
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: core::alloc::Layout) {
        // Bump allocator — no per-allocation dealloc
    }
}

/// Write result bytes to a freshly allocated buffer.
/// Returns packed (ptr << 32 | len).
pub fn write_result(data: &[u8]) -> u64 {
    let len = data.len() as u32;
    let ptr = sdk_alloc(len + 1);
    if ptr == 0 {
        return 0;
    }
    unsafe {
        core::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, len as usize);
    }
    ((ptr as u64) << 32) | (len as u64)
}

/// Read a UTF-8 string from a WASM linear memory pointer+length.
pub fn read_memory(ptr: u32, len: u32) -> String {
    let bytes = unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let mut s = String::new();
    // Manually decode to avoid depending on std
    match core::str::from_utf8(bytes) {
        Ok(valid) => s.push_str(valid),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            if let Ok(valid) = core::str::from_utf8(&bytes[..valid_up_to]) {
                s.push_str(valid);
            }
        }
    }
    s
}

/// Format a contract error as a JSON error response string.
pub fn error_json(e: &ContractError) -> alloc::string::String {
    alloc::format!("{{\"ok\":false,\"error\":\"{}\"}}", e)
}

/// Generate WASM entry points (`alloc`, `handle`, panic handler) from a dispatch table.
///
/// ```ignore
/// citizen_contract_sdk::entrypoint! {
///     configure => "configure",
///     assign_admin => "assign_admin",
///     check_admin => "check_admin",
/// }
/// ```
#[macro_export]
macro_rules! entrypoint {
    ( $( $func:path => $op:literal ),+ $(,)? ) => {
        #[no_mangle]
        pub extern "C" fn alloc(size: u32) -> u32 {
            $crate::sdk_alloc(size)
        }

        #[no_mangle]
        pub extern "C" fn handle(params_ptr: u32, params_len: u32) -> u64 {
            let (ctx, op) = match $crate::Context::parse(params_ptr, params_len) {
                Some(v) => v,
                None => {
                    return $crate::write_result(
                        b"{\"ok\":false,\"error\":\"invalid json params\"}"
                    );
                }
            };

            let result: $crate::Result = match op.as_str() {
                $( $op => $func(ctx), )+
                _ => Err($crate::ContractError::Other(
                    alloc::format!("unknown operation: {op}")
                )),
            };

            match result {
                Ok(resp) => $crate::write_result(resp.as_bytes()),
                Err(e) => $crate::write_result(
                    $crate::error_json(&e).as_bytes()
                ),
            }
        }

        #[panic_handler]
        fn _citizen_panic(_info: &core::panic::PanicInfo) -> ! {
            loop {}
        }
    };
}

/// Prelude module — re-exports everything needed for contract development.
pub mod prelude {
    pub use crate::{
        ContractError, Result, Context, Response, Storage, Item, Map,
        store_state, load_state, verify_signature, check_governance,
        current_block_height, log_str, read_namespace_entry,
        write_namespace_entry, verify_signature_batch, call_module,
        hex_encode, write_result, read_memory, error_json,
    };
    pub use serde::{Serialize, Deserialize};
    pub use serde_json::json;
    pub use alloc::{format, string::{String, ToString}, vec::Vec};
}
