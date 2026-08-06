#![no_std]
#![no_main]

/// Admin Registry — a smart contract module for Citizen Protocol.
///
/// Manages administrator assignments, revocations, and KYC encryption keys
/// entirely on-chain via contract state. Replaces the native `civic.admin`
/// namespace-based approach with governance-gated, signature-verified
/// smart contract logic.
///
/// ## Operations
///
/// | Operation       | Parameters                                                    | Returns                              |
/// |-----------------|---------------------------------------------------------------|--------------------------------------|
/// | `configure`     | proposal_id, bootstrap_admin_did, role?, scope?               | `{"ok":true,"admin":"..."}`          |
/// | `assign_admin`  | admin_did, admin_sig, target_did, role, scope                 | `{"ok":true,"admin":"...","role":...}`|
/// | `revoke_admin`  | admin_did, admin_sig, target_did                              | `{"ok":true,"revoked":"..."}`        |
/// | `check_admin`   | did                                                           | `{"is_admin":true,"role":"...","scope":"..."}` |
/// | `list_admins`   | (none)                                                        | `{"admins":[...]}`                   |
/// | `set_kyc_key`   | admin_did, admin_sig, public_key                              | `{"ok":true}`                        |
/// | `get_kyc_key`   | (none)                                                        | `{"public_key":"..."}`              |

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
    fn host_check_governance_approval(
        pid_ptr: *const u8, pid_len: u32,
    ) -> u32;
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
        "configure" => handle_configure(&fields),
        "assign_admin" => handle_assign_admin(&fields),
        "revoke_admin" => handle_revoke_admin(&fields),
        "check_admin" => handle_check_admin(&fields),
        "list_admins" => handle_list_admins(),
        "set_kyc_key" => handle_set_kyc_key(&fields),
        "get_kyc_key" => handle_get_kyc_key(),
        _ => err("unknown operation"),
    }
}

// ── Operation handlers ──

