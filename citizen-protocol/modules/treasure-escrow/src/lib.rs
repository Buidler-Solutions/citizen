#![no_std]
#![no_main]

/// Treasure Escrow — Citizen Protocol port of the TreasureNet Stellar escrow
/// contract. Holds an escrowed reward for a treasure hunt and releases it via
/// a 2-of-2 multisig claim (Game Master + photo-verification oracle) or an
/// owner-signed refund after expiry.
///
/// ## Statuses
///
/// | Stored status | Meaning                                              |
/// |---------------|------------------------------------------------------|
/// | `created`     | Initialized, not yet funded                          |
/// | `funded`      | Reward funded; claimable while not expired           |
/// | `completed`   | Claim executed, reward paid to winner                |
/// | `refunded`    | Owner reclaimed the reward after expiry              |
///
/// Derived statuses reported by `get_status`:
/// `Active` (funded, before deadline), `Expired` (created/funded, past
/// deadline), otherwise the stored status.
///
/// ## Operations
///
/// | Operation     | Parameters                                          | Notes |
/// |---------------|-----------------------------------------------------|-------|
/// | `configure`   | admin_did, oracles, proposal_id, admin_sig?         | Governance-gated bootstrap; sets admin + oracle set |
/// | `init`        | escrow_id, owner_did, claimer_did, amount, token, deadline_block | Creates escrow in `created` |
/// | `fund`        | escrow_id, funder_did, signature                    | Owner-only; `created` -> `funded` |
/// | `claim`       | escrow_id, winner_did, cosigner_dids, signatures    | 2-of-2: owner + authorized oracle over `claim:<id>:<winner>` |
/// | `refund`      | escrow_id, owner_did, signature                     | Owner-only, after deadline |
/// | `is_expired`  | escrow_id                                           | bool |
/// | `get_status`  | escrow_id                                           | Derived status string |
/// | `get_reward`  | escrow_id                                           | amount + token |
///
/// ## Error cases (ported from the Stellar contract)
///
/// `NotOwner`, `AlreadyFunded`, `NotActive`, `Expired`, `AlreadyClaimed`,
/// `NotExpired`, plus `Uninitialized` and `AlreadyInitialized` for lifecycle
/// guards. Multisig additions: `NotOwner` (GM signature missing/invalid) and
/// `OracleSignatureRequired`.
use core::ops::Deref;

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
        "init" => handle_init(&fields),
        "fund" => handle_fund(&fields),
        "claim" => handle_claim(&fields),
        "refund" => handle_refund(&fields),
        "is_expired" => handle_is_expired(&fields),
        "get_status" => handle_get_status(&fields),
        "get_reward" => handle_get_reward(&fields),
        _ => err("unknown operation"),
    }
}

// ── Operation handlers ──

