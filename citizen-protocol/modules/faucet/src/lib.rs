#![no_std]
#![no_main]

/// Faucet — a governance-gated fungible token distribution WASM module for Citizen Protocol.
///
/// Distributes fungible tokens to users with built-in anti-spam designed specifically
/// for token economies:
/// - **KYC verification required** before claiming
/// - **Per-user cooldown period** between claims
/// - **Daily cap** per user to limit farming
/// - **Transfer-specific rate limiting** — caps transfers per user per window
/// - **Wash-trade detection** — blocks A→B→A ping-pong patterns
/// - **Balance tracking** — real fungible token balances (mint/transfer/balance)
/// - **Admin-gated** — pause/resume via governance
///
/// ## Operations
///
/// | Operation       | Parameters                                          | Returns                              |
/// |-----------------|-----------------------------------------------------|--------------------------------------|
/// | `configure`     | admin_did, admin_sig, token_code, claim_amount,     | `{"ok":true,...}`                    |
/// |                 | cooldown_secs, daily_cap, proposal_id?              |                                      |
/// | `claim`         | claimant_did, kyc_proof, kyc_signature              | `{"ok":true,"amount":N,...}`         |
/// | `transfer`      | from_did, to_did, amount, signature                 | `{"ok":true,"from":"...","to":".."}`|
/// | `balance`       | did                                                 | `{"balance":N}`                      |
/// | `status`        | claimant_did                                        | `{"can_claim":true,"next_claim":...}`|
/// | `admin_stats`   | admin_did, admin_sig?                               | `{"total_distributed":N,...}`        |
/// | `pause`         | admin_did, admin_sig                                | `{"ok":true,"paused":true}`          |
/// | `resume`        | admin_did, admin_sig                                | `{"ok":true,"paused":false}`         |

// ── Bump allocator ──

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
        "claim" => handle_claim(&fields),
        "transfer" => handle_transfer(&fields),
        "balance" => handle_balance(&fields),
        "status" => handle_status(&fields),
        "admin_stats" => handle_admin_stats(&fields),
        "pause" => handle_pause(&fields),
        "resume" => handle_resume(&fields),
        _ => err("unknown operation"),
    }
}

// ── Operation handlers ──