fn handle_configure(fields: &[(StackStr, StackStr); 10]) -> u64 {
    let proposal_id = field(fields, "proposal_id");
    let bootstrap_admin = field(fields, "bootstrap_admin_did");
    let role = {
        let r = field(fields, "role");
        if r.is_empty() { "admin" } else { r }
    };
    let scope = {
        let s = field(fields, "scope");
        if s.is_empty() { "national" } else { s }
    };

    if bootstrap_admin.is_empty() {
        return err("missing required field: bootstrap_admin_did");
    }

    if state_get("config:initialized").is_some() {
        return err("admin-registry already configured");
    }

    if proposal_id.is_empty() {
        return err("governance proposal_id required for initial configuration");
    }
    if !check_governance(proposal_id) {
        return err("governance has not approved this admin-registry configuration");
    }

    let _ = state_set("config:initialized", "1");
    let _ = state_set(&format_key("admin:", bootstrap_admin), role);
    let _ = state_set(&format_key("scope:", bootstrap_admin), scope);
    let _ = state_set("admin_list", bootstrap_admin);

    let block = current_block();
    let mut bbuf: [u8; 20] = [0; 20];
    let blen = write_u64_decimal(&mut bbuf, 0, block);
    let _ = state_set_raw(&format_key("assigned_block:", bootstrap_admin), &bbuf[..blen]);

    log("admin-registry: configured (governance-approved bootstrap)");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"admin\":\"");
    write_bytes(&mut buf, &mut off, bootstrap_admin.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"role\":\"");
    write_bytes(&mut buf, &mut off, role.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"scope\":\"");
    write_bytes(&mut buf, &mut off, scope.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_assign_admin(fields: &[(StackStr, StackStr); 10]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    let target_did = field(fields, "target_did");
    let role = {
        let r = field(fields, "role");
        if r.is_empty() { "admin" } else { r }
    };
    let scope = {
        let s = field(fields, "scope");
        if s.is_empty() { "national" } else { s }
    };

    if admin_did.is_empty() || admin_sig.is_empty() || target_did.is_empty() {
        return err("missing required fields: admin_did, admin_sig, target_did");
    }

    if !is_active_admin(admin_did) {
        return err("caller is not an active admin");
    }

    let mut msg_buf: [u8; 512] = [0; 512];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"assign_admin:");
    write_bytes(&mut msg_buf, &mut msg_len, target_did.as_bytes());
    write_bytes(&mut msg_buf, &mut msg_len, b":");
    write_bytes(&mut msg_buf, &mut msg_len, role.as_bytes());
    write_bytes(&mut msg_buf, &mut msg_len, b":");
    write_bytes(&mut msg_buf, &mut msg_len, scope.as_bytes());
    let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
    if !verify_sig(admin_did, msg, admin_sig) {
        return err("admin signature verification failed");
    }

    let _ = state_set(&format_key("admin:", target_did), role);
    let _ = state_set(&format_key("scope:", target_did), scope);

    // Clear revocation by storing empty (load_state returns None for empty)
    let revoked_key = format_key("revoked:", target_did);
    let _ = state_set_raw(&revoked_key, b"");

    add_to_admin_list(target_did);

    let block = current_block();
    let mut bbuf: [u8; 20] = [0; 20];
    let blen = write_u64_decimal(&mut bbuf, 0, block);
    let _ = state_set_raw(&format_key("assigned_block:", target_did), &bbuf[..blen]);

    log("admin-registry: admin assigned");

    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"admin\":\"");
    write_bytes(&mut buf, &mut off, target_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"role\":\"");
    write_bytes(&mut buf, &mut off, role.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"scope\":\"");
    write_bytes(&mut buf, &mut off, scope.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"assigned_by\":\"");
    write_bytes(&mut buf, &mut off, admin_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_revoke_admin(fields: &[(StackStr, StackStr); 10]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    let target_did = field(fields, "target_did");

    if admin_did.is_empty() || admin_sig.is_empty() || target_did.is_empty() {
        return err("missing required fields: admin_did, admin_sig, target_did");
    }

    if !is_active_admin(admin_did) {
        return err("caller is not an active admin");
    }

    let mut msg_buf: [u8; 256] = [0; 256];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"revoke_admin:");
    write_bytes(&mut msg_buf, &mut msg_len, target_did.as_bytes());
    let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
    if !verify_sig(admin_did, msg, admin_sig) {
        return err("admin signature verification failed");
    }

    if state_get(&format_key("admin:", target_did)).is_none() {
        return err("target is not an admin");
    }

    let _ = state_set(&format_key("revoked:", target_did), "1");

    log("admin-registry: admin revoked");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"revoked\":\"");
    write_bytes(&mut buf, &mut off, target_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"revoked_by\":\"");
    write_bytes(&mut buf, &mut off, admin_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_check_admin(fields: &[(StackStr, StackStr); 10]) -> u64 {
    let did = field(fields, "did");
    if did.is_empty() {
        return err("missing required field: did");
    }

    let role_val = state_get(&format_key("admin:", did));
    let is_revoked = state_get(&format_key("revoked:", did)).is_some();

    match role_val {
        Some(role) => {
            let is_admin = !is_revoked;

            let scope_val = state_get(&format_key("scope:", did));
            let scope: &str = scope_val.as_deref().unwrap_or("national");

            let block_val = state_get(&format_key("assigned_block:", did));

            let mut buf: [u8; 512] = [0; 512];
            let mut off = 0;
            write_bytes(&mut buf, &mut off, b"{\"is_admin\":");
            write_bytes(&mut buf, &mut off, json_bool(is_admin).as_bytes());
            write_bytes(&mut buf, &mut off, b",\"role\":");
            if is_admin {
                write_bytes(&mut buf, &mut off, b"\"");
                write_bytes(&mut buf, &mut off, role.as_bytes());
                write_bytes(&mut buf, &mut off, b"\"");
            } else {
                write_bytes(&mut buf, &mut off, b"null");
            }
            write_bytes(&mut buf, &mut off, b",\"scope\":");
            if is_admin {
                write_bytes(&mut buf, &mut off, b"\"");
                write_bytes(&mut buf, &mut off, scope.as_bytes());
                write_bytes(&mut buf, &mut off, b"\"");
            } else {
                write_bytes(&mut buf, &mut off, b"null");
            }
            write_bytes(&mut buf, &mut off, b",\"revoked\":");
            write_bytes(&mut buf, &mut off, json_bool(is_revoked).as_bytes());
            if let Some(bv) = &block_val {
                write_bytes(&mut buf, &mut off, b",\"assigned_block\":\"");
                write_bytes(&mut buf, &mut off, bv.as_bytes());
                write_bytes(&mut buf, &mut off, b"\"");
            }
            write_bytes(&mut buf, &mut off, b"}");
            write_result(&buf[..off])
        }
        None => {
            let mut buf: [u8; 128] = [0; 128];
            let mut off = 0;
            write_bytes(&mut buf, &mut off, b"{\"is_admin\":false,\"role\":null,\"scope\":null,\"revoked\":false}");
            write_result(&buf[..off])
        }
    }
}

fn handle_list_admins() -> u64 {
    let admin_list_val = state_get("admin_list");
    let admin_list: &str = admin_list_val.as_deref().unwrap_or("");

    let mut dids: [&str; 32] = [""; 32];
    let count = split_commas(admin_list, &mut dids);

    let mut buf: [u8; 4096] = [0; 4096];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"admins\":[");
    let mut first = true;
    let mut active_count: u32 = 0;
    for i in 0..count {
        let did = dids[i];
        if did.is_empty() { continue; }
        let is_revoked = state_get(&format_key("revoked:", did)).is_some();
        if is_revoked { continue; }

        if !first {
            write_bytes(&mut buf, &mut off, b",");
        }
        first = false;

        let role_val = state_get(&format_key("admin:", did));
        let role: &str = role_val.as_deref().unwrap_or("admin");

        let scope_val = state_get(&format_key("scope:", did));
        let scope: &str = scope_val.as_deref().unwrap_or("national");

        write_bytes(&mut buf, &mut off, b"{\"did\":\"");
        write_bytes(&mut buf, &mut off, did.as_bytes());
        write_bytes(&mut buf, &mut off, b"\",\"role\":\"");
        write_bytes(&mut buf, &mut off, role.as_bytes());
        write_bytes(&mut buf, &mut off, b"\",\"scope\":\"");
        write_bytes(&mut buf, &mut off, scope.as_bytes());
        write_bytes(&mut buf, &mut off, b"\"}");

        active_count += 1;
    }
    write_bytes(&mut buf, &mut off, b"],\"count\":");
    off += write_u64_decimal(&mut buf, off, active_count as u64);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_set_kyc_key(fields: &[(StackStr, StackStr); 10]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    let public_key = field(fields, "public_key");

    if admin_did.is_empty() || admin_sig.is_empty() || public_key.is_empty() {
        return err("missing required fields: admin_did, admin_sig, public_key");
    }

    if !is_active_admin(admin_did) {
        return err("caller is not an active admin");
    }

    let mut msg_buf: [u8; 512] = [0; 512];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"set_kyc_key:");
    write_bytes(&mut msg_buf, &mut msg_len, public_key.as_bytes());
    let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
    if !verify_sig(admin_did, msg, admin_sig) {
        return err("admin signature verification failed");
    }

    let _ = state_set("kyc_key", public_key);

    log("admin-registry: kyc key set");

    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"set_by\":\"");
    write_bytes(&mut buf, &mut off, admin_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_get_kyc_key() -> u64 {
    match state_get("kyc_key") {
        Some(key) => {
            let mut buf: [u8; 512] = [0; 512];
            let mut off = 0;
            write_bytes(&mut buf, &mut off, b"{\"public_key\":\"");
            write_bytes(&mut buf, &mut off, key.as_bytes());
            write_bytes(&mut buf, &mut off, b"\"}");
            write_result(&buf[..off])
        }
        None => {
            let mut buf: [u8; 64] = [0; 64];
            let mut off = 0;
            write_bytes(&mut buf, &mut off, b"{\"public_key\":null}");
            write_result(&buf[..off])
        }
    }
}

// ── Admin authorization helpers ──

fn is_active_admin(did: &str) -> bool {
    if state_get(&format_key("admin:", did)).is_none() {
        return false;
    }
    // Revoked if the key exists with non-empty value (empty = cleared)
    state_get(&format_key("revoked:", did)).is_some()
}

fn add_to_admin_list(did: &str) {
    let existing_val = state_get("admin_list");
    let existing: &str = existing_val.as_deref().unwrap_or("");

    let mut dids: [&str; 32] = [""; 32];
    let count = split_commas(existing, &mut dids);
    for i in 0..count {
        if dids[i] == did {
            return;
        }
    }

    let mut buf: [u8; 2048] = [0; 2048];
    let mut len = 0;
    if !existing.is_empty() {
        let copy_len = existing.len().min(buf.len());
        buf[..copy_len].copy_from_slice(&existing.as_bytes()[..copy_len]);
        len = copy_len;
        if len > 0 && len < buf.len() {
            buf[len] = b',';
            len += 1;
        }
    }
    let did_bytes = did.as_bytes();
    let remaining = buf.len() - len;
    let did_copy = did_bytes.len().min(remaining);
    if did_copy > 0 {
        buf[len..len + did_copy].copy_from_slice(&did_bytes[..did_copy]);
        len += did_copy;
    }
    let _ = state_set_raw("admin_list", &buf[..len]);
}

// ── State helpers ──

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

// ── Host wrappers ──

fn verify_sig(did: &str, msg: &str, sig_hex: &str) -> bool {
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

fn current_block() -> u64 {
    unsafe { host_current_block_height() }
}

fn check_governance(proposal_id: &str) -> bool {
    unsafe {
        host_check_governance_approval(
            proposal_id.as_ptr(), proposal_id.len() as u32,
        ) == 1
    }
}

// ── Key formatting ──

fn format_key(prefix: &str, suffix: &str) -> KeyBuf {
    let mut buf = KeyBuf::new();
    buf.push_str(prefix);
    buf.push_str(suffix);
    buf
}

// ── Utility ──

fn split_commas<'a>(s: &'a str, out: &mut [&'a str; 32]) -> usize {
    let mut count = 0;
    let mut start = 0;
    for (i, b) in s.as_bytes().iter().enumerate() {
        if *b == b',' {
            if start < i && count < 32 {
                out[count] = &s[start..i];
                count += 1;
            }
            start = i + 1;
        }
    }
    if start < s.len() && count < 32 {
        out[count] = &s[start..];
        count += 1;
    }
    count
}

fn json_bool(b: bool) -> &'static str {
    if b { "true" } else { "false" }
}

// ── Buffer types ──

struct KeyBuf {
    data: [u8; 256],
    len: usize,
}

impl KeyBuf {
    fn new() -> Self { KeyBuf { data: [0; 256], len: 0 } }

    fn push_str(&mut self, s: &str) {
        for &b in s.as_bytes() {
            if self.len < self.data.len() {
                self.data[self.len] = b;
                self.len += 1;
            }
        }
    }
}

impl core::ops::Deref for KeyBuf {
    type Target = str;

    fn deref(&self) -> &str {
        core::str::from_utf8(&self.data[..self.len]).unwrap_or("")
    }
}

struct StateBuf {
    data: [u8; 512],
    len: usize,
}

impl StateBuf {
    fn new() -> Self { StateBuf { data: [0; 512], len: 0 } }
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

// ── JSON field parser ──

fn parse_fields(s: &str) -> Option<[(StackStr, StackStr); 10]> {
    let s = s.trim();
    if !s.starts_with('{') || !s.ends_with('}') { return None; }
    let inner = &s[1..s.len()-1];
    let mut fields: [(StackStr, StackStr); 10] = [(StackStr::empty(), StackStr::empty()); 10];
    let mut count = 0;
    let bytes = inner.as_bytes();
    let mut i = 0;
    let max_i = bytes.len();
    while i < max_i && count < 10 {
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

fn field<'a>(fields: &'a [(StackStr, StackStr); 10], name: &str) -> &'a str {
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

fn hex_encode(input: &[u8], output: &mut [u8]) -> usize {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut off = 0;
    for &b in input {
        if off + 1 >= output.len() { break; }
        output[off] = HEX[(b >> 4) as usize];
        output[off + 1] = HEX[(b & 0xf) as usize];
        off += 2;
    }
    off
}

fn log(msg: &str) {
    unsafe { host_log(msg.as_ptr(), msg.len() as u32); }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
