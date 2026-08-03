#![no_std]
#![no_main]

/// Soulbound Token (SBT) WASM module for Citizen Protocol.
///
/// A soulbound token is a non-transferable NFT — once minted to a recipient,
/// it is permanently bound to that identity. Transfers are always rejected.
///
/// ## Operations
///
/// | Operation     | Parameters                                          | Returns                          |
/// |---------------|-----------------------------------------------------|----------------------------------|
/// | `mint`        | issuer_did, signature_hex, token_id, recipient_did  | `{"ok":true,"token_id":"...",...}` |
/// | `owner_of`    | token_id                                            | `{"owner":"did:..."}`            |
/// | `total_supply`| (none)                                              | `{"total_supply":N}`             |
/// | `get_metadata`| token_id                                            | `{"token_id":"...","metadata":{}}`|
/// | `burn`        | issuer_did, signature_hex, token_id                 | `{"ok":true,"burned":true}`      |
/// | `transfer`    | (any)                                               | `{"ok":false,"reason":"..."}`    |

// ── Bump allocator (pointer at memory offset 0) ──

fn bump_read() -> u32 {
    let raw = unsafe { core::ptr::read_volatile(0usize as *const u32) };
    if raw == 0 { 1024 } else { raw }
}

fn bump_write(val: u32) {
    unsafe { core::ptr::write_volatile(0usize as *mut u32, val); }
}

// ── Host function imports ──

extern "C" {
    fn host_log(ptr: *const u8, len: u32);
    fn host_verify_signature(
        did_ptr: *const u8, did_len: u32,
        msg_ptr: *const u8, msg_len: u32,
        sig_ptr: *const u8, sig_len: u32,
    ) -> u32;
    fn host_store_state(
        key_ptr: *const u8, key_len: u32,
        val_ptr: *const u8, val_len: u32,
    ) -> u32;
    fn host_load_state(
        key_ptr: *const u8, key_len: u32,
        out_ptr: *mut u8, out_len: u32,
    ) -> u64;
    fn host_current_block_height() -> u64;
}

// ── Exports ──

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
    let params = unsafe {
        core::slice::from_raw_parts(params_ptr as *const u8, params_len as usize)
    };
    let params_str = match core::str::from_utf8(params) {
        Ok(s) => s,
        Err(_) => return err("invalid utf8"),
    };
    let fields = match parse_fields(params_str) {
        Some(v) => v,
        None => return err("invalid json"),
    };

    let op = field(&fields, "operation");

    match op {
        "mint" => handle_mint(&fields),
        "owner_of" => handle_owner_of(&fields),
        "total_supply" => handle_total_supply(),
        "get_metadata" => handle_get_metadata(&fields),
        "burn" => handle_burn(&fields),
        "transfer" => {
            log("sbt: transfer rejected — soulbound tokens are non-transferable");
            json_err("soulbound: non-transferable")
        }
        _ => err("unknown operation"),
    }
}

// ── Operation handlers ──

fn handle_mint(fields: &[(StackStr, StackStr); 8]) -> u64 {
    let issuer_did = field(fields, "issuer_did");
    let signature_hex = field(fields, "signature_hex");
    let token_id = field(fields, "token_id");
    let recipient_did = field(fields, "recipient_did");
    let metadata = field(fields, "metadata");

    if issuer_did.is_empty() || signature_hex.is_empty() || token_id.is_empty() || recipient_did.is_empty() {
        return err("missing required fields: issuer_did, signature_hex, token_id, recipient_did");
    }

    // Check if token already exists
    if state_get(&format_key("owner:", token_id)).is_some() {
        return err("token already minted");
    }

    // Verify issuer authority — issuer signs "mint:{token_id}:{recipient_did}"
    let mint_msg = format_key3("mint:", token_id, ":", recipient_did);
    let valid = verify_sig(issuer_did, &mint_msg, signature_hex);
    if !valid {
        return err("issuer signature verification failed");
    }

    // Store ownership
    if !state_set(&token_key("owner:", token_id), recipient_did) {
        return err("failed to store ownership");
    }

    // Store metadata (default to empty object)
    let meta_value = if metadata.is_empty() { "{}" } else { metadata };
    let _ = state_set(&token_key("meta:", token_id), meta_value);

    // Increment total supply
    let supply = get_total_supply() + 1;
    set_total_supply(supply);

    let block = current_block();
    log("sbt: minted");

    // Response: {"ok":true,"token_id":"...","owner":"...","total_supply":N,"block":N,"soulbound":true}
    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"owner\":\"");
    write_bytes(&mut buf, &mut off, recipient_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"total_supply\":");
    off += write_u64_decimal(&mut buf, off, supply);
    write_bytes(&mut buf, &mut off, b",\"block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b",\"soulbound\":true}");
    write_result(&buf[..off])
}

