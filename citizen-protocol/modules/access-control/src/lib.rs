#![no_std]
#![no_main]

/// Access Control Guard WASM module for Citizen Protocol.
/// Handles `check_access` and `guard_write` operations.

// --- Memory-based bump allocator ---
// Bump pointer stored at memory offset 0 (4 bytes, u32).

fn bump_read() -> u32 {
    let raw = unsafe { core::ptr::read_volatile(0usize as *const u32) };
    if raw == 0 { 1024 } else { raw }
}

fn bump_write(val: u32) {
    unsafe { core::ptr::write_volatile(0usize as *mut u32, val); }
}

// --- Host function imports ---

extern "C" {
    fn host_log(ptr: *const u8, len: u32);
    fn host_read_namespace_entry(
        ns_ptr: *const u8, ns_len: u32,
        eid_ptr: *const u8, eid_len: u32,
        out_ptr: *mut u8, out_len: u32,
    ) -> u64;
    fn host_verify_signature(
        did_ptr: *const u8, did_len: u32,
        msg_ptr: *const u8, msg_len: u32,
        sig_ptr: *const u8, sig_len: u32,
    ) -> u32;
    fn host_current_block_height() -> u64;
}

// --- Exports ---

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    let bump = bump_read();
    let new_bump = bump + ((size + 3) & !3);
    if new_bump > 65536 { return 0; }
    bump_write(new_bump);
    bump
}

#[no_mangle]
pub extern "C" fn handle(params_ptr: u32, params_len: u32) -> u64 {
    let params = unsafe { core::slice::from_raw_parts(params_ptr as *const u8, params_len as usize) };
    let params_str = match core::str::from_utf8(params) { Ok(s) => s, Err(_) => return err("invalid utf8"), };
    let fields = match parse_fields(params_str) { Some(v) => v, None => return err("invalid json"), };

    let operation = field(&fields, "operation");
    let signer_did = field(&fields, "signer_did");
    let message_hex = field(&fields, "message_hex");
    let signature_hex = field(&fields, "signature_hex");

    if signer_did.is_empty() || message_hex.is_empty() || signature_hex.is_empty() {
        return err("missing required fields");
    }

    let valid = unsafe {
        host_verify_signature(
            signer_did.as_ptr(), signer_did.len() as u32,
            message_hex.as_ptr(), message_hex.len() as u32,
            signature_hex.as_ptr(), signature_hex.len() as u32,
        ) == 1
    };

    match operation {
        "check_access" => {
            if valid {
                let block = unsafe { host_current_block_height() };
                log("access-control: GRANTED");
                ok2("signature verified", signer_did, block)
            } else {
                log("access-control: DENIED");
                deny("signature verification failed", signer_did)
            }
        }
        "guard_write" => {
            if !valid { return deny("signature verification failed", signer_did); }
            let namespace = field(&fields, "namespace");
            let entry_id = field(&fields, "entry_id");
            if namespace.is_empty() { return err("missing namespace"); }
            if !entry_id.is_empty() {
                match call_read_entry(namespace, entry_id) {
                    Some(_entry_json) => ok_guard(signer_did, namespace, entry_id, "entry exists"),
                    None => deny_guard(signer_did, namespace, entry_id, "entry not found"),
                }
            } else {
                ok_guard(signer_did, namespace, "", "signature verified")
            }
        }
        _ => err("unknown operation"),
    }
}

// --- Helpers ---

fn ok2(reason: &str, signer: &str, block: u64) -> u64 {
    // Build JSON with inline number formatting for block height
    let mut buf: [u8; 256] = [0; 256];
    let prefix = b"{\"allowed\":true,\"signer\":\"";
    let mut off = 0;
    for &b in prefix { buf[off] = b; off += 1; }
    for &b in signer.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\",\"block_height\":" { buf[off] = b; off += 1; }
    off += write_u64_decimal(&mut buf, off, block);
    for &b in b",\"reason\":\"" { buf[off] = b; off += 1; }
    for &b in reason.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\"}" { buf[off] = b; off += 1; }
    write_result(&buf[..off])
}

fn ok_guard(signer: &str, ns: &str, eid: &str, reason: &str) -> u64 {
    let mut buf: [u8; 512] = [0; 256];
    let mut off = 0;
    for &b in b"{\"allowed\":true,\"signer\":\"" { buf[off] = b; off += 1; }
    for &b in signer.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\",\"namespace\":\"" { buf[off] = b; off += 1; }
    for &b in ns.as_bytes() { buf[off] = b; off += 1; }
    if !eid.is_empty() {
        for &b in b"\",\"entry_id\":\"" { buf[off] = b; off += 1; }
        for &b in eid.as_bytes() { buf[off] = b; off += 1; }
    }
    for &b in b"\",\"reason\":\"" { buf[off] = b; off += 1; }
    for &b in reason.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\"}" { buf[off] = b; off += 1; }
    write_result(&buf[..off])
}

fn deny(reason: &str, signer: &str) -> u64 {
    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    for &b in b"{\"allowed\":false,\"signer\":\"" { buf[off] = b; off += 1; }
    for &b in signer.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\",\"reason\":\"" { buf[off] = b; off += 1; }
    for &b in reason.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\"}" { buf[off] = b; off += 1; }
    write_result(&buf[..off])
}

