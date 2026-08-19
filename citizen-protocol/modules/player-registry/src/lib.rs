#![no_std]
#![no_main]

use core::ops::Deref;

/// Player Registry — Citizen Protocol port of the TreasureNet soulbound-token
/// and player-registry Stellar contracts. Roles (Player, GameMaster, Auditor)
/// are soulbound: granted by an authorized admin after identity checks,
/// revocable, and never transferable.
///
/// ## Operations
///
/// | Operation      | Parameters                            | Notes |
/// |----------------|---------------------------------------|-------|
/// | `configure`    | admin_did, proposal_id, admin_sig?    | Governance-gated bootstrap (ports `init` + `set_sbt_contract`) |
/// | `grant_role`   | admin_did, signature, player_did, role| Admin-only role grant (ports SBT `mint`) |
/// | `revoke_role`  | admin_did, signature, player_did      | Admin-only revocation |
/// | `role_of`      | did                                   | Role lookup or `NoRoleToken` |
/// | `is_registered`| did                                   | bool |
/// | `has_role`     | did, role                             | bool, gates actions (`InsufficientRole`) |
/// | `list_counts`  | (none)                                | Per-role holder counts |
/// | `transfer`     | (any)                                 | Always rejected — roles are soulbound |
///
/// ## Error cases (ported from the Stellar contracts)
///
/// `Unauthorized` (non-admin mint / unauthorized set_sbt_contract),
/// `AlreadyRegistered` (duplicate mint), `NotFound` (revoke unknown player),
/// `NoRoleToken` (role_of with no token), `InsufficientRole`, and the
/// hard `soulbound: non-transferable` rejection for transfers.

// ── Bump allocator (pointer at memory offset 0) ──

fn bump_read() -> u32 {
    let raw = unsafe { core::ptr::read_volatile(0usize as *const u32) };
    if raw == 0 {
        1024
    } else {
        raw
    }
}

fn bump_write(val: u32) {
    unsafe {
        core::ptr::write_volatile(0usize as *mut u32, val);
    }
}

// ── Host function imports ──

extern "C" {
    fn host_log(ptr: *const u8, len: u32);
    fn host_verify_signature(
        did_ptr: *const u8,
        did_len: u32,
        msg_ptr: *const u8,
        msg_len: u32,
        sig_ptr: *const u8,
        sig_len: u32,
    ) -> u32;
    fn host_store_state(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32) -> u32;
    fn host_load_state(key_ptr: *const u8, key_len: u32, out_ptr: *mut u8, out_len: u32) -> u64;
    fn host_current_block_height() -> u64;
    fn host_check_governance_approval(pid_ptr: *const u8, pid_len: u32) -> u32;
}

// ── Exports ──

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    let bump = bump_read();
    let new_bump = bump + ((size + 3) & !3);
    if new_bump > 65536 {
        return 0;
    }
    bump_write(new_bump);
    bump
}

#[no_mangle]
pub extern "C" fn handle(params_ptr: u32, params_len: u32) -> u64 {
    let params =
        unsafe { core::slice::from_raw_parts(params_ptr as *const u8, params_len as usize) };
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
        "grant_role" => handle_grant_role(&fields),
        "revoke_role" => handle_revoke_role(&fields),
        "role_of" => handle_role_of(&fields),
        "is_registered" => handle_is_registered(&fields),
        "has_role" => handle_has_role(&fields),
        "list_counts" => handle_list_counts(),
        "transfer" => {
            log("registry: transfer rejected — roles are non-transferable");
            json_reject("soulbound: non-transferable")
        }
        _ => err("unknown operation"),
    }
}

// ── Operation handlers ──