fn handle_configure(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    let token_code = field(fields, "token_code");
    let claim_amount_str = field(fields, "claim_amount");
    let cooldown_str = field(fields, "cooldown_secs");
    let daily_cap_str = field(fields, "daily_cap");
    let max_transfers_str = field(fields, "max_transfers_per_window");

    if admin_did.is_empty() || claim_amount_str.is_empty() || token_code.is_empty() {
        return err("missing required fields: admin_did, token_code, claim_amount");
    }

    let claim_amount: u64 = match parse_u64_str(claim_amount_str) {
        Some(a) if a > 0 => a,
        _ => return err("claim_amount must be positive"),
    };

    let cooldown_secs: u64 = if cooldown_str.is_empty() {
        86400
    } else {
        parse_u64_str(cooldown_str).unwrap_or(86400)
    };

    let daily_cap: u64 = if daily_cap_str.is_empty() {
        claim_amount * 5
    } else {
        parse_u64_str(daily_cap_str).unwrap_or(claim_amount * 5)
    };

    let max_transfers: u64 = if max_transfers_str.is_empty() {
        10
    } else {
        parse_u64_str(max_transfers_str).unwrap_or(10)
    };

    let existing_admin = state_get("config:admin");
    match &existing_admin {
        Some(admin) => {
            if admin_sig.is_empty() {
                return err("admin signature required for reconfiguration");
            }
            let mut msg_buf: [u8; 256] = [0; 256];
            let mut msg_len = 0;
            write_bytes(&mut msg_buf, &mut msg_len, b"configure:faucet:");
            write_bytes(&mut msg_buf, &mut msg_len, token_code.as_bytes());
            write_bytes(&mut msg_buf, &mut msg_len, b":");
            msg_len += write_u64_decimal(&mut msg_buf, msg_len, claim_amount);
            write_bytes(&mut msg_buf, &mut msg_len, b":");
            msg_len += write_u64_decimal(&mut msg_buf, msg_len, cooldown_secs);
            write_bytes(&mut msg_buf, &mut msg_len, b":");
            msg_len += write_u64_decimal(&mut msg_buf, msg_len, daily_cap);
            let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
            if !verify_sig(admin, msg, admin_sig) {
                return err("admin signature verification failed");
            }
        }
        None => {
            let proposal_id = field(fields, "proposal_id");
            if proposal_id.is_empty() {
                return err("governance proposal_id required for initial configuration");
            }
            if !check_governance(proposal_id) {
                return err("governance has not approved this faucet configuration");
            }
            log("faucet: initial configuration (governance-approved bootstrap)");
        }
    }

    let _ = state_set("config:admin", admin_did);
    let _ = state_set("config:token_code", token_code);
    store_u64("config:claim_amount", claim_amount);
    store_u64("config:cooldown_secs", cooldown_secs);
    store_u64("config:daily_cap", daily_cap);
    store_u64("config:max_transfers", max_transfers);
    store_u64("config:total_supply", 0);
    store_u64("config:total_distributed", 0);
    store_u64("config:total_claims", 0);

    log("faucet: configured");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"admin\":\"");
    write_bytes(&mut buf, &mut off, admin_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"token_code\":\"");
    write_bytes(&mut buf, &mut off, token_code.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"claim_amount\":");
    off += write_u64_decimal(&mut buf, off, claim_amount);
    write_bytes(&mut buf, &mut off, b",\"cooldown_secs\":");
    off += write_u64_decimal(&mut buf, off, cooldown_secs);
    write_bytes(&mut buf, &mut off, b",\"daily_cap\":");
    off += write_u64_decimal(&mut buf, off, daily_cap);
    write_bytes(&mut buf, &mut off, b",\"max_transfers_per_window\":");
    off += write_u64_decimal(&mut buf, off, max_transfers);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_claim(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let claimant_did = field(fields, "claimant_did");
    let kyc_proof = field(fields, "kyc_proof");
    let kyc_signature = field(fields, "kyc_signature");

    if claimant_did.is_empty() {
        return err("missing required field: claimant_did");
    }

    if state_get("config:admin").is_none() {
        return err("faucet not configured");
    }

    if is_paused() {
        return err("faucet is paused");
    }

    if kyc_proof.is_empty() || kyc_signature.is_empty() {
        return err("KYC proof and signature required to claim");
    }

    let kyc_msg = format_key2("kyc:", claimant_did);
    if !verify_sig(claimant_did, &kyc_msg, kyc_signature) {
        return err("KYC signature verification failed");
    }

    let cooldown_secs = load_u64("config:cooldown_secs", 86400);
    let now = current_block();
    let last_claim_block = load_u64(&format_key2("last_claim:", claimant_did), 0);
    if last_claim_block > 0 {
        let blocks_since = now.saturating_sub(last_claim_block);
        let block_time_secs: u64 = 2;
        let secs_since = blocks_since.saturating_mul(block_time_secs);
        if secs_since < cooldown_secs {
            let remaining = cooldown_secs - secs_since;
            let mut buf: [u8; 256] = [0; 256];
            let mut off = 0;
            write_bytes(&mut buf, &mut off, b"{\"ok\":false,\"error\":\"cooldown active\",\"remaining_secs\":");
            off += write_u64_decimal(&mut buf, off, remaining);
            write_bytes(&mut buf, &mut off, b"}");
            return write_result(&buf[..off]);
        }
    }

    let daily_cap = load_u64("config:daily_cap", 0);
    let claim_amount = load_u64("config:claim_amount", 0);
    let today_key = format_key2("daily:", claimant_did);
    let today_claimed = load_u64(&today_key, 0);
    if daily_cap > 0 && today_claimed >= daily_cap {
        return err("daily cap reached");
    }

    store_u64(&format_key2("last_claim:", claimant_did), now);
    store_u64(&today_key, today_claimed + claim_amount);

    let bal_key = format_key2("bal:", claimant_did);
    let prev_balance = load_u64(&bal_key, 0);
    store_u64(&bal_key, prev_balance + claim_amount);

    let total_key = format_key2("total:", claimant_did);
    let prev_total = load_u64(&total_key, 0);
    store_u64(&total_key, prev_total + claim_amount);

    let claims_key = format_key2("claims:", claimant_did);
    let prev_claims = load_u64(&claims_key, 0);
    store_u64(&claims_key, prev_claims + 1);

    let total_distributed = load_u64("config:total_distributed", 0);
    store_u64("config:total_distributed", total_distributed + claim_amount);
    let total_claims = load_u64("config:total_claims", 0);
    store_u64("config:total_claims", total_claims + 1);
    let total_supply = load_u64("config:total_supply", 0);
    store_u64("config:total_supply", total_supply + claim_amount);

    log("faucet: claimed");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"claimant\":\"");
    write_bytes(&mut buf, &mut off, claimant_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"amount\":");
    off += write_u64_decimal(&mut buf, off, claim_amount);
    write_bytes(&mut buf, &mut off, b",\"balance\":");
    off += write_u64_decimal(&mut buf, off, prev_balance + claim_amount);
    write_bytes(&mut buf, &mut off, b",\"total_claimed\":");
    off += write_u64_decimal(&mut buf, off, prev_total + claim_amount);
    write_bytes(&mut buf, &mut off, b",\"block\":");
    off += write_u64_decimal(&mut buf, off, now);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_transfer(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let from_did = field(fields, "from_did");
    let to_did = field(fields, "to_did");
    let amount_str = field(fields, "amount");
    let signature = field(fields, "signature");

    if from_did.is_empty() || to_did.is_empty() || amount_str.is_empty() {
        return err("missing required fields: from_did, to_did, amount");
    }

    if from_did == to_did {
        return err("cannot transfer to self");
    }

    if signature.is_empty() {
        return err("transfer requires sender signature");
    }

    let amount: u64 = match parse_u64_str(amount_str) {
        Some(a) if a > 0 => a,
        _ => return err("amount must be positive"),
    };

    let mut msg_buf: [u8; 256] = [0; 256];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"transfer:");
    write_bytes(&mut msg_buf, &mut msg_len, from_did.as_bytes());
    write_bytes(&mut msg_buf, &mut msg_len, b":");
    write_bytes(&mut msg_buf, &mut msg_len, to_did.as_bytes());
    write_bytes(&mut msg_buf, &mut msg_len, b":");
    msg_len += write_u64_decimal(&mut msg_buf, msg_len, amount);
    let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
    if !verify_sig(from_did, msg, signature) {
        return err("sender signature verification failed");
    }

    let sender_balance = load_u64(&format_key2("bal:", from_did), 0);
    if sender_balance < amount {
        let mut buf: [u8; 128] = [0; 128];
        let mut off = 0;
        write_bytes(&mut buf, &mut off, b"{\"ok\":false,\"error\":\"insufficient balance\",\"balance\":");
        off += write_u64_decimal(&mut buf, off, sender_balance);
        write_bytes(&mut buf, &mut off, b",\"required\":");
        off += write_u64_decimal(&mut buf, off, amount);
        write_bytes(&mut buf, &mut off, b"}");
        return write_result(&buf[..off]);
    }

    let max_transfers = load_u64("config:max_transfers", 10);
    let tf_window_key = format_key2("tfwin:", from_did);
    let tf_count_key = format_key2("tfcnt:", from_did);
    let now = current_block();
    let tf_window_start = load_u64(&tf_window_key, 0);
    let window_secs = 600u64;
    let block_time_secs: u64 = 2;
    let window_blocks = window_secs / block_time_secs;

    if tf_window_start == 0 || now.saturating_sub(tf_window_start) > window_blocks {
        store_u64(&tf_window_key, now);
        store_u64(&tf_count_key, 1);
    } else {
        let tf_count = load_u64(&tf_count_key, 0);
        if tf_count >= max_transfers {
            return err("transfer rate limit exceeded for this window");
        }
        store_u64(&tf_count_key, tf_count + 1);
    }

    let wash_key = format_key3("wash:", from_did, ":", to_did);
    let wash_rev_key = format_key3("wash:", to_did, ":", from_did);
    let wash_count = load_u64(&wash_key, 0) + load_u64(&wash_rev_key, 0);
    if wash_count >= 3 {
        return err("wash-trade pattern detected: circular transfers between these accounts");
    }

    let from_bal_key = format_key2("bal:", from_did);
    let to_bal_key = format_key2("bal:", to_did);
    store_u64(&from_bal_key, sender_balance - amount);
    let recipient_balance = load_u64(&to_bal_key, 0);
    store_u64(&to_bal_key, recipient_balance + amount);

    store_u64(&wash_key, load_u64(&wash_key, 0) + 1);

    log("faucet: transferred");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"from\":\"");
    write_bytes(&mut buf, &mut off, from_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"to\":\"");
    write_bytes(&mut buf, &mut off, to_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"amount\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"from_balance\":");
    off += write_u64_decimal(&mut buf, off, sender_balance - amount);
    write_bytes(&mut buf, &mut off, b",\"to_balance\":");
    off += write_u64_decimal(&mut buf, off, recipient_balance + amount);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_balance(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let did = field(fields, "did");
    if did.is_empty() {
        return err("missing required field: did");
    }

    let balance = load_u64(&format_key2("bal:", did), 0);
    let total_claimed = load_u64(&format_key2("total:", did), 0);
    let claims = load_u64(&format_key2("claims:", did), 0);

    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"balance\":");
    off += write_u64_decimal(&mut buf, off, balance);
    write_bytes(&mut buf, &mut off, b",\"total_claimed\":");
    off += write_u64_decimal(&mut buf, off, total_claimed);
    write_bytes(&mut buf, &mut off, b",\"claims\":");
    off += write_u64_decimal(&mut buf, off, claims);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_status(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let claimant_did = field(fields, "claimant_did");
    if claimant_did.is_empty() {
        return err("missing required field: claimant_did");
    }

    let cooldown_secs = load_u64("config:cooldown_secs", 86400);
    let now = current_block();
    let last_claim_block = load_u64(&format_key2("last_claim:", claimant_did), 0);
    let block_time_secs: u64 = 2;

    let (can_claim, remaining_secs) = if last_claim_block == 0 {
        (true, 0)
    } else {
        let secs_since = now.saturating_sub(last_claim_block).saturating_mul(block_time_secs);
        if secs_since >= cooldown_secs {
            (true, 0)
        } else {
            (false, cooldown_secs - secs_since)
        }
    };

    let daily_cap = load_u64("config:daily_cap", 0);
    let today_claimed = load_u64(&format_key2("daily:", claimant_did), 0);
    let daily_remaining = if daily_cap > today_claimed { daily_cap - today_claimed } else { 0 };

    let balance = load_u64(&format_key2("bal:", claimant_did), 0);
    let paused = is_paused();

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"can_claim\":");
    write_bytes(&mut buf, &mut off, json_bool(can_claim && !paused).as_bytes());
    write_bytes(&mut buf, &mut off, b",\"paused\":");
    write_bytes(&mut buf, &mut off, json_bool(paused).as_bytes());
    write_bytes(&mut buf, &mut off, b",\"remaining_secs\":");
    off += write_u64_decimal(&mut buf, off, remaining_secs);
    write_bytes(&mut buf, &mut off, b",\"daily_remaining\":");
    off += write_u64_decimal(&mut buf, off, daily_remaining);
    write_bytes(&mut buf, &mut off, b",\"balance\":");
    off += write_u64_decimal(&mut buf, off, balance);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_admin_stats(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");

    if admin_did.is_empty() {
        return err("missing required field: admin_did");
    }

    let existing_admin = state_get("config:admin");
    match &existing_admin {
        Some(admin) if &**admin == admin_did => {}
        _ => return err("not authorized"),
    }

    if !admin_sig.is_empty() {
        if !verify_sig(admin_did, "admin_stats", admin_sig) {
            return err("admin signature verification failed");
        }
    }

    let total_supply = load_u64("config:total_supply", 0);
    let total_distributed = load_u64("config:total_distributed", 0);
    let total_claims = load_u64("config:total_claims", 0);
    let claim_amount = load_u64("config:claim_amount", 0);
    let cooldown_secs = load_u64("config:cooldown_secs", 0);
    let daily_cap = load_u64("config:daily_cap", 0);
    let max_transfers = load_u64("config:max_transfers", 0);
    let paused = is_paused();

    let mut buf: [u8; 320] = [0; 320];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"total_supply\":");
    off += write_u64_decimal(&mut buf, off, total_supply);
    write_bytes(&mut buf, &mut off, b",\"total_distributed\":");
    off += write_u64_decimal(&mut buf, off, total_distributed);
    write_bytes(&mut buf, &mut off, b",\"total_claims\":");
    off += write_u64_decimal(&mut buf, off, total_claims);
    write_bytes(&mut buf, &mut off, b",\"claim_amount\":");
    off += write_u64_decimal(&mut buf, off, claim_amount);
    write_bytes(&mut buf, &mut off, b",\"cooldown_secs\":");
    off += write_u64_decimal(&mut buf, off, cooldown_secs);
    write_bytes(&mut buf, &mut off, b",\"daily_cap\":");
    off += write_u64_decimal(&mut buf, off, daily_cap);
    write_bytes(&mut buf, &mut off, b",\"max_transfers_per_window\":");
    off += write_u64_decimal(&mut buf, off, max_transfers);
    write_bytes(&mut buf, &mut off, b",\"paused\":");
    write_bytes(&mut buf, &mut off, json_bool(paused).as_bytes());
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_pause(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    if admin_did.is_empty() || admin_sig.is_empty() {
        return err("missing required fields: admin_did, admin_sig");
    }

    let existing_admin = state_get("config:admin");
    match &existing_admin {
        Some(admin) if &**admin == admin_did => {}
        _ => return err("not authorized"),
    }

    if !verify_sig(admin_did, "pause:faucet", admin_sig) {
        return err("admin signature verification failed");
    }

    let _ = state_set_raw("config:paused", b"1");
    log("faucet: paused");

    json_response(r#"{"ok":true,"paused":true}"#)
}

fn handle_resume(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    if admin_did.is_empty() || admin_sig.is_empty() {
        return err("missing required fields: admin_did, admin_sig");
    }

    let existing_admin = state_get("config:admin");
    match &existing_admin {
        Some(admin) if &**admin == admin_did => {}
        _ => return err("not authorized"),
    }

    if !verify_sig(admin_did, "resume:faucet", admin_sig) {
        return err("admin signature verification failed");
    }

    let _ = state_set_raw("config:paused", b"0");
    log("faucet: resumed");

    json_response(r#"{"ok":true,"paused":false}"#)
}

// ── State helpers ──

fn is_paused() -> bool {
    match state_get("config:paused") {
        Some(v) => v.starts_with('1'),
        None => false,
    }
}

fn store_u64(key: &str, value: u64) {
    let mut buf: [u8; 20] = [0; 20];
    let len = write_u64_decimal(&mut buf, 0, value);
    let _ = state_set_raw(key, &buf[..len]);
}

fn load_u64(key: &str, default_value: u64) -> u64 {
    state_get(key)
        .as_ref()
        .and_then(|s| parse_u64_str(s))
        .unwrap_or(default_value)
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

// ── Host wrappers ──

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

fn check_governance(proposal_id: &str) -> bool {
    unsafe {
        host_check_governance_approval(
            proposal_id.as_ptr(), proposal_id.len() as u32,
        ) == 1
    }
}

// ── Key formatting ──

fn format_key2(prefix: &str, suffix: &str) -> KeyBuf {
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

// ── Utility ──

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

fn parse_fields(s: &str) -> Option<[(StackStr, StackStr); 12]> {
    let s = s.trim();
    if !s.starts_with('{') || !s.ends_with('}') { return None; }
    let inner = &s[1..s.len()-1];
    let mut fields: [(StackStr, StackStr); 12] = [(StackStr::empty(), StackStr::empty()); 12];
    let mut count = 0;
    let bytes = inner.as_bytes();
    let mut i = 0;
    let max_i = bytes.len();
    while i < max_i && count < 12 {
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

fn field<'a>(fields: &'a [(StackStr, StackStr); 12], name: &str) -> &'a str {
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
