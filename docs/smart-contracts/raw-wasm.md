# Raw WASM API

The SDK provides high-level ergonomics, but underneath it all, Citizen smart contracts are plain WASM modules with a simple ABI. This page documents the low-level interface — useful if you want to write contracts without the SDK, need maximum control over memory, or are building alternative tooling.

## When to use raw WASM

| Scenario | Use SDK | Use raw WASM |
|----------|---------|--------------|
| Typical contract | ✅ | |
| Minimal binary size | | ✅ (saves ~80KB from serde) |
| No heap allocation needed | | ✅ |
| Custom JSON parsing | | ✅ |
| Educational / understanding internals | | ✅ |
| Alternative language (C, AssemblyScript) | | ✅ |

The SDK adds serde and serde_json (~80KB of WASM) for type-safe serialization. If your contract only needs simple key-value operations, raw WASM can produce binaries as small as 25KB.

## WASM ABI

Every Citizen smart contract must export two functions and provide linear memory:

```
┌──────────────────────────────────────────────────┐
│  WASM Module Exports                             │
│                                                  │
│  alloc(size: u32) → u32                          │
│    Allocate `size` bytes. Returns pointer.       │
│    Called by the host to pass large inputs.      │
│                                                  │
│  handle(params_ptr: u32, params_len: u32) → u64  │
│    Main entry point. Receives JSON params as     │
│    UTF-8 bytes at [ptr, ptr+len).                │
│    Returns packed (ptr << 32 | len) of result.   │
│                                                  │
│  memory (exported linear memory)                 │
│    Standard WASM linear memory.                  │
└──────────────────────────────────────────────────┘
```

### The `alloc` export

The host calls `alloc(size)` to get a writable pointer in the module's linear memory, then writes input data there. The simplest implementation is a bump allocator:

```rust
#![no_std]
#![no_main]

static mut BUMP: u32 = 1024;  // Start at 1024 (offset 0 reserved)

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    unsafe {
        let aligned = (size + 3) & !3;  // 4-byte align
        let ptr = BUMP;
        let next = BUMP.checked_add(aligned).unwrap_or(0);
        if next > 65536 {
            return 0;  // Out of memory
        }
        BUMP = next;
        ptr
    }
}
```

### The `handle` export

This is the main entry point. The host passes a pointer and length to a UTF-8 JSON string:

```rust
#[no_mangle]
pub extern "C" fn handle(params_ptr: u32, params_len: u32) -> u64 {
    // Read params from linear memory
    let params = unsafe {
        core::slice::from_raw_parts(params_ptr as *const u8, params_len as usize)
    };
    let params_str = match core::str::from_utf8(params) {
        Ok(s) => s,
        Err(_) => return pack_error("invalid utf8"),
    };

    // Parse JSON and dispatch
    // ...
}
```

### Return value packing

`handle` returns a `u64` that packs a pointer and length:

```rust
fn write_result(data: &[u8]) -> u64 {
    let len = data.len() as u32;
    let ptr = alloc(len + 1);  // Allocate space in linear memory
    unsafe {
        core::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, len as usize);
    }
    ((ptr as u64) << 32) | (len as u64)
}
```

The host reads the high 32 bits as a pointer and the low 32 bits as a length, then copies the result string out of WASM memory.

### Error returns

For errors, return a JSON string with `ok: false`:

```rust
fn pack_error(msg: &str) -> u64 {
    // Build: {"ok":false,"error":"<msg>"}
    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":false,\"error\":\"");
    write_bytes(&mut buf, &mut off, msg.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn write_bytes(buf: &mut [u8], off: &mut usize, data: &[u8]) {
    let copy = data.len().min(buf.len() - *off);
    buf[*off..*off + copy].copy_from_slice(&data[..copy]);
    *off += copy;
}
```

## Host function imports

Raw WASM contracts import host functions from the `"env"` module. Only 10 functions are whitelisted — any other import is rejected at registration.

### Declaration

```rust
extern "C" {
    fn host_log(ptr: *const u8, len: u32);
    fn host_store_state(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32) -> u32;
    fn host_load_state(key_ptr: *const u8, key_len: u32, out_ptr: *mut u8, out_len: u32) -> u64;
    fn host_verify_signature(did_ptr: *const u8, did_len: u32, msg_ptr: *const u8, msg_len: u32, sig_ptr: *const u8, sig_len: u32) -> u32;
    fn host_check_governance_approval(pid_ptr: *const u8, pid_len: u32) -> u32;
    fn host_verify_signature_batch(batch_ptr: *const u8, batch_len: u32) -> u32;
    fn host_current_block_height() -> u64;
    fn host_read_namespace_entry(ns_ptr: *const u8, ns_len: u32, eid_ptr: *const u8, eid_len: u32, out_ptr: *mut u8, out_len: u32) -> u64;
    fn host_write_namespace_entry(ns_ptr: *const u8, ns_len: u32, payload_ptr: *const u8, payload_len: u32) -> u32;
    fn host_call_module(target_ptr: *const u8, target_len: u32, params_ptr: *const u8, params_len: u32) -> u64;
}
```