fn handle_configure(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    let proposal_id = field(fields, "proposal_id");

    if admin_did.is_empty() {
        return err("missing required fields: admin_did");
    }

    let existing_admin = state_get("config:admin");
    match &existing_admin {
        Some(admin) => {
            if admin_sig.is_empty() {
                return err("admin signature required for reconfiguration");
            }
            if !verify_sig(admin, "configure:player-registry", admin_sig) {
                return err("Unauthorized");
            }
        }
        None => {
            if proposal_id.is_empty() {
                return err("governance proposal_id required for initial configuration");
            }
            if !check_governance(proposal_id) {
                return err("governance has not approved this registry configuration");
            }
            log("registry: initial configuration (governance-approved bootstrap)");
        }
    }

    let _ = state_set("config:admin", admin_did);

    log("registry: configured");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"admin\":\"");
    write_bytes(&mut buf, &mut off, admin_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_grant_role(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let signature = field(fields, "signature");
    let player_did = field(fields, "player_did");
    let role = field(fields, "role");

    if player_did.is_empty() || role.is_empty() {
        return err("missing required fields: player_did, role");
    }

    let normalized = match normalize_role(role) {
        Some(r) => r,
        None => return err("InvalidRole"),
    };

    // Admin gate: ports `non_admin_cannot_mint` / `set_sbt_contract_unauthorized`.
    let admin = state_get("config:admin");
    match &admin {
        Some(a) => {
            if admin_did != a.deref() {
                return err("Unauthorized");
            }
            if signature.is_empty() {
                return err("Unauthorized");
            }
            let mut msg_buf: [u8; 512] = [0; 512];
            let mut msg_len = 0;
            write_bytes(&mut msg_buf, &mut msg_len, b"grant:");
            write_bytes(&mut msg_buf, &mut msg_len, player_did.as_bytes());
            write_bytes(&mut msg_buf, &mut msg_len, b":");
            write_bytes(&mut msg_buf, &mut msg_len, normalized.as_bytes());
            let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
            if !verify_sig(admin_did, msg, signature) {
                return err("Unauthorized");
            }
        }
        None => return err("Unauthorized"),
    }

    // Duplicate grant: ports `mint_duplicate_fails`.
    if state_get(&player_key(player_did, "role")).is_some() {
        return err("AlreadyRegistered");
    }

    let _ = state_set(&player_key(player_did, "role"), normalized);
    let block = current_block();
    set_state_u64(&player_key(player_did, "granted_block"), block);

    let total = get_count("total").unwrap_or(0) + 1;
    set_state_u64("count:total", total);
    let role_count = get_count(normalized).unwrap_or(0) + 1;
    let mut ck = KeyBuf::new();
    ck.push_str("count:");
    ck.push_str(normalized);
    set_state_u64(&ck, role_count);

    log("registry: role granted");

    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"did\":\"");
    write_bytes(&mut buf, &mut off, player_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"role\":\"");
    write_bytes(&mut buf, &mut off, normalized.as_bytes());
    write_bytes(
        &mut buf,
        &mut off,
        b"\",\"soulbound\":true,\"total_holders\":",
    );
    off += write_u64_decimal(&mut buf, off, total);
    write_bytes(&mut buf, &mut off, b",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_revoke_role(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let signature = field(fields, "signature");
    let player_did = field(fields, "player_did");

    if player_did.is_empty() {
        return err("missing required field: player_did");
    }

    let admin = state_get("config:admin");
    match &admin {
        Some(a) => {
            if admin_did != a.deref() {
                return err("Unauthorized");
            }
            if signature.is_empty() {
                return err("Unauthorized");
            }
            let mut msg_buf: [u8; 384] = [0; 384];
            let mut msg_len = 0;
            write_bytes(&mut msg_buf, &mut msg_len, b"revoke:");
            write_bytes(&mut msg_buf, &mut msg_len, player_did.as_bytes());
            let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
            if !verify_sig(admin_did, msg, signature) {
                return err("Unauthorized");
            }
        }
        None => return err("Unauthorized"),
    }

    if state_get(&player_key(player_did, "role")).is_none() {
        return err("NotFound");
    }

    let _ = state_set(&player_key(player_did, "revoked"), "1");
    let block = current_block();
    set_state_u64(&player_key(player_did, "receipt"), block);

    log("registry: role revoked");

    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"did\":\"");
    write_bytes(&mut buf, &mut off, player_did.as_bytes());
    write_bytes(
        &mut buf,
        &mut off,
        b"\",\"revoked\":true,\"receipt_block\":",
    );
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_role_of(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let did = field(fields, "did");
    if did.is_empty() {
        return err("missing required field: did");
    }

    // Ports `role_of_no_token`: an identity with no role token errors.
    let role = match state_get(&player_key(did, "role")) {
        Some(r) => r,
        None => return err("NoRoleToken"),
    };
    let revoked = state_get(&player_key(did, "revoked")).is_some();

    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"did\":\"");
    write_bytes(&mut buf, &mut off, did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"role\":\"");
    write_bytes(&mut buf, &mut off, role.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"revoked\":");
    if revoked {
        write_bytes(&mut buf, &mut off, b"true");
    } else {
        write_bytes(&mut buf, &mut off, b"false");
    }
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_is_registered(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let did = field(fields, "did");
    if did.is_empty() {
        return err("missing required field: did");
    }
    let registered = state_get(&player_key(did, "role")).is_some()
        && state_get(&player_key(did, "revoked")).is_none();

    let mut buf: [u8; 96] = [0; 96];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"registered\":");
    if registered {
        write_bytes(&mut buf, &mut off, b"true");
    } else {
        write_bytes(&mut buf, &mut off, b"false");
    }
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_has_role(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let did = field(fields, "did");
    let role = field(fields, "role");
    if did.is_empty() || role.is_empty() {
        return err("missing required fields: did, role");
    }
    let normalized = match normalize_role(role) {
        Some(r) => r,
        None => return err("InvalidRole"),
    };

    let has = match state_get(&player_key(did, "role")) {
        Some(r) => r.deref() == normalized && state_get(&player_key(did, "revoked")).is_none(),
        None => false,
    };

    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    if has {
        write_bytes(
            &mut buf,
            &mut off,
            b"{\"ok\":true,\"has_role\":true,\"role\":\"",
        );
        write_bytes(&mut buf, &mut off, normalized.as_bytes());
        write_bytes(&mut buf, &mut off, b"\"}");
    } else {
        write_bytes(
            &mut buf,
            &mut off,
            b"{\"ok\":false,\"error\":\"InsufficientRole\"}",
        );
    }
    write_result(&buf[..off])
}

fn handle_list_counts() -> u64 {
    let total = get_count("total").unwrap_or(0);
    let players = get_count("player").unwrap_or(0);
    let gamemasters = get_count("gamemaster").unwrap_or(0);
    let auditors = get_count("auditor").unwrap_or(0);

    let mut buf: [u8; 192] = [0; 192];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"total\":");
    off += write_u64_decimal(&mut buf, off, total);
    write_bytes(&mut buf, &mut off, b",\"player\":");
    off += write_u64_decimal(&mut buf, off, players);
    write_bytes(&mut buf, &mut off, b",\"gamemaster\":");
    off += write_u64_decimal(&mut buf, off, gamemasters);
    write_bytes(&mut buf, &mut off, b",\"auditor\":");
    off += write_u64_decimal(&mut buf, off, auditors);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

// ── Registry helpers ──

fn player_key(did: &str, suffix: &str) -> KeyBuf {
    let mut buf = KeyBuf::new();
    buf.push_str("p:");
    buf.push_str(did);
    buf.push_str(":");
    buf.push_str(suffix);
    buf
}

fn normalize_role(role: &str) -> Option<&'static str> {
    match role {
        "player" | "Player" | "PLAYER" => Some("player"),
        "gamemaster" | "GameMaster" | "gm" | "GAMEMASTER" => Some("gamemaster"),
        "auditor" | "Auditor" | "AUDITOR" => Some("auditor"),
        _ => None,
    }
}