fn deny_guard(signer: &str, ns: &str, eid: &str, reason: &str) -> u64 {
    let mut buf: [u8; 512] = [0; 256];
    let mut off = 0;
    for &b in b"{\"allowed\":false,\"signer\":\"" { buf[off] = b; off += 1; }
    for &b in signer.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\",\"namespace\":\"" { buf[off] = b; off += 1; }
    for &b in ns.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\",\"entry_id\":\"" { buf[off] = b; off += 1; }
    for &b in eid.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\",\"reason\":\"" { buf[off] = b; off += 1; }
    for &b in reason.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\"}" { buf[off] = b; off += 1; }
    write_result(&buf[..off])
}

fn err(reason: &str) -> u64 {
    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    for &b in b"{\"allowed\":false,\"reason\":\"" { buf[off] = b; off += 1; }
    for &b in reason.as_bytes() { buf[off] = b; off += 1; }
    for &b in b"\"}" { buf[off] = b; off += 1; }
    write_result(&buf[..off])
}

fn write_result(data: &[u8]) -> u64 {
    let len = data.len() as u32;
    let ptr = alloc(len + 1);
    if ptr == 0 { return 0; }
    let dest = unsafe { core::slice::from_raw_parts_mut(ptr as *mut u8, len as usize) };
    dest.copy_from_slice(data);
    ((ptr as u64) << 32) | (len as u64)
}

fn write_u64_decimal(buf: &mut [u8], off: usize, mut n: u64) -> usize {
    if n == 0 { buf[off] = b'0'; return 1; }
    let mut digits: [u8; 20] = [0; 20];
    let mut cnt = 0;
    while n > 0 { digits[cnt] = (n % 10) as u8 + b'0'; n /= 10; cnt += 1; }
    for i in (0..cnt).rev() { buf[off + cnt - 1 - i] = digits[i]; }
    cnt
}

fn log(msg: &str) {
    let b = msg.as_bytes();
    unsafe { host_log(b.as_ptr(), b.len() as u32); }
}

fn call_read_entry(namespace: &str, entry_id: &str) -> Option<[u8; 512]> {
    let mut buf = [0u8; 512];
    let packed = unsafe {
        host_read_namespace_entry(
            namespace.as_ptr(), namespace.len() as u32,
            entry_id.as_ptr(), entry_id.len() as u32,
            buf.as_mut_ptr(), buf.len() as u32,
        )
    };
    let written = ((packed >> 32) & 0xFFFF_FFFF) as usize;
    let status = packed & 0xFFFF_FFFF;
    if status == 0 && written > 0 && written <= 512 {
        Some(buf)
    } else {
        None
    }
}

// --- Minimal JSON parser (returns stack-allocated key/value list) ---

fn parse_fields(s: &str) -> Option<[(StackStr, StackStr); 8]> {
    let s = s.trim();
    if !s.starts_with('{') || !s.ends_with('}') { return None; }
    let inner = &s[1..s.len()-1];
    let mut fields: [(StackStr, StackStr); 8] = [(StackStr::empty(), StackStr::empty()); 8];
    let mut count = 0;
    let bytes = inner.as_bytes();
    let mut i = 0;
    let max_i = bytes.len();
    while i < max_i && count < 8 {
        while i < max_i && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= max_i || bytes[i] == b'}' { break; }
        if bytes[i] != b'"' { return None; }
        i += 1;
        let key_start = i;
        while i < max_i && bytes[i] != b'"' {
            if bytes[i] == b'\\' { i += 1; }
            i += 1;
        }
        if i >= max_i { return None; }
        let key = StackStr::from_slice(&inner.as_bytes()[key_start..i]);
        i += 1;
        while i < max_i && (bytes[i].is_ascii_whitespace() || bytes[i] == b':') { i += 1; }
        if i >= max_i { return None; }
        let val_start = i;
        if bytes[i] == b'"' {
            i += 1;
            while i < max_i && bytes[i] != b'"' {
                if bytes[i] == b'\\' { i += 1; }
                i += 1;
            }
            i += 1;
            fields[count] = (key, StackStr::from_slice(&inner.as_bytes()[val_start+1..i-1]));
        } else if bytes[i] == b'{' || bytes[i] == b'[' {
            let open = bytes[i];
            let close = if open == b'{' { b'}' } else { b']' };
            let mut depth = 0;
            while i < max_i {
                if bytes[i] == open { depth += 1; }
                else if bytes[i] == close { depth -= 1; }
                i += 1;
                if depth == 0 { break; }
            }
            fields[count] = (key, StackStr::from_slice(&inner.as_bytes()[val_start..i]));
        } else {
            while i < max_i && bytes[i] != b',' && bytes[i] != b'}' { i += 1; }
            fields[count] = (key, StackStr::from_slice(&inner.as_bytes()[val_start..i]));
        }
        count += 1;
        // skip comma
        if i < max_i && bytes[i] == b',' { i += 1; }
    }
    if count > 0 { Some(fields) } else { None }
}

#[derive(Copy, Clone)]
struct StackStr {
    ptr: *const u8,
    len: u32,
}

impl StackStr {
    fn empty() -> Self { StackStr { ptr: core::ptr::null(), len: 0 } }
    fn from_slice(s: &[u8]) -> Self { StackStr { ptr: s.as_ptr(), len: s.len() as u32 } }
    fn as_str(&self) -> &str {
        if self.len == 0 { return ""; }
        unsafe { core::str::from_utf8_unchecked(core::slice::from_raw_parts(self.ptr, self.len as usize)) }
    }
}

fn field<'a>(fields: &'a [(StackStr, StackStr); 8], name: &str) -> &'a str {
    for (k, v) in fields {
        if k.as_str() == name { return v.as_str(); }
    }
    ""
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