### Return value conventions

| Function | Return type | Convention |
|----------|-------------|------------|
| `host_store_state` | `u32` | `0` = success, `1` = failure |
| `host_load_state` | `u64` | High 32 bits = bytes written, low 32 bits = status (`0` = success) |
| `host_verify_signature` | `u32` | `1` = valid, `0` = invalid |
| `host_check_governance_approval` | `u32` | `1` = approved, `0` = not found |
| `host_verify_signature_batch` | `u32` | Count of valid signatures |
| `host_current_block_height` | `u64` | Current block number |
| `host_read_namespace_entry` | `u64` | Packed: high 32 = written, low 32 = status |
| `host_write_namespace_entry` | `u32` | `0` = success |
| `host_call_module` | `u64` | Packed: high 32 = response ptr, low 32 = response len |

### Ergonomic wrappers

Wrap raw imports in helper functions:

```rust
fn state_set(key: &str, value: &str) -> bool {
    unsafe {
        host_store_state(
            key.as_ptr(), key.len() as u32,
            value.as_ptr(), value.len() as u32,
        ) == 0
    }
}

fn state_get(key: &str) -> Option<&str> {
    let mut buf = StateBuf::new();
    let packed = unsafe {
        host_load_state(
            key.as_ptr(), key.len() as u32,
            buf.data.as_mut_ptr(), buf.data.len() as u32,
        )
    };
    let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
    let status = packed & 0xFFFF_FFFF;
    if status == 0 && written > 0 && written <= buf.data.len() {
        buf.len = written;
        // Return reference into buffer
        Some(core::str::from_utf8(&buf.data[..buf.len]).unwrap_or(""))
    } else {
        None
    }
}

fn verify_sig(did: &str, msg: &str, sig_hex: &str) -> bool {
    // Must hex-encode the message
    let mut hex_buf: [u8; 1024] = [0; 1024];
    let hex_len = hex_encode(msg.as_bytes(), &mut hex_buf);
    let msg_hex = core::str::from_utf8(&hex_buf[..hex_len]).unwrap_or("");
    unsafe {
        host_verify_signature(
            did.as_ptr(), did.len() as u32,
            msg_hex.as_ptr(), msg_hex.len() as u32,
            sig_hex.as_ptr(), sig_hex.len() as u32,
        ) == 1
    }
}
```

## Hex encoding

`host_verify_signature` expects the message as **hex-encoded bytes**, not raw strings:

```rust
fn hex_encode(input: &[u8]) -> usize {
    // Writes hex into a static buffer, returns length
    const HEX: &[u8; 16] = b"0123456789abcdef";
    // Implementation depends on your buffer strategy
    // See admin-registry v1 for a complete example
}
```

## Manual JSON parsing

Without serde, you must parse JSON yourself. The admin-registry v1 uses a hand-rolled field extractor that reads `"key":"value"` pairs into a fixed-size array:

```rust
// Fixed-size stack-allocated string (no heap)
struct StackStr {
    data: [u8; 128],
    len: usize,
}

impl StackStr {
    const fn empty() -> Self { StackStr { data: [0; 128], len: 0 } }
}

impl core::ops::Deref for StackStr {
    type Target = str;
    fn deref(&self) -> &str {
        core::str::from_utf8(&self.data[..self.len]).unwrap_or("")
    }
}

// Parse JSON object into up to 10 key-value pairs
fn parse_fields(s: &str) -> Option<[(StackStr, StackStr); 10]> {
    let s = s.trim();
    if !s.starts_with('{') || !s.ends_with('}') { return None; }
    let inner = &s[1..s.len() - 1];
    let mut fields = [(StackStr::empty(), StackStr::empty()); 10];
    let mut idx = 0;
    // ... scan for "key":"value" pairs ...
    Some(fields)
}

fn field<'a>(fields: &'a [(StackStr, StackStr); 10], key: &str) -> &'a str {
    for (k, v) in fields {
        if k.deref() == key { return v; }
    }
    ""
}
```

### Dispatch

```rust
#[no_mangle]
pub extern "C" fn handle(params_ptr: u32, params_len: u32) -> u64 {
    let params = unsafe {
        core::slice::from_raw_parts(params_ptr as *const u8, params_len as usize)
    };
    let params_str = match core::str::from_utf8(params) {
        Ok(s) => s,
        Err(_) => return pack_error("invalid utf8"),
    };
    let fields = match parse_fields(params_str) {
        Some(v) => v,
        None => return pack_error("invalid json"),
    };

    match field(&fields, "operation") {
        "increment" => handle_increment(&fields),
        "get_count" => handle_get_count(&fields),
        _ => pack_error("unknown operation"),
    }
}
```