fn get_count(kind: &str) -> Option<u64> {
    let mut key = KeyBuf::new();
    key.push_str("count:");
    key.push_str(kind);
    state_get(&key).and_then(|s| parse_u64_str(s.deref()))
}

// ── State helpers ──

fn set_state_u64(key: &str, n: u64) {
    let mut buf: [u8; 20] = [0; 20];
    let len = write_u64_decimal(&mut buf, 0, n);
    let _ = state_set_raw(key, &buf[..len]);
}

fn state_set(key: &str, value: &str) -> bool {
    state_set_raw(key, value.as_bytes())
}

fn state_set_raw(key: &str, value: &[u8]) -> bool {
    unsafe {
        host_store_state(
            key.as_ptr(),
            key.len() as u32,
            value.as_ptr(),
            value.len() as u32,
        ) == 0
    }
}

fn state_get(key: &str) -> Option<StateVal> {
    let mut buf = StateBuf::new();
    let packed = unsafe {
        host_load_state(
            key.as_ptr(),
            key.len() as u32,
            buf.data.as_mut_ptr(),
            buf.data.len() as u32,
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

fn verify_sig(did: &str, msg: &str, sig: &str) -> bool {
    unsafe {
        host_verify_signature(
            did.as_ptr(),
            did.len() as u32,
            msg.as_ptr(),
            msg.len() as u32,
            sig.as_ptr(),
            sig.len() as u32,
        ) == 1
    }
}

fn current_block() -> u64 {
    unsafe { host_current_block_height() }
}

fn check_governance(proposal_id: &str) -> bool {
    unsafe { host_check_governance_approval(proposal_id.as_ptr(), proposal_id.len() as u32) == 1 }
}

// ── Buffer types ──

struct KeyBuf {
    data: [u8; 256],
    len: usize,
}

impl KeyBuf {
    fn new() -> Self {
        KeyBuf {
            data: [0; 256],
            len: 0,
        }
    }

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
    fn new() -> Self {
        StateBuf {
            data: [0; 512],
            len: 0,
        }
    }
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

fn parse_fields(s: &str) -> Option<[(StackStr, StackStr); 12]> {
    let s = s.trim();
    if !s.starts_with('{') || !s.ends_with('}') {
        return None;
    }
    let inner = &s[1..s.len() - 1];
    let mut fields: [(StackStr, StackStr); 12] = [(StackStr::empty(), StackStr::empty()); 12];
    let mut count = 0;
    let bytes = inner.as_bytes();
    let mut i = 0;
    let max_i = bytes.len();
    while i < max_i && count < 12 {
        while i < max_i && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= max_i || bytes[i] == b'}' {
            break;
        }
        if bytes[i] != b'"' {
            return None;
        }
        i += 1;
        let key_start = i;
        while i < max_i && bytes[i] != b'"' {
            if bytes[i] == b'\\' {
                i += 1;
            }
            i += 1;
        }
        if i >= max_i {
            return None;
        }
        let key = StackStr::from_slice(&inner.as_bytes()[key_start..i]);
        i += 1;
        while i < max_i && (bytes[i].is_ascii_whitespace() || bytes[i] == b':') {
            i += 1;
        }
        if i >= max_i {
            return None;
        }
        let val_start = i;
        if bytes[i] == b'"' {
            i += 1;
            while i < max_i && bytes[i] != b'"' {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            fields[count] = (
                key,
                StackStr::from_slice(&inner.as_bytes()[val_start + 1..i - 1]),
            );
        } else if bytes[i] == b'{' || bytes[i] == b'[' {
            let open = bytes[i];
            let close = if open == b'{' { b'}' } else { b']' };
            let mut depth = 0;
            while i < max_i {
                if bytes[i] == open {
                    depth += 1;
                } else if bytes[i] == close {
                    depth -= 1;
                }
                i += 1;
                if depth == 0 {
                    break;
                }
            }
            fields[count] = (key, StackStr::from_slice(&inner.as_bytes()[val_start..i]));
        } else {
            while i < max_i && bytes[i] != b',' && bytes[i] != b'}' {
                i += 1;
            }
            fields[count] = (key, StackStr::from_slice(&inner.as_bytes()[val_start..i]));
        }
        count += 1;
        if i < max_i && bytes[i] == b',' {
            i += 1;
        }
    }
    if count > 0 {
        Some(fields)
    } else {
        None
    }
}

#[derive(Copy, Clone)]
struct StackStr {
    ptr: *const u8,
    len: u32,
}

impl StackStr {
    fn empty() -> Self {
        StackStr {
            ptr: core::ptr::null(),
            len: 0,
        }
    }
    fn from_slice(s: &[u8]) -> Self {
        StackStr {
            ptr: s.as_ptr(),
            len: s.len() as u32,
        }
    }
    fn as_str(&self) -> &str {
        if self.len == 0 {
            return "";
        }
        unsafe {
            core::str::from_utf8_unchecked(core::slice::from_raw_parts(self.ptr, self.len as usize))
        }
    }
}

fn field<'a>(fields: &'a [(StackStr, StackStr); 12], name: &str) -> &'a str {
    for (k, v) in fields {
        if k.as_str() == name {
            return v.as_str();
        }
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
    if ptr == 0 {
        return 0;
    }
    let dest = unsafe { core::slice::from_raw_parts_mut(ptr as *mut u8, len as usize) };
    dest.copy_from_slice(data);
    ((ptr as u64) << 32) | (len as u64)
}

fn write_u64_decimal(buf: &mut [u8], off: usize, mut n: u64) -> usize {
    if n == 0 {
        buf[off] = b'0';
        return 1;
    }
    let mut digits: [u8; 20] = [0; 20];
    let mut cnt = 0;
    while n > 0 {
        digits[cnt] = (n % 10) as u8 + b'0';
        n /= 10;
        cnt += 1;
    }
    for i in (0..cnt).rev() {
        buf[off + cnt - 1 - i] = digits[i];
    }
    cnt
}

fn err(reason: &str) -> u64 {
    let mut buf: [u8; 160] = [0; 160];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":false,\"error\":\"");
    write_bytes(&mut buf, &mut off, reason.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn json_reject(reason: &str) -> u64 {
    let mut buf: [u8; 160] = [0; 160];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":false,\"reason\":\"");
    write_bytes(&mut buf, &mut off, reason.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
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
    if any {
        Some(result)
    } else {
        None
    }
}

fn log(msg: &str) {
    unsafe {
        host_log(msg.as_ptr(), msg.len() as u32);
    }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