fn handle_owner_of(fields: &[(StackStr, StackStr); 8]) -> u64 {
    let token_id = field(fields, "token_id");
    if token_id.is_empty() {
        return err("missing token_id");
    }

    if state_get(&format_key("burned:", token_id)).is_some() {
        return json_response(r#"{"owner":null,"burned":true}"#);
    }

    match state_get(&format_key("owner:", token_id)) {
        Some(owner) => {
            let mut buf: [u8; 256] = [0; 256];
            let mut off = 0;
            write_bytes(&mut buf, &mut off, b"{\"owner\":\"");
            write_bytes(&mut buf, &mut off, owner.as_bytes());
            write_bytes(&mut buf, &mut off, b"\"}");
            write_result(&buf[..off])
        }
        None => err("token not found"),
    }
}

fn handle_total_supply() -> u64 {
    let supply = get_total_supply();
    let mut buf: [u8; 64] = [0; 64];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"total_supply\":");
    off += write_u64_decimal(&mut buf, off, supply);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_get_metadata(fields: &[(StackStr, StackStr); 8]) -> u64 {
    let token_id = field(fields, "token_id");
    if token_id.is_empty() {
        return err("missing token_id");
    }

    match state_get(&format_key("meta:", token_id)) {
        Some(meta) => {
            let mut buf: [u8; 512] = [0; 512];
            let mut off = 0;
            write_bytes(&mut buf, &mut off, b"{\"token_id\":\"");
            write_bytes(&mut buf, &mut off, token_id.as_bytes());
            write_bytes(&mut buf, &mut off, b"\",\"metadata\":");
            write_bytes(&mut buf, &mut off, meta.as_bytes());
            write_bytes(&mut buf, &mut off, b"}");
            write_result(&buf[..off])
        }
        None => err("metadata not found"),
    }
}

fn handle_burn(fields: &[(StackStr, StackStr); 8]) -> u64 {
    let issuer_did = field(fields, "issuer_did");
    let signature_hex = field(fields, "signature_hex");
    let token_id = field(fields, "token_id");

    if issuer_did.is_empty() || signature_hex.is_empty() || token_id.is_empty() {
        return err("missing required fields: issuer_did, signature_hex, token_id");
    }

    // Verify issuer authority — signs "burn:{token_id}"
    let burn_msg = format_key("burn:", token_id);
    let valid = verify_sig(issuer_did, &burn_msg, signature_hex);
    if !valid {
        return err("issuer signature verification failed");
    }

    // Check token exists
    if state_get(&format_key("owner:", token_id)).is_none() {
        return err("token not found");
    }

    // Mark as burned
    if !state_set_raw(&format_key("burned:", token_id), b"1") {
        return err("failed to burn token");
    }

    // Decrement total supply
    let supply = get_total_supply();
    if supply > 0 {
        set_total_supply(supply - 1);
    }

    log("sbt: burned");
    json_response(r#"{"ok":true,"burned":true}"#)
}

// ── State helpers ──

fn get_total_supply() -> u64 {
    state_get("total_supply")
        .as_ref().and_then(|s| parse_u64_str(s))
        .unwrap_or(0)
}

fn set_total_supply(n: u64) {
    let mut buf: [u8; 20] = [0; 20];
    let len = write_u64_decimal(&mut buf, 0, n);
    state_set_raw("total_supply", &buf[..len]);
}

fn state_set(key: &str, value: &str) -> bool {
    state_set_raw(key, value.as_bytes())
}

fn state_set_raw(key: &str, value: &[u8]) -> bool {
    unsafe {
        host_store_state(
            key.as_ptr(), key.len() as u32,
            value.as_ptr(), value.len() as u32,
        ) == 0
    }
}

fn state_get(key: &str) -> Option<StateVal> {
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
        Some(StateVal { buf })
    } else {
        None
    }
}

fn verify_sig(did: &str, msg: &str, sig: &str) -> bool {
    unsafe {
        host_verify_signature(
            did.as_ptr(), did.len() as u32,
            msg.as_ptr(), msg.len() as u32,
            sig.as_ptr(), sig.len() as u32,
        ) == 1
    }
}

fn current_block() -> u64 {
    unsafe { host_current_block_height() }
}

// ── Key formatting (avoids heap allocation) ──

fn format_key(prefix: &str, suffix: &str) -> KeyBuf {
    let mut buf = KeyBuf::new();
    buf.push_str(prefix);
    buf.push_str(suffix);
    buf
}

fn format_key3(a: &str, b: &str, sep: &str, c: &str) -> KeyBuf {
    let mut buf = KeyBuf::new();
    buf.push_str(a);
    buf.push_str(b);
    buf.push_str(sep);
    buf.push_str(c);
    buf
}

fn token_key(prefix: &str, token_id: &str) -> KeyBuf {
    format_key(prefix, token_id)
}

struct KeyBuf {
    data: [u8; 128],
    len: usize,
}

impl KeyBuf {
    fn new() -> Self { KeyBuf { data: [0; 128], len: 0 } }

    fn push_str(&mut self, s: &str) {
        for &b in s.as_bytes() {
            if self.len < self.data.len() {
                self.data[self.len] = b;
                self.len += 1;
            }
        }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.data[..self.len]
    }
}

impl core::ops::Deref for KeyBuf {
    type Target = str;

    fn deref(&self) -> &str {
        core::str::from_utf8(&self.data[..self.len]).unwrap_or("")
    }
}

// ── State value wrapper ──

struct StateBuf {
    data: [u8; 256],
    len: usize,
}

impl StateBuf {
    fn new() -> Self { StateBuf { data: [0; 256], len: 0 } }
}

struct StateVal {
    buf: StateBuf,
}

impl core::ops::Deref for StateVal {
    type Target = str;

    fn deref(&self) -> &str {
        core::str::from_utf8(&self.buf.data[..self.buf.len]).unwrap_or("")
    }
}

// ── JSON field parser (identical to access-control pattern) ──

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

// ── Output helpers ──

fn write_bytes(buf: &mut [u8], off: &mut usize, data: &[u8]) {
    for &b in data {
        if *off < buf.len() {
            buf[*off] = b;
            *off += 1;
        }
    }
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

fn err(reason: &str) -> u64 {
    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":false,\"error\":\"");
    write_bytes(&mut buf, &mut off, reason.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn json_err(reason: &str) -> u64 {
    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":false,\"reason\":\"");
    write_bytes(&mut buf, &mut off, reason.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn json_response(json: &str) -> u64 {
    write_result(json.as_bytes())
}

fn parse_u64_str(s: &str) -> Option<u64> {
    let mut result: u64 = 0;
    let mut any = false;
    for b in s.as_bytes() {
        if *b >= b'0' && *b <= b'9' {
            result = result.checked_mul(10)?.checked_add((*b - b'0') as u64)?;
            any = true;
        }
    }
    if any { Some(result) } else { None }
}

fn log(msg: &str) {
    unsafe { host_log(msg.as_ptr(), msg.len() as u32); }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
