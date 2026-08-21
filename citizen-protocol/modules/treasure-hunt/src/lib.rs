#![no_std]
#![no_main]

use core::ops::Deref;

/// Treasure Hunt — Citizen Protocol port of the TreasureNet Stellar
/// treasure-hunt contract. Manages the full lifecycle of a GPS treasure hunt:
/// creation by a Game Master, funding, activation, pause/resume,
/// cancellation, 2-of-2 multisig claim payout (GM + oracle), and refund after
/// expiry.
///
/// ## Hunt statuses (ported)
///
/// `Created`, `Funded`, `Active`, `Paused`, `Completed`, `Expired`,
/// `Refunded`, `Cancelled`. `Expired` is derived (deadline passed while the
/// hunt is still claimable); `Completed`/`Refunded`/`Cancelled` are terminal.
///
/// ## Operations
///
/// | Operation     | Parameters                                                   | Notes |
/// |---------------|--------------------------------------------------------------|-------|
/// | `configure`   | admin_did, oracles, proposal_id, admin_sig?                  | Governance-gated bootstrap |
/// | `create_hunt` | hunt_id, gm_did, signature, reward_amount, reward_token, expires_block, escrow_id? | GM-signed `create:<id>:<gm>` |
/// | `fund_hunt`   | hunt_id, funder_did, signature, amount                       | GM-only, `created` -> `funded` |
/// | `activate`    | hunt_id, gm_did, signature                                   | `funded` -> `active` |
/// | `pause`       | hunt_id, gm_did, signature                                   | `active` -> `paused` |
/// | `resume`      | hunt_id, gm_did, signature                                   | `paused` -> `active` |
/// | `cancel`      | hunt_id, gm_did, signature                                   | GM-only, pre-activation only |
/// | `claim`       | hunt_id, winner_did, cosigner_dids, signatures               | 2-of-2 GM + oracle over `claim:<id>:<winner>` |
/// | `refund`      | hunt_id, gm_did, signature                                   | GM-only, after expiry |
/// | `get_hunt`    | hunt_id                                                      | Full hunt state |
///
/// ## Error cases (ported from the Stellar contract)
///
/// `AlreadyExists`, `NotFound`, `NotOwner`, `InsufficientFunds`,
/// `AlreadyActive`, `NotActive`, `Expired`, `AlreadyClaimed`, `NotPaused`,
/// `AlreadyPaused`, `CannotCancel`, `TransferFailed`, `InvalidStatus`.

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
        "create_hunt" => handle_create_hunt(&fields),
        "fund_hunt" => handle_fund_hunt(&fields),
        "activate" => handle_activate(&fields),
        "pause" => handle_pause(&fields),
        "resume" => handle_resume(&fields),
        "cancel" => handle_cancel(&fields),
        "claim" => handle_claim(&fields),
        "set_claim_delegate" => handle_set_claim_delegate(&fields),
        "refund" => handle_refund(&fields),
        "get_hunt" => handle_get_hunt(&fields),
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
                return err("governance has not approved this hunt module configuration");
            }
            log("hunt: initial configuration (governance-approved bootstrap)");
        }
    }

    let _ = state_set("config:admin", admin_did);
    if !oracles.is_empty() {
        let _ = state_set("config:oracles", oracles);
    }

    log("hunt: configured");

    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"admin\":\"");
    write_bytes(&mut buf, &mut off, admin_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"oracles\":\"");
    write_bytes(&mut buf, &mut off, oracles.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_create_hunt(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let hunt_id = field(fields, "hunt_id");
    let gm_did = field(fields, "gm_did");
    let signature = field(fields, "signature");
    let reward_str = field(fields, "reward_amount");
    let reward_token = field(fields, "reward_token");
    let expires_str = field(fields, "expires_block");
    let escrow_id = field(fields, "escrow_id");

    if hunt_id.is_empty() || gm_did.is_empty() {
        return err("missing required fields: hunt_id, gm_did");
    }

    let reward = match parse_u64_str(reward_str) {
        Some(r) if r > 0 => r,
        _ => return err("InvalidAmount"),
    };
    let expires = match parse_u64_str(expires_str) {
        Some(e) if e > current_block() => e,
        _ => return err("InvalidStatus"),
    };

    if hunt_status(hunt_id).is_some() {
        return err("AlreadyExists");
    }

    if signature.is_empty() {
        return err("SignatureRequired");
    }
    let msg = sign_msg(b"create:", hunt_id, b":", gm_did);
    if !verify_sig(gm_did, &msg, signature) {
        return err("NotOwner");
    }

    let token_name: &str = if reward_token.is_empty() {
        "CTZN"
    } else {
        reward_token
    };

    let _ = state_set(&hunt_key(hunt_id, "gm"), gm_did);
    set_state_u64(&hunt_key(hunt_id, "reward"), reward);
    let _ = state_set(&hunt_key(hunt_id, "token"), token_name);
    set_state_u64(&hunt_key(hunt_id, "expires"), expires);
    if !escrow_id.is_empty() {
        let _ = state_set(&hunt_key(hunt_id, "escrow"), escrow_id);
    }
    let _ = state_set(&hunt_key(hunt_id, "status"), "created");
    let block = current_block();
    set_state_u64(&hunt_key(hunt_id, "receipt"), block);

    log("hunt: created");

    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"hunt_id\":\"");
    write_bytes(&mut buf, &mut off, hunt_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"status\":\"Created\",\"gm\":\"");
    write_bytes(&mut buf, &mut off, gm_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"reward\":");
    off += write_u64_decimal(&mut buf, off, reward);
    write_bytes(&mut buf, &mut off, b",\"token\":\"");
    write_bytes(&mut buf, &mut off, token_name.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"expires_block\":");
    off += write_u64_decimal(&mut buf, off, expires);
    write_bytes(&mut buf, &mut off, b",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_fund_hunt(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let hunt_id = field(fields, "hunt_id");
    let funder_did = field(fields, "funder_did");
    let signature = field(fields, "signature");
    let amount_str = field(fields, "amount");

    if hunt_id.is_empty() || funder_did.is_empty() {
        return err("missing required fields: hunt_id, funder_did");
    }

    let status = match hunt_status(hunt_id) {
        Some(s) => s,
        None => return err("NotFound"),
    };
    if status.deref() != "created" {
        return err("AlreadyFunded");
    }

    let gm = match state_get(&hunt_key(hunt_id, "gm")) {
        Some(v) => v,
        None => return err("NotFound"),
    };
    if funder_did != gm.deref() {
        return err("NotOwner");
    }

    let amount = match parse_u64_str(amount_str) {
        Some(a) => a,
        None => return err("InsufficientFunds"),
    };
    let reward = hunt_reward(hunt_id).unwrap_or(0);
    if amount < reward {
        return err("InsufficientFunds");
    }

    if signature.is_empty() {
        return err("SignatureRequired");
    }
    let msg = sign_msg(b"fund:", hunt_id, b":", funder_did);
    if !verify_sig(funder_did, &msg, signature) {
        return err("NotOwner");
    }

    let _ = state_set(&hunt_key(hunt_id, "status"), "funded");
    let block = current_block();
    set_state_u64(&hunt_key(hunt_id, "receipt"), block);

    log("hunt: funded");

    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"hunt_id\":\"");
    write_bytes(&mut buf, &mut off, hunt_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"status\":\"Funded\",\"funded\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_activate(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let (hunt_id, gm_did, signature, ok) = gm_op_fields(fields);
    if !ok {
        return err("missing required fields: hunt_id, gm_did");
    }

    let status = match hunt_status(hunt_id) {
        Some(s) => s,
        None => return err("NotFound"),
    };
    match status.deref() {
        "active" => return err("AlreadyActive"),
        "funded" => {}
        _ => return err("InvalidStatus"),
    }

    if !gm_authorized(hunt_id, gm_did, signature, b"activate:") {
        return err("NotOwner");
    }

    let _ = state_set(&hunt_key(hunt_id, "status"), "active");
    let block = current_block();
    set_state_u64(&hunt_key(hunt_id, "receipt"), block);

    log("hunt: activated");

    status_response(hunt_id, "Active", block)
}

fn handle_pause(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let (hunt_id, gm_did, signature, ok) = gm_op_fields(fields);
    if !ok {
        return err("missing required fields: hunt_id, gm_did");
    }

    let status = match hunt_status(hunt_id) {
        Some(s) => s,
        None => return err("NotFound"),
    };
    match status.deref() {
        "paused" => return err("AlreadyPaused"),
        "active" => {}
        _ => return err("NotActive"),
    }

    if !gm_authorized(hunt_id, gm_did, signature, b"pause:") {
        return err("NotOwner");
    }

    let _ = state_set(&hunt_key(hunt_id, "status"), "paused");
    let block = current_block();
    set_state_u64(&hunt_key(hunt_id, "receipt"), block);

    log("hunt: paused");

    status_response(hunt_id, "Paused", block)
}

fn handle_resume(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let (hunt_id, gm_did, signature, ok) = gm_op_fields(fields);
    if !ok {
        return err("missing required fields: hunt_id, gm_did");
    }

    let status = match hunt_status(hunt_id) {
        Some(s) => s,
        None => return err("NotFound"),
    };
    if status.deref() != "paused" {
        return err("NotPaused");
    }

    if !gm_authorized(hunt_id, gm_did, signature, b"resume:") {
        return err("NotOwner");
    }

    let _ = state_set(&hunt_key(hunt_id, "status"), "active");
    let block = current_block();
    set_state_u64(&hunt_key(hunt_id, "receipt"), block);

    log("hunt: resumed");

    status_response(hunt_id, "Active", block)
}

fn handle_cancel(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let (hunt_id, gm_did, signature, ok) = gm_op_fields(fields);
    if !ok {
        return err("missing required fields: hunt_id, gm_did");
    }

    let status = match hunt_status(hunt_id) {
        Some(s) => s,
        None => return err("NotFound"),
    };
    match status.deref() {
        "created" | "funded" => {}
        _ => return err("CannotCancel"),
    }

    if !gm_authorized(hunt_id, gm_did, signature, b"cancel:") {
        return err("NotOwner");
    }

    let _ = state_set(&hunt_key(hunt_id, "status"), "cancelled");
    let block = current_block();
    set_state_u64(&hunt_key(hunt_id, "receipt"), block);

    log("hunt: cancelled");

    status_response(hunt_id, "Cancelled", block)
}

fn handle_claim(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let hunt_id = field(fields, "hunt_id");
    let winner_did = field(fields, "winner_did");
    let cosigner_dids = field(fields, "cosigner_dids");
    let signatures = field(fields, "signatures");

    if hunt_id.is_empty() || winner_did.is_empty() {
        return err("missing required fields: hunt_id, winner_did");
    }

    let status = match hunt_status(hunt_id) {
        Some(s) => s,
        None => return err("NotFound"),
    };

    // Double-claim prevention: status must still be claimable and no prior
    // claim marker may exist. Both checks are enforced here so a replayed or
    // racing second claim can never succeed.
    if state_get(&hunt_key(hunt_id, "claimed")).is_some() {
        return err("AlreadyClaimed");
    }
    match status.deref() {
        "completed" => return err("AlreadyClaimed"),
        "active" => {}
        "paused" => return err("NotActive"),
        _ => return err("NotActive"),
    }

    let expires = hunt_expires(hunt_id).unwrap_or(0);
    if expires > 0 && current_block() > expires {
        return err("Expired");
    }

    // 2-of-2 multisig: Game Master (or their delegated claim signer) plus
    // an authorized photo oracle.
    let gm = match state_get(&hunt_key(hunt_id, "gm")) {
        Some(v) => v,
        None => return err("NotFound"),
    };
    let delegate = state_get(&hunt_key(hunt_id, "delegate"));

    let mut msg_buf: [u8; 512] = [0; 512];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"claim:");
    write_bytes(&mut msg_buf, &mut msg_len, hunt_id.as_bytes());
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

    let mut gm_signed = false;
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
        if did == gm.deref() {
            gm_signed = true;
        }
        if let Some(d) = &delegate {
            if !d.deref().is_empty() && did == d.deref() {
                gm_signed = true;
            }
        }
        if n_oracles > 0 && is_in_list(did, &oracle_list[..n_oracles]) {
            oracle_signed = true;
        }
    }

    if !gm_signed {
        return err("NotOwner");
    }
    if !oracle_signed {
        return err("OracleSignatureRequired");
    }

    let _ = state_set(&hunt_key(hunt_id, "status"), "completed");
    let _ = state_set(&hunt_key(hunt_id, "winner"), winner_did);
    let _ = state_set(&hunt_key(hunt_id, "claimed"), "1");
    let block = current_block();
    set_state_u64(&hunt_key(hunt_id, "receipt"), block);

    let reward = hunt_reward(hunt_id).unwrap_or(0);

    // Payout record consumed by the CTZN token distribution step.
    let mut payout: [u8; 512] = [0; 512];
    let mut plen = 0;
    write_bytes(&mut payout, &mut plen, winner_did.as_bytes());
    write_bytes(&mut payout, &mut plen, b":");
    plen += write_u64_decimal(&mut payout, plen, reward);
    write_bytes(&mut payout, &mut plen, b":");
    plen += write_u64_decimal(&mut payout, plen, block);
    let mut pkey = KeyBuf::new();
    pkey.push_str("payout:");
    pkey.push_str(hunt_id);
    if !state_set_raw(&pkey, &payout[..plen]) {
        // Mirrors the Stellar TransferFailed case: the payout record could
        // not be persisted, so the claim must not be reported as paid.
        let _ = state_set(&hunt_key(hunt_id, "status"), "active");
        return err("TransferFailed");
    }

    log("hunt: claim executed (2-of-2 multisig payout)");

    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"hunt_id\":\"");
    write_bytes(&mut buf, &mut off, hunt_id.as_bytes());
    write_bytes(
        &mut buf,
        &mut off,
        b"\",\"status\":\"Completed\",\"winner\":\"",
    );
    write_bytes(&mut buf, &mut off, winner_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"payout\":");
    off += write_u64_decimal(&mut buf, off, reward);
    write_bytes(&mut buf, &mut off, b",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

/// GM-signed claim delegation: the hunt GM authorizes a delegate DID to
/// sign claims in their place (instant-settlement hunts). Signature over
/// `delegate:<hunt_id>:<delegate_did>`; refund stays GM-only.
fn handle_set_claim_delegate(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let hunt_id = field(fields, "hunt_id");
    let gm_did = field(fields, "gm_did");
    let signature = field(fields, "signature");
    let delegate_did = field(fields, "delegate_did");

    if hunt_id.is_empty() || gm_did.is_empty() || delegate_did.is_empty() {
        return err("missing required fields: hunt_id, gm_did, delegate_did");
    }
    if hunt_status(hunt_id).is_none() {
        return err("NotFound");
    }
    let gm = match state_get(&hunt_key(hunt_id, "gm")) {
        Some(v) => v,
        None => return err("NotFound"),
    };
    if gm_did != gm.deref() {
        return err("NotOwner");
    }
    if signature.is_empty() {
        return err("SignatureRequired");
    }
    let mut msg_buf: [u8; 384] = [0; 384];
    let mut msg_len = 0;
    write_bytes(&mut msg_buf, &mut msg_len, b"delegate:");
    write_bytes(&mut msg_buf, &mut msg_len, hunt_id.as_bytes());
    write_bytes(&mut msg_buf, &mut msg_len, b":");
    write_bytes(&mut msg_buf, &mut msg_len, delegate_did.as_bytes());
    let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
    if !verify_sig(gm_did, msg, signature) {
        return err("NotOwner");
    }

    let _ = state_set(&hunt_key(hunt_id, "delegate"), delegate_did);

    log("hunt: claim delegate set");

    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"hunt_id\":\"");
    write_bytes(&mut buf, &mut off, hunt_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"delegate\":\"");
    write_bytes(&mut buf, &mut off, delegate_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_refund(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let (hunt_id, gm_did, signature, ok) = gm_op_fields(fields);
    if !ok {
        return err("missing required fields: hunt_id, gm_did");
    }

    let status = match hunt_status(hunt_id) {
        Some(s) => s,
        None => return err("NotFound"),
    };
    match status.deref() {
        "completed" => return err("AlreadyClaimed"),
        "cancelled" | "refunded" => return err("InvalidStatus"),
        "created" => return err("NotActive"),
        _ => {}
    }

    let expires = hunt_expires(hunt_id).unwrap_or(0);
    if expires == 0 || current_block() <= expires {
        return err("NotExpired");
    }

    if !gm_authorized(hunt_id, gm_did, signature, b"refund:") {
        return err("NotOwner");
    }

    let _ = state_set(&hunt_key(hunt_id, "status"), "refunded");
    let block = current_block();
    set_state_u64(&hunt_key(hunt_id, "receipt"), block);

    log("hunt: refunded after expiry");

    let reward = hunt_reward(hunt_id).unwrap_or(0);
    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"hunt_id\":\"");
    write_bytes(&mut buf, &mut off, hunt_id.as_bytes());
    write_bytes(
        &mut buf,
        &mut off,
        b"\",\"status\":\"Refunded\",\"refund\":",
    );
    off += write_u64_decimal(&mut buf, off, reward);
    write_bytes(&mut buf, &mut off, b",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_get_hunt(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let hunt_id = field(fields, "hunt_id");
    if hunt_id.is_empty() {
        return err("missing required field: hunt_id");
    }
    let stored = match hunt_status(hunt_id) {
        Some(s) => s,
        None => return err("NotFound"),
    };

    let stored_str = stored.deref();
    let derived: &str = match stored_str {
        "created" | "funded" | "active" | "paused" => {
            let expires = hunt_expires(hunt_id).unwrap_or(0);
            if expires > 0 && current_block() > expires {
                "Expired"
            } else {
                match stored_str {
                    "created" => "Created",
                    "funded" => "Funded",
                    "active" => "Active",
                    _ => "Paused",
                }
            }
        }
        "completed" => "Completed",
        "refunded" => "Refunded",
        "cancelled" => "Cancelled",
        _ => "Unknown",
    };

    let reward = hunt_reward(hunt_id).unwrap_or(0);
    let expires = hunt_expires(hunt_id).unwrap_or(0);
    let gm = state_get(&hunt_key(hunt_id, "gm"));
    let token = state_get(&hunt_key(hunt_id, "token"));
    let winner = state_get(&hunt_key(hunt_id, "winner"));
    let escrow = state_get(&hunt_key(hunt_id, "escrow"));

    let mut buf: [u8; 1024] = [0; 1024];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"hunt_id\":\"");
    write_bytes(&mut buf, &mut off, hunt_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"status\":\"");
    write_bytes(&mut buf, &mut off, derived.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"gm\":\"");
    if let Some(g) = &gm {
        write_bytes(&mut buf, &mut off, g.as_bytes());
    }
    write_bytes(&mut buf, &mut off, b"\",\"reward\":");
    off += write_u64_decimal(&mut buf, off, reward);
    write_bytes(&mut buf, &mut off, b",\"token\":\"");
    if let Some(t) = &token {
        write_bytes(&mut buf, &mut off, t.as_bytes());
    }
    write_bytes(&mut buf, &mut off, b"\",\"expires_block\":");
    off += write_u64_decimal(&mut buf, off, expires);
    write_bytes(&mut buf, &mut off, b",\"escrow_id\":\"");
    if let Some(e) = &escrow {
        write_bytes(&mut buf, &mut off, e.as_bytes());
    }
    write_bytes(&mut buf, &mut off, b"\",\"winner\":\"");
    if let Some(w) = &winner {
        write_bytes(&mut buf, &mut off, w.as_bytes());
    }
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

// ── Shared handler helpers ──

fn gm_op_fields(fields: &[(StackStr, StackStr); 12]) -> (&str, &str, &str, bool) {
    let hunt_id = field(fields, "hunt_id");
    let gm_did = field(fields, "gm_did");
    let signature = field(fields, "signature");
    let ok = !hunt_id.is_empty() && !gm_did.is_empty();
    (hunt_id, gm_did, signature, ok)
}

fn gm_authorized(hunt_id: &str, gm_did: &str, signature: &str, prefix: &[u8]) -> bool {
    let gm = match state_get(&hunt_key(hunt_id, "gm")) {
        Some(v) => v,
        None => return false,
    };
    if gm_did != gm.deref() {
        return false;
    }
    if signature.is_empty() {
        return false;
    }
    let msg = sign_msg(prefix, hunt_id, b":", gm_did);
    verify_sig(gm_did, &msg, signature)
}

fn sign_msg(prefix: &[u8], id: &str, sep: &[u8], did: &str) -> KeyBuf {
    let mut buf = KeyBuf::new();
    buf.push_bytes(prefix);
    buf.push_str(id);
    buf.push_bytes(sep);
    buf.push_str(did);
    buf
}

fn status_response(hunt_id: &str, status: &str, block: u64) -> u64 {
    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"hunt_id\":\"");
    write_bytes(&mut buf, &mut off, hunt_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"status\":\"");
    write_bytes(&mut buf, &mut off, status.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"receipt_block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

// ── Hunt state helpers ──

fn hunt_key(hunt_id: &str, suffix: &str) -> KeyBuf {
    let mut buf = KeyBuf::new();
    buf.push_str("hunt:");
    buf.push_str(hunt_id);
    buf.push_str(":");
    buf.push_str(suffix);
    buf
}

fn hunt_status(hunt_id: &str) -> Option<StateVal> {
    state_get(&hunt_key(hunt_id, "status"))
}

fn hunt_reward(hunt_id: &str) -> Option<u64> {
    state_get(&hunt_key(hunt_id, "reward")).and_then(|s| parse_u64_str(s.deref()))
}

fn hunt_expires(hunt_id: &str) -> Option<u64> {
    state_get(&hunt_key(hunt_id, "expires")).and_then(|s| parse_u64_str(s.deref()))
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
        self.push_bytes(s.as_bytes());
    }

    fn push_bytes(&mut self, bytes: &[u8]) {
        for &b in bytes {
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