## Building JSON responses by hand

Without serde_json, build JSON by writing bytes into a buffer:

```rust
fn handle_check_admin(fields: &[(StackStr, StackStr); 10]) -> u64 {
    let did = field(fields, "did");
    let is_admin = state_get(&format_key("admin:", did)).is_some();

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;

    write_bytes(&mut buf, &mut off, b"{\"is_admin\":");
    write_bytes(&mut buf, &mut off, if is_admin { b"true" } else { b"false" });
    write_bytes(&mut buf, &mut off, b",\"did\":\"");
    write_bytes(&mut buf, &mut off, did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");

    write_result(&buf[..off])
}
```

## Memory management strategies

### Strategy 1: Stack-only (no heap)

Use fixed-size arrays for everything. Smallest binary, most restrictive:

```rust
struct KeyBuf { data: [u8; 256], len: usize }
struct StateBuf { data: [u8; 512], len: usize }

// All operations use stack-allocated buffers
// No alloc crate, no global allocator
```

### Strategy 2: Bump allocator at volatile pointer

Store the bump pointer at memory offset 0 (reserved):

```rust
fn bump_read() -> u32 {
    let raw = unsafe { core::ptr::read_volatile(0usize as *const u32) };
    if raw == 0 { 1024 } else { raw }
}

fn bump_write(val: u32) {
    unsafe { core::ptr::write_volatile(0usize as *mut u32, val); }
}

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    let bump = bump_read();
    let new_bump = bump + ((size + 3) & !3);
    if new_bump > 65536 { return 0; }
    bump_write(new_bump);
    bump
}
```

### Strategy 3: SDK global allocator

Use the SDK's `CitizenAllocator` to get `Vec`, `String`, and `Box`. Requires serde dependency but provides the best ergonomics. See [Installation](installation.md).

## Cargo.toml for raw WASM

Raw WASM contracts don't need serde — only the Rust core library:

```toml
[package]
name = "my-raw-contract"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
name = "my_raw_contract"

# No dependencies needed for pure raw WASM!

[profile.release]
opt-level = "s"
lto = true
strip = "none"

[workspace]
```

## Minimal raw WASM contract

Here is the smallest useful Citizen smart contract (no SDK, no serde):

```rust
#![no_std]
#![no_main]

// ── Bump allocator ──

static mut BUMP: u32 = 1024;

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    unsafe {
        let aligned = (size + 3) & !3;
        let ptr = BUMP;
        BUMP += aligned;
        ptr
    }
}

// ── Host imports ──

extern "C" {
    fn host_store_state(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32) -> u32;
    fn host_load_state(key_ptr: *const u8, key_len: u32, out_ptr: *mut u8, out_len: u32) -> u64;
}

// ── Entry point ──

#[no_mangle]
pub extern "C" fn handle(params_ptr: u32, params_len: u32) -> u64 {
    // For a truly minimal contract, parse operation from params
    // and dispatch to handlers

    // Example: return {"ok":true}
    let resp = b"{\"ok\":true}";
    let ptr = alloc(resp.len() as u32);
    unsafe {
        core::ptr::copy_nonoverlapping(resp.as_ptr(), ptr as *mut u8, resp.len());
    }
    ((ptr as u64) << 32) | (resp.len() as u64)
}
```

## Comparison: raw WASM vs SDK

The admin-registry module exists in both forms:

| Aspect | Raw WASM (`admin-registry`) | SDK (`admin-registry-v2`) |
|--------|---------------------------|--------------------------|
| Lines of code | 729 | 248 |
| Binary size | ~25 KB | ~160 KB |
| JSON parsing | Hand-rolled field extractor | `ctx.param::<T>()` |
| State access | `state_set("admin:did", "role")` | `storage.map::<String, Admin>("admin").save(...)` |
| Memory | Stack-allocated buffers | Heap via global allocator |
| Dependencies | None | serde, serde_json, contract-sdk |

## Reference implementation

The complete raw WASM admin-registry is at `citizen-protocol/modules/admin-registry/src/lib.rs`. It demonstrates:

- Hand-rolled JSON field parser
- Stack-allocated string buffers (`StackStr`, `KeyBuf`, `StateBuf`)
- Bump allocator using volatile memory reads
- Comma-separated index management
- Signature verification with hex encoding
- Governance approval checks
- Manual JSON response building

## Next steps

- [Host Functions](host-functions.md) — Full reference for all 10 host functions
- [Exercises](exercises/index.md) — Practice building contracts
- [Best Practices](best-practices.md) — Security and optimization patterns