fn handle_configure(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    let oracles = field(fields, "oracles");
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
            let mut msg_buf: [u8; 384] = [0; 384];
            let mut msg_len = 0;
            write_bytes(&mut msg_buf, &mut msg_len, b"configure:");
            write_bytes(&mut msg_buf, &mut msg_len, oracles.as_bytes());
            let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
            if !verify_sig(admin, msg, admin_sig) {
                return err("admin signature verification failed");
            }
        }
        None => {
            if proposal_id.is_empty() {
                return err("governance proposal_id required for initial configuration");
            }
            if !check_governance(proposal_id) {
                return err("governance has not approved this escrow configuration");
            }
            log("escrow: initial configuration (governance-approved bootstrap)");
        }
    }

    let _ = state_set("config:admin", admin_did);
    if !oracles.is_empty() {
        let _ = state_set("config:oracles", oracles);
    }

    log("escrow: configured");

    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"admin\":\"");
    write_bytes(&mut buf, &mut off, admin_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"oracles\":\"");
    write_bytes(&mut buf, &mut off, oracles.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_init(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let escrow_id = field(fields, "escrow_id");
    let owner_did = field(fields, "owner_did");
    let claimer_did = field(fields, "claimer_did");
    let amount_str = field(fields, "amount");
    let token = field(fields, "token");
    let deadline_str = field(fields, "deadline_block");

    if escrow_id.is_empty() || owner_did.is_empty() || claimer_did.is_empty() {
        return err("missing required fields: escrow_id, owner_did, claimer_did");
    }

    let amount = match parse_u64_str(amount_str) {
        Some(a) if a > 0 => a,
        _ => return err("InvalidAmount"),
    };
    let deadline = match parse_u64_str(deadline_str) {
        Some(d) if d > 0 => d,
        _ => return err("InvalidDeadline"),
    };

    if status_of(escrow_id).is_some() {
        return err("AlreadyInitialized");
    }

    let token_name: &str = if token.is_empty() { "CTZN" } else { token };

    let mut k = KeyBuf::new();
    k.push_str("esc:");
    k.push_str(escrow_id);
    k.push_str(":");
    let base = k;

    let mut key = base.clone_key();
    key.push_str("owner");
    let _ = state_set(&key, owner_did);
    let mut key = base.clone_key();
    key.push_str("claimer");
    let _ = state_set(&key, claimer_did);
    let mut key = base.clone_key();
    key.push_str("amount");
    set_state_u64(&key, amount);
    let mut key = base.clone_key();
    key.push_str("token");
    let _ = state_set(&key, token_name);
    let mut key = base.clone_key();
    key.push_str("deadline");
    set_state_u64(&key, deadline);
    let mut key = base.clone_key();
    key.push_str("status");
    let _ = state_set(&key, "created");

    let block = current_block();
    let mut key = base.clone_key();
    key.push_str("receipt");
    set_state_u64(&key, block);

    log("escrow: init");

    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"escrow_id\":\"");
    write_bytes(&mut buf, &mut off, escrow_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"status\":\"created\",\"amount\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"token\":\"");
    write_bytes(&mut buf, &mut off, token_name.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"deadline_block\":");
    off += write_u64_decimal(&mut buf, off, deadline);
    write_bytes(&mut buf, &mut off, b",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_fund(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let escrow_id = field(fields, "escrow_id");
    let funder_did = field(fields, "funder_did");
    let signature = field(fields, "signature");

    if escrow_id.is_empty() || funder_did.is_empty() {
        return err("missing required fields: escrow_id, funder_did");
    }

    let status = match status_of(escrow_id) {
        Some(s) => s,
        None => return err("Uninitialized"),
    };
    if status.deref() != "created" {
        return err("AlreadyFunded");
    }

    let owner = match state_get(&escrow_key(escrow_id, "owner")) {
        Some(v) => v,
        None => return err("Uninitialized"),
    };
    if funder_did != owner.deref() {
        return err("NotOwner");
    }

    let mut msg_buf: [u8; 320] = [0; 320];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"fund:");
    write_bytes(&mut msg_buf, &mut msg_len, escrow_id.as_bytes());
    let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
    if signature.is_empty() {
        return err("SignatureRequired");
    }
    if !verify_sig(funder_did, msg, signature) {
        return err("NotOwner");
    }

    let _ = state_set(&escrow_key(escrow_id, "status"), "funded");
    let block = current_block();
    set_state_u64(&escrow_key(escrow_id, "receipt"), block);

    log("escrow: funded");

    let amount = escrow_amount(escrow_id).unwrap_or(0);
    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"escrow_id\":\"");
    write_bytes(&mut buf, &mut off, escrow_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"status\":\"funded\",\"amount\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_claim(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let escrow_id = field(fields, "escrow_id");
    let winner_did = field(fields, "winner_did");
    let cosigner_dids = field(fields, "cosigner_dids");
    let signatures = field(fields, "signatures");

    if escrow_id.is_empty() || winner_did.is_empty() {
        return err("missing required fields: escrow_id, winner_did");
    }

    let status = match status_of(escrow_id) {
        Some(s) => s,
        None => return err("Uninitialized"),
    };

    let deadline = escrow_deadline(escrow_id).unwrap_or(0);
    let now = current_block();

    if status.deref() == "completed" {
        return err("AlreadyClaimed");
    }
    if status.deref() == "refunded" {
        return err("NotActive");
    }
    if status.deref() == "created" {
        return err("NotActive");
    }
    if deadline > 0 && now > deadline {
        return err("Expired");
    }

    // 2-of-2 multisig: Game Master (escrow owner) + authorized oracle.
    let owner = match state_get(&escrow_key(escrow_id, "owner")) {
        Some(v) => v,
        None => return err("Uninitialized"),
    };

    let mut msg_buf: [u8; 512] = [0; 512];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"claim:");
    write_bytes(&mut msg_buf, &mut msg_len, escrow_id.as_bytes());
    write_bytes(&mut msg_buf, &mut msg_len, b":");
    write_bytes(&mut msg_buf, &mut msg_len, winner_did.as_bytes());
    let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");

    let mut dids: [&str; 16] = [""; 16];
    let mut sigs: [&str; 16] = [""; 16];
    let n_dids = split_commas(cosigner_dids, &mut dids);
    let n_sigs = split_commas(signatures, &mut sigs);

    let oracles = state_get("config:oracles");
    let oracle_str = oracles.as_deref().unwrap_or("");
    let mut oracle_list: [&str; 16] = [""; 16];
    let n_oracles = if oracle_str.is_empty() {
        0
    } else {
        split_commas(oracle_str, &mut oracle_list)
    };

    let mut owner_signed = false;
    let mut oracle_signed = false;

    let n = n_dids.min(n_sigs);
    for i in 0..n {
        let did = dids[i];
        let sig = sigs[i];
        if did.is_empty() || sig.is_empty() {
            continue;
        }
        if !verify_sig(did, msg, sig) {
            continue;
        }
        if did == owner.deref() {
            owner_signed = true;
        }
        if n_oracles > 0 && is_in_list(did, &oracle_list[..n_oracles]) {
            oracle_signed = true;
        }
    }

    if !owner_signed {
        return err("NotOwner");
    }
    if !oracle_signed {
        return err("OracleSignatureRequired");
    }

    let _ = state_set(&escrow_key(escrow_id, "status"), "completed");
    let _ = state_set(&escrow_key(escrow_id, "winner"), winner_did);
    let block = current_block();
    set_state_u64(&escrow_key(escrow_id, "receipt"), block);

    let amount = escrow_amount(escrow_id).unwrap_or(0);
    let token = state_get(&escrow_key(escrow_id, "token"));

    // Payout record: consumed by the CTZN token distribution step.
    let mut payout: [u8; 512] = [0; 512];
    let mut plen = 0;
    write_bytes(&mut payout, &mut plen, winner_did.as_bytes());
    write_bytes(&mut payout, &mut plen, b":");
    plen += write_u64_decimal(&mut payout, plen, amount);
    write_bytes(&mut payout, &mut plen, b":");
    plen += write_u64_decimal(&mut payout, plen, block);
    let mut pkey = KeyBuf::new();
    pkey.push_str("payout:");
    pkey.push_str(escrow_id);
    let _ = state_set_raw(&pkey, &payout[..plen]);

    log("escrow: claim executed (2-of-2 multisig payout)");

    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"escrow_id\":\"");
    write_bytes(&mut buf, &mut off, escrow_id.as_bytes());
    write_bytes(
        &mut buf,
        &mut off,
        b"\",\"status\":\"completed\",\"winner\":\"",
    );
    write_bytes(&mut buf, &mut off, winner_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"payout\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"token\":\"");
    if let Some(t) = &token {
        write_bytes(&mut buf, &mut off, t.as_bytes());
    }
    write_bytes(&mut buf, &mut off, b"\",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_refund(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let escrow_id = field(fields, "escrow_id");
    let owner_did = field(fields, "owner_did");
    let signature = field(fields, "signature");

    if escrow_id.is_empty() || owner_did.is_empty() {
        return err("missing required fields: escrow_id, owner_did");
    }

    let status = match status_of(escrow_id) {
        Some(s) => s,
        None => return err("Uninitialized"),
    };

    let owner = match state_get(&escrow_key(escrow_id, "owner")) {
        Some(v) => v,
        None => return err("Uninitialized"),
    };
    if owner_did != owner.deref() {
        return err("NotOwner");
    }

    let deadline = escrow_deadline(escrow_id).unwrap_or(0);
    let now = current_block();

    if status.deref() == "completed" {
        return err("NotActive");
    }
    if status.deref() == "refunded" {
        return err("NotActive");
    }
    if deadline == 0 || now <= deadline {
        return err("NotExpired");
    }

    let mut msg_buf: [u8; 320] = [0; 320];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"refund:");
    write_bytes(&mut msg_buf, &mut msg_len, escrow_id.as_bytes());
    let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
    if signature.is_empty() {
        return err("SignatureRequired");
    }
    if !verify_sig(owner_did, msg, signature) {
        return err("NotOwner");
    }

    let _ = state_set(&escrow_key(escrow_id, "status"), "refunded");
    let block = current_block();
    set_state_u64(&escrow_key(escrow_id, "receipt"), block);

    log("escrow: refunded after expiry");

    let amount = escrow_amount(escrow_id).unwrap_or(0);
    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"escrow_id\":\"");
    write_bytes(&mut buf, &mut off, escrow_id.as_bytes());
    write_bytes(
        &mut buf,
        &mut off,
        b"\",\"status\":\"refunded\",\"refund\":",
    );
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_is_expired(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let escrow_id = field(fields, "escrow_id");
    if escrow_id.is_empty() {
        return err("missing required field: escrow_id");
    }
    if status_of(escrow_id).is_none() {
        return err("Uninitialized");
    }
    let expired = is_expired_now(escrow_id);
    let mut buf: [u8; 96] = [0; 96];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"expired\":");
    write_bytes(&mut buf, &mut off, json_bool(expired).as_bytes());
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_get_status(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let escrow_id = field(fields, "escrow_id");
    if escrow_id.is_empty() {
        return err("missing required field: escrow_id");
    }
    let stored = match status_of(escrow_id) {
        Some(s) => s,
        None => return err("Uninitialized"),
    };
    let derived = derived_status(escrow_id, &stored);
    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"status\":\"");
    write_bytes(&mut buf, &mut off, derived.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_get_reward(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let escrow_id = field(fields, "escrow_id");
    if escrow_id.is_empty() {
        return err("missing required field: escrow_id");
    }
    if status_of(escrow_id).is_none() {
        return err("Uninitialized");
    }
    let amount = escrow_amount(escrow_id).unwrap_or(0);
    let token = state_get(&escrow_key(escrow_id, "token"));
    let mut buf: [u8; 160] = [0; 160];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"amount\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"token\":\"");
    if let Some(t) = &token {
        write_bytes(&mut buf, &mut off, t.as_bytes());
    }
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

// ── Escrow state helpers ──

fn escrow_key(escrow_id: &str, suffix: &str) -> KeyBuf {
    let mut buf = KeyBuf::new();
    buf.push_str("esc:");
    buf.push_str(escrow_id);
    buf.push_str(":");
    buf.push_str(suffix);
    buf
}

fn status_of(escrow_id: &str) -> Option<StateVal> {
    state_get(&escrow_key(escrow_id, "status"))
}

fn escrow_amount(escrow_id: &str) -> Option<u64> {
    state_get(&escrow_key(escrow_id, "amount")).and_then(|s| parse_u64_str(s.deref()))
}

fn escrow_deadline(escrow_id: &str) -> Option<u64> {
    state_get(&escrow_key(escrow_id, "deadline")).and_then(|s| parse_u64_str(s.deref()))
}

fn is_expired_now(escrow_id: &str) -> bool {
    let deadline = escrow_deadline(escrow_id).unwrap_or(0);
    deadline > 0 && current_block() > deadline
}

fn derived_status(escrow_id: &str, stored: &str) -> &'static str {
    match stored {
        "created" | "funded" => {
            if is_expired_now(escrow_id) {
                "Expired"
            } else if stored == "funded" {
                "Active"
            } else {
                "Created"
            }
        }
        "completed" => "Completed",
        "refunded" => "Refunded",
        _ => "Unknown",
    }
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

// ── Utility ──

fn split_commas<'a>(s: &'a str, out: &mut [&'a str; 16]) -> usize {
    let mut count = 0;
    let mut start = 0;
    for (i, b) in s.as_bytes().iter().enumerate() {
        if *b == b',' {
            if start < i && count < 16 {
                out[count] = &s[start..i];
                count += 1;
            }
            start = i + 1;
        }
    }
    if start < s.len() && count < 16 {
        out[count] = &s[start..];
        count += 1;
    }
    count
}

fn is_in_list(item: &str, list: &[&str]) -> bool {
    for s in list {
        if *s == item {
            return true;
        }
    }
    false
}

fn json_bool(b: bool) -> &'static str {
    if b {
        "true"
    } else {
        "false"
    }
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

    fn clone_key(&self) -> Self {
        let mut buf = KeyBuf::new();
        buf.push_str(core::str::from_utf8(&self.data[..self.len]).unwrap_or(""));
        buf
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
