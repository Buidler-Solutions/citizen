#![no_std]
#![no_main]

/// Citizen Asset — a generic transferable-token WASM module for Citizen Protocol.
///
/// Unlike the soulbound CTZN identity token, assets minted here are freely
/// transferable fungible tokens, and custody can be locked into **timed
/// multisig vaults**: an account that requires M-of-N approver signatures to
/// move funds before an expiry block, after which a designated fallback
/// owner (e.g. the depositor) can reclaim alone. This is the primitive
/// TreasureNet escrow uses for real reward custody, and it generalizes to
/// crowdfunding refunds, delayed payments, and governance-gated releases.
///
/// ## Operations
///
/// | Operation        | Parameters                                                     | Returns                            |
/// |------------------|----------------------------------------------------------------|------------------------------------|
/// | `configure`      | admin_did, issuers, threshold, proposal_id? / admin_sig?       | `{"ok":true,"issuers":N,...}`      |
/// | `create_token`   | token_id, symbol, decimals, issuer_dids, signatures            | `{"ok":true,"token_id":...}`       |
/// | `mint`           | token_id, recipient_did, amount, ref, issuer_dids, signatures  | `{"ok":true,"balance":N,...}`      |
/// | `burn`           | token_id, owner_did, amount, ref, signature                    | `{"ok":true,"balance":N}`          |
/// | `transfer`       | token_id, from_did, to_did, amount, ref, signature             | `{"ok":true,"balance":N}`          |
/// | `open_vault`     | vault_id, token_id, approver_dids, threshold, expiry_block,    | `{"ok":true,"vault":...}`          |
/// |                  | fallback_owner_did, admin_did, admin_sig                       |                                    |
/// | `vault_transfer` | vault_id, token_id, to_did, amount, ref, cosigner_dids,        | `{"ok":true,"balance":N}`          |
/// |                  | signatures                                                     |                                    |
/// | `vault_info`     | vault_id                                                       | `{"vault_id":...,"expired":B,...}` |
/// | `balance`        | token_id, did                                                  | `{"balance":N}`                    |
/// | `token_info`     | token_id                                                       | `{"symbol":...,"total_supply":N}`  |
///
/// Signed messages (all suffix `:<ref>` gives replay-safe uniqueness):
/// - `create:<token_id>:<symbol>:<decimals>`
/// - `mint:<token_id>:<recipient_did>:<amount>:<ref>`
/// - `burn:<token_id>:<owner_did>:<amount>:<ref>`
/// - `transfer:<token_id>:<from_did>:<to_did>:<amount>:<ref>`
/// - `vopen:<vault_id>:<token_id>:<threshold>:<expiry_block>` (admin)
/// - `vt:<vault_id>:<to_did>:<amount>:<ref>` (approvers before expiry,
///   fallback owner at/after expiry)

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

use core::ops::Deref;

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
        "create_token" => handle_create_token(&fields),
        "mint" => handle_mint(&fields),
        "burn" => handle_burn(&fields),
        "transfer" => handle_transfer(&fields),
        "open_vault" => handle_open_vault(&fields),
        "vault_transfer" => handle_vault_transfer(&fields),
        "vault_info" => handle_vault_info(&fields),
        "balance" => handle_balance(&fields),
        "token_info" => handle_token_info(&fields),
        _ => err("unknown operation"),
    }
}

// ── Operation handlers ──

fn handle_configure(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");
    let issuers = field(fields, "issuers");
    let threshold_str = field(fields, "threshold");

    if admin_did.is_empty() || issuers.is_empty() {
        return err("missing required fields: admin_did, issuers");
    }

    let threshold: u64 = if threshold_str.is_empty() {
        1
    } else {
        match parse_u64_str(threshold_str) {
            Some(t) if t >= 1 => t,
            _ => return err("invalid threshold"),
        }
    };

    let existing_admin = state_get("cfg:admin");
    match &existing_admin {
        Some(admin) => {
            if admin_sig.is_empty() {
                return err("admin signature required for reconfiguration");
            }
            let msg = configure_msg(issuers, threshold);
            if !verify_sig(admin, &msg, admin_sig) {
                return err("admin signature verification failed");
            }
        }
        None => {
            // Bootstrap requires explicit governance approval, mirroring
            // ctzn-token: no one can self-appoint the issuer set.
            let proposal_id = field(fields, "proposal_id");
            if proposal_id.is_empty() {
                return err("governance proposal_id required for initial configuration");
            }
            if !check_governance(proposal_id) {
                return err("governance has not approved this asset configuration");
            }
            log("asset: initial configuration (governance-approved bootstrap)");
        }
    }

    let _ = state_set("cfg:admin", admin_did);
    let _ = state_set("cfg:issuers", issuers);
    set_state_u64("cfg:threshold", threshold);

    let mut tmp: [&str; 16] = [""; 16];
    let n_issuers = split_commas(issuers, &mut tmp);

    log("asset: configured");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"admin\":\"");
    write_bytes(&mut buf, &mut off, admin_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"issuers\":");
    off += write_u64_decimal(&mut buf, off, n_issuers as u64);
    write_bytes(&mut buf, &mut off, b",\"threshold\":");
    off += write_u64_decimal(&mut buf, off, threshold);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_create_token(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let token_id = field(fields, "token_id");
    let symbol = field(fields, "symbol");
    let decimals_str = field(fields, "decimals");
    let issuer_dids = field(fields, "issuer_dids");
    let signatures = field(fields, "signatures");

    if token_id.is_empty() || symbol.is_empty() {
        return err("missing required fields: token_id, symbol");
    }
    if state_get("cfg:admin").is_none() {
        return err("asset module not configured");
    }
    if token_meta(token_id).is_some() {
        return err("TokenExists");
    }

    let decimals: u64 = if decimals_str.is_empty() {
        0
    } else {
        match parse_u64_str(decimals_str) {
            Some(d) if d <= 18 => d,
            _ => return err("invalid decimals (0-18)"),
        }
    };

    let msg = create_token_msg(token_id, symbol, decimals);
    if count_valid_sigs(issuer_dids, signatures, &msg) < issuer_threshold() {
        return err("issuer threshold not met");
    }

    let mut meta = KeyBuf::new();
    meta.push_str(symbol);
    meta.push_str("|");
    let mut dbuf: [u8; 4] = [0; 4];
    let dlen = write_u64_decimal(&mut dbuf, 0, decimals);
    meta.push_str(core::str::from_utf8(&dbuf[..dlen]).unwrap_or("0"));
    let _ = state_set(&token_meta_key(token_id), &meta);
    set_state_u64(&supply_key(token_id), 0);

    log("asset: token created");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"symbol\":\"");
    write_bytes(&mut buf, &mut off, symbol.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"decimals\":");
    off += write_u64_decimal(&mut buf, off, decimals);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_mint(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let token_id = field(fields, "token_id");
    let recipient = field(fields, "recipient_did");
    let amount_str = field(fields, "amount");
    let reference = field(fields, "ref");
    let issuer_dids = field(fields, "issuer_dids");
    let signatures = field(fields, "signatures");

    if token_id.is_empty() || recipient.is_empty() || reference.is_empty() {
        return err("missing required fields: token_id, recipient_did, ref");
    }
    if token_meta(token_id).is_none() {
        return err("TokenNotFound");
    }
    let amount = match parse_u64_str(amount_str) {
        Some(a) if a > 0 => a,
        _ => return err("InvalidAmount"),
    };

    let msg = mint_msg(token_id, recipient, amount, reference);
    if count_valid_sigs(issuer_dids, signatures, &msg) < issuer_threshold() {
        return err("issuer threshold not met");
    }

    let new_balance = credit(token_id, recipient, amount);
    bump_supply(token_id, amount);

    log("asset: minted");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"recipient\":\"");
    write_bytes(&mut buf, &mut off, recipient.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"amount\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"balance\":");
    off += write_u64_decimal(&mut buf, off, new_balance);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_burn(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let token_id = field(fields, "token_id");
    let owner = field(fields, "owner_did");
    let amount_str = field(fields, "amount");
    let reference = field(fields, "ref");
    let signature = field(fields, "signature");

    if token_id.is_empty() || owner.is_empty() || reference.is_empty() {
        return err("missing required fields: token_id, owner_did, ref");
    }
    if token_meta(token_id).is_none() {
        return err("TokenNotFound");
    }
    let amount = match parse_u64_str(amount_str) {
        Some(a) if a > 0 => a,
        _ => return err("InvalidAmount"),
    };

    let msg = burn_msg(token_id, owner, amount, reference);
    if !verify_sig(owner, &msg, signature) {
        return err("owner signature verification failed");
    }

    let balance = balance_of(token_id, owner);
    if balance < amount {
        return err("InsufficientFunds");
    }
    let new_balance = debit(token_id, owner, amount);
    set_supply(token_id, supply_of(token_id).saturating_sub(amount));

    log("asset: burned");

    let mut buf: [u8; 192] = [0; 192];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"burned\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"balance\":");
    off += write_u64_decimal(&mut buf, off, new_balance);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_transfer(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let token_id = field(fields, "token_id");
    let from = field(fields, "from_did");
    let to = field(fields, "to_did");
    let amount_str = field(fields, "amount");
    let reference = field(fields, "ref");
    let signature = field(fields, "signature");

    if token_id.is_empty() || from.is_empty() || to.is_empty() || reference.is_empty() {
        return err("missing required fields: token_id, from_did, to_did, ref");
    }
    if from == to {
        return err("cannot transfer to self");
    }
    if token_meta(token_id).is_none() {
        return err("TokenNotFound");
    }
    let amount = match parse_u64_str(amount_str) {
        Some(a) if a > 0 => a,
        _ => return err("InvalidAmount"),
    };

    let msg = transfer_msg(token_id, from, to, amount, reference);
    if !verify_sig(from, &msg, signature) {
        return err("sender signature verification failed");
    }

    let balance = balance_of(token_id, from);
    if balance < amount {
        return err("InsufficientFunds");
    }
    debit(token_id, from, amount);
    let to_balance = credit(token_id, to, amount);

    log("asset: transferred");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"from\":\"");
    write_bytes(&mut buf, &mut off, from.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"to\":\"");
    write_bytes(&mut buf, &mut off, to.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"amount\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"recipient_balance\":");
    off += write_u64_decimal(&mut buf, off, to_balance);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_open_vault(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let vault_id = field(fields, "vault_id");
    let token_id = field(fields, "token_id");
    let approver_dids = field(fields, "approver_dids");
    let threshold_str = field(fields, "threshold");
    let expiry_str = field(fields, "expiry_block");
    let fallback = field(fields, "fallback_owner_did");
    let admin_did = field(fields, "admin_did");
    let admin_sig = field(fields, "admin_sig");

    if vault_id.is_empty() || token_id.is_empty() || approver_dids.is_empty() || fallback.is_empty() {
        return err("missing required fields: vault_id, token_id, approver_dids, fallback_owner_did");
    }
    let stored_admin = match state_get("cfg:admin") {
        Some(a) => a,
        None => return err("asset module not configured"),
    };
    if admin_did != stored_admin.deref() {
        return err("NotAdmin");
    }
    if vault_meta(vault_id).is_some() {
        return err("VaultExists");
    }
    if token_meta(token_id).is_none() {
        return err("TokenNotFound");
    }
    let threshold = match parse_u64_str(threshold_str) {
        Some(t) if t >= 1 => t,
        _ => return err("invalid threshold"),
    };
    let expiry = match parse_u64_str(expiry_str) {
        Some(e) if e > 0 => e,
        _ => return err("invalid expiry_block"),
    };

    let msg = vopen_msg(vault_id, token_id, threshold, expiry);
    if !verify_sig(&stored_admin, &msg, admin_sig) {
        return err("admin signature verification failed");
    }

    let mut meta = KeyBuf::new();
    meta.push_str(token_id);
    meta.push_str("|");
    let mut tbuf: [u8; 4] = [0; 4];
    let tlen = write_u64_decimal(&mut tbuf, 0, threshold);
    meta.push_str(core::str::from_utf8(&tbuf[..tlen]).unwrap_or("1"));
    meta.push_str("|");
    let mut ebuf: [u8; 20] = [0; 20];
    let elen = write_u64_decimal(&mut ebuf, 0, expiry);
    meta.push_str(core::str::from_utf8(&ebuf[..elen]).unwrap_or("0"));
    meta.push_str("|");
    meta.push_str(fallback);
    meta.push_str("|");
    meta.push_str(approver_dids);
    let _ = state_set(&vault_meta_key(vault_id), &meta);

    log("asset: vault opened");

    let vault_account = vault_account_id(vault_id);
    let mut buf: [u8; 384] = [0; 384];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"vault_id\":\"");
    write_bytes(&mut buf, &mut off, vault_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"account\":\"");
    write_bytes(&mut buf, &mut off, vault_account.deref().as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"threshold\":");
    off += write_u64_decimal(&mut buf, off, threshold);
    write_bytes(&mut buf, &mut off, b",\"expiry_block\":");
    off += write_u64_decimal(&mut buf, off, expiry);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_vault_transfer(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let vault_id = field(fields, "vault_id");
    let token_id = field(fields, "token_id");
    let to = field(fields, "to_did");
    let amount_str = field(fields, "amount");
    let reference = field(fields, "ref");
    let cosigner_dids = field(fields, "cosigner_dids");
    let signatures = field(fields, "signatures");

    if vault_id.is_empty() || to.is_empty() || reference.is_empty() {
        return err("missing required fields: vault_id, to_did, ref");
    }
    let meta = match vault_meta(vault_id) {
        Some(m) => m,
        None => return err("VaultNotFound"),
    };
    let parts = split_vault_meta(&meta);
    if token_id != parts.token_id {
        return err("TokenMismatch");
    }
    let amount = match parse_u64_str(amount_str) {
        Some(a) if a > 0 => a,
        _ => return err("InvalidAmount"),
    };

    // Vault funds live in the same generic balance namespace as every
    // other account (deposits are plain transfers to `vault:<id>`).
    let vault_bal = balance_of(parts.token_id, &vault_account_id(vault_id));
    if vault_bal < amount {
        return err("InsufficientVaultFunds");
    }

    let msg = vault_transfer_msg(vault_id, to, amount, reference);
    let now = current_block();
    let expired = now > parts.expiry_block;

    if expired {
        // At/after expiry only the fallback owner can move vault funds.
        let sig = pick_paired_sig(parts.fallback_owner, cosigner_dids, signatures);
        if sig.is_empty() {
            return err("vault expired; fallback owner signature required");
        }
        if !verify_sig(parts.fallback_owner, &msg, sig) {
            return err("vault expired; fallback owner signature required");
        }
    } else {
        if count_valid_sigs_from(parts.approvers, cosigner_dids, signatures, &msg) < parts.threshold {
            return err("vault threshold not met");
        }
    }

    debit(parts.token_id, &vault_account_id(vault_id), amount);
    let to_balance = credit(parts.token_id, to, amount);

    log("asset: vault transfer");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"vault_id\":\"");
    write_bytes(&mut buf, &mut off, vault_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"to\":\"");
    write_bytes(&mut buf, &mut off, to.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"amount\":");
    off += write_u64_decimal(&mut buf, off, amount);
    write_bytes(&mut buf, &mut off, b",\"recipient_balance\":");
    off += write_u64_decimal(&mut buf, off, to_balance);
    write_bytes(&mut buf, &mut off, b",\"expired\":");
    write_bytes(&mut buf, &mut off, if expired { b"true" } else { b"false" });
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_vault_info(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let vault_id = field(fields, "vault_id");
    if vault_id.is_empty() {
        return err("missing required field: vault_id");
    }
    let meta = match vault_meta(vault_id) {
        Some(m) => m,
        None => return err("VaultNotFound"),
    };
    let parts = split_vault_meta(&meta);
    let balance = balance_of(parts.token_id, &vault_account_id(vault_id));
    let expired = current_block() > parts.expiry_block;

    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"vault_id\":\"");
    write_bytes(&mut buf, &mut off, vault_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"token_id\":\"");
    write_bytes(&mut buf, &mut off, parts.token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"account\":\"");
    write_bytes(&mut buf, &mut off, vault_account_id(vault_id).deref().as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"threshold\":");
    off += write_u64_decimal(&mut buf, off, parts.threshold);
    write_bytes(&mut buf, &mut off, b",\"expiry_block\":");
    off += write_u64_decimal(&mut buf, off, parts.expiry_block);
    write_bytes(&mut buf, &mut off, b",\"fallback_owner\":\"");
    write_bytes(&mut buf, &mut off, parts.fallback_owner.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"approvers\":\"");
    write_bytes(&mut buf, &mut off, parts.approvers.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"balance\":");
    off += write_u64_decimal(&mut buf, off, balance);
    write_bytes(&mut buf, &mut off, b",\"expired\":");
    write_bytes(&mut buf, &mut off, if expired { b"true" } else { b"false" });
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_balance(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let token_id = field(fields, "token_id");
    let did = field(fields, "did");
    if token_id.is_empty() || did.is_empty() {
        return err("missing required fields: token_id, did");
    }
    if token_meta(token_id).is_none() {
        return err("TokenNotFound");
    }
    let balance = balance_of(token_id, did);

    let mut buf: [u8; 192] = [0; 192];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"did\":\"");
    write_bytes(&mut buf, &mut off, did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"balance\":");
    off += write_u64_decimal(&mut buf, off, balance);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_token_info(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let token_id = field(fields, "token_id");
    if token_id.is_empty() {
        return err("missing required field: token_id");
    }
    let meta = match token_meta(token_id) {
        Some(m) => m,
        None => return err("TokenNotFound"),
    };
    let mut symbol = meta.deref();
    let mut decimals: u64 = 0;
    if let Some(pos) = meta.deref().find('|') {
        let (head, tail) = meta.deref().split_at(pos);
        symbol = head;
        decimals = parse_u64_str(&tail[1..]).unwrap_or(0);
    }
    let supply = supply_of(token_id);

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"symbol\":\"");
    write_bytes(&mut buf, &mut off, symbol.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"decimals\":");
    off += write_u64_decimal(&mut buf, off, decimals);
    write_bytes(&mut buf, &mut off, b",\"total_supply\":");
    off += write_u64_decimal(&mut buf, off, supply);
    write_bytes(&mut buf, &mut off, b",\"transferable\":true}");
    write_result(&buf[..off])
}

// ── Signed message builders ──

fn configure_msg(issuers: &str, threshold: u64) -> KeyBuf {
    let mut msg = KeyBuf::new();
    msg.push_str("configure:");
    msg.push_str(issuers);
    msg.push_str(":");
    let mut tbuf: [u8; 4] = [0; 4];
    let tlen = write_u64_decimal(&mut tbuf, 0, threshold);
    msg.push_str(core::str::from_utf8(&tbuf[..tlen]).unwrap_or("1"));
    msg
}

fn create_token_msg(token_id: &str, symbol: &str, decimals: u64) -> KeyBuf {
    let mut msg = KeyBuf::new();
    msg.push_str("create:");
    msg.push_str(token_id);
    msg.push_str(":");
    msg.push_str(symbol);
    msg.push_str(":");
    let mut dbuf: [u8; 4] = [0; 4];
    let dlen = write_u64_decimal(&mut dbuf, 0, decimals);
    msg.push_str(core::str::from_utf8(&dbuf[..dlen]).unwrap_or("0"));
    msg
}

fn mint_msg(token_id: &str, recipient: &str, amount: u64, reference: &str) -> KeyBuf {
    let mut msg = KeyBuf::new();
    msg.push_str("mint:");
    msg.push_str(token_id);
    msg.push_str(":");
    msg.push_str(recipient);
    msg.push_str(":");
    let mut abuf: [u8; 20] = [0; 20];
    let alen = write_u64_decimal(&mut abuf, 0, amount);
    msg.push_str(core::str::from_utf8(&abuf[..alen]).unwrap_or("0"));
    msg.push_str(":");
    msg.push_str(reference);
    msg
}

fn burn_msg(token_id: &str, owner: &str, amount: u64, reference: &str) -> KeyBuf {
    let mut msg = KeyBuf::new();
    msg.push_str("burn:");
    msg.push_str(token_id);
    msg.push_str(":");
    msg.push_str(owner);
    msg.push_str(":");
    let mut abuf: [u8; 20] = [0; 20];
    let alen = write_u64_decimal(&mut abuf, 0, amount);
    msg.push_str(core::str::from_utf8(&abuf[..alen]).unwrap_or("0"));
    msg.push_str(":");
    msg.push_str(reference);
    msg
}

fn transfer_msg(token_id: &str, from: &str, to: &str, amount: u64, reference: &str) -> KeyBuf {
    let mut msg = KeyBuf::new();
    msg.push_str("transfer:");
    msg.push_str(token_id);
    msg.push_str(":");
    msg.push_str(from);
    msg.push_str(":");
    msg.push_str(to);
    msg.push_str(":");
    let mut abuf: [u8; 20] = [0; 20];
    let alen = write_u64_decimal(&mut abuf, 0, amount);
    msg.push_str(core::str::from_utf8(&abuf[..alen]).unwrap_or("0"));
    msg.push_str(":");
    msg.push_str(reference);
    msg
}

fn vopen_msg(vault_id: &str, token_id: &str, threshold: u64, expiry: u64) -> KeyBuf {
    let mut msg = KeyBuf::new();
    msg.push_str("vopen:");
    msg.push_str(vault_id);
    msg.push_str(":");
    msg.push_str(token_id);
    msg.push_str(":");
    let mut tbuf: [u8; 4] = [0; 4];
    let tlen = write_u64_decimal(&mut tbuf, 0, threshold);
    msg.push_str(core::str::from_utf8(&tbuf[..tlen]).unwrap_or("1"));
    msg.push_str(":");
    let mut ebuf: [u8; 20] = [0; 20];
    let elen = write_u64_decimal(&mut ebuf, 0, expiry);
    msg.push_str(core::str::from_utf8(&ebuf[..elen]).unwrap_or("0"));
    msg
}

fn vault_transfer_msg(vault_id: &str, to: &str, amount: u64, reference: &str) -> KeyBuf {
    let mut msg = KeyBuf::new();
    msg.push_str("vt:");
    msg.push_str(vault_id);
    msg.push_str(":");
    msg.push_str(to);
    msg.push_str(":");
    let mut abuf: [u8; 20] = [0; 20];
    let alen = write_u64_decimal(&mut abuf, 0, amount);
    msg.push_str(core::str::from_utf8(&abuf[..alen]).unwrap_or("0"));
    msg.push_str(":");
    msg.push_str(reference);
    msg
}

/// Signature of the DID paired with `wanted` in the parallel csv lists, or "".
fn pick_paired_sig<'a>(wanted: &str, dids: &'a str, sigs: &'a str) -> &'a str {
    let mut did_list: [&str; 16] = [""; 16];
    let mut sig_list: [&str; 16] = [""; 16];
    let n_dids = split_commas(dids, &mut did_list);
    let n_sigs = split_commas(sigs, &mut sig_list);
    let pairs = if n_dids < n_sigs { n_dids } else { n_sigs };
    for i in 0..pairs {
        if did_list[i] == wanted {
            return sig_list[i];
        }
    }
    ""
}

/// Count distinct valid signatures from the allowed list.
fn count_valid_sigs_from(allowed_csv: &str, dids: &str, sigs: &str, msg: &str) -> u64 {
    let mut allowed: [&str; 16] = [""; 16];
    let n_allowed = split_commas(allowed_csv, &mut allowed);
    let mut did_list: [&str; 16] = [""; 16];
    let mut sig_list: [&str; 16] = [""; 16];
    let n_dids = split_commas(dids, &mut did_list);
    let n_sigs = split_commas(sigs, &mut sig_list);
    let pairs = if n_dids < n_sigs { n_dids } else { n_sigs };
    let mut seen: [&str; 16] = [""; 16];
    let mut seen_count = 0usize;
    let mut valid = 0u64;
    for i in 0..pairs {
        let did = did_list[i];
        let sig = sig_list[i];
        if did.is_empty() || sig.is_empty() || !is_in_list(did, &allowed[..n_allowed]) {
            continue;
        }
        if is_in_list(did, &seen[..seen_count]) {
            continue;
        }
        if verify_sig(did, msg, sig) {
            seen[seen_count] = did;
            seen_count += 1;
            valid += 1;
        }
    }
    valid
}

fn count_valid_sigs(dids: &str, sigs: &str, msg: &str) -> u64 {
    let issuers = state_get("cfg:issuers").unwrap_or_else(|| StateVal::empty());
    count_valid_sigs_from(issuers.deref(), dids, sigs, msg)
}

fn issuer_threshold() -> u64 {
    state_get_u64("cfg:threshold", 1).max(1)
}

// ── Asset state helpers ──

fn token_meta_key(token_id: &str) -> KeyBuf {
    let mut key = KeyBuf::new();
    key.push_str("tok:");
    key.push_str(token_id);
    key
}

fn supply_key(token_id: &str) -> KeyBuf {
    let mut key = KeyBuf::new();
    key.push_str("tok:");
    key.push_str(token_id);
    key.push_str(":supply");
    key
}

fn balance_key(token_id: &str, did: &str) -> KeyBuf {
    let mut key = KeyBuf::new();
    key.push_str("bal:");
    key.push_str(token_id);
    key.push_str(":");
    key.push_str(did);
    key
}

fn vault_meta_key(vault_id: &str) -> KeyBuf {
    let mut key = KeyBuf::new();
    key.push_str("vault:");
    key.push_str(vault_id);
    key
}

/// The vault's on-chain account identifier; transfers deposit to this string
/// and its balance lives in the generic balance namespace like any account.
fn vault_account_id(vault_id: &str) -> KeyBuf {
    let mut key = KeyBuf::new();
    key.push_str("vault:");
    key.push_str(vault_id);
    key
}

fn token_meta(token_id: &str) -> Option<StateVal> {
    state_get(&token_meta_key(token_id))
}

fn supply_of(token_id: &str) -> u64 {
    state_get_u64(&supply_key(token_id), 0)
}

fn set_supply(token_id: &str, n: u64) {
    set_state_u64(&supply_key(token_id), n);
}

fn bump_supply(token_id: &str, delta: u64) {
    set_supply(token_id, supply_of(token_id).saturating_add(delta));
}

fn balance_of(token_id: &str, did: &str) -> u64 {
    state_get_u64(&balance_key(token_id, did), 0)
}

fn credit(token_id: &str, did: &str, amount: u64) -> u64 {
    let next = balance_of(token_id, did).saturating_add(amount);
    set_state_u64(&balance_key(token_id, did), next);
    next
}

fn debit(token_id: &str, did: &str, amount: u64) -> u64 {
    let next = balance_of(token_id, did).saturating_sub(amount);
    set_state_u64(&balance_key(token_id, did), next);
    next
}

fn vault_meta(vault_id: &str) -> Option<StateVal> {
    state_get(&vault_meta_key(vault_id))
}

struct VaultParts<'a> {
    token_id: &'a str,
    threshold: u64,
    expiry_block: u64,
    fallback_owner: &'a str,
    approvers: &'a str,
}

/// Parse `token|threshold|expiry|fallback|approvers` borrowing from the
/// meta buffer's lifetime (mirrors the StackStr pattern).
fn split_vault_meta<'a>(meta: &'a StateVal) -> VaultParts<'a> {
    let raw: &'a str = meta.deref();
    let mut parts: [&str; 5] = ["", "", "", "", ""];
    let mut count = 0;
    let mut start = 0;
    for (i, b) in raw.as_bytes().iter().enumerate() {
        if *b == b'|' && count < 5 {
            parts[count] = &raw[start..i];
            count += 1;
            start = i + 1;
        }
    }
    if count < 5 && start < raw.len() {
        parts[count] = &raw[start..];
    }
    VaultParts {
        token_id: parts[0],
        threshold: parse_u64_str(parts[1]).unwrap_or(1),
        expiry_block: parse_u64_str(parts[2]).unwrap_or(0),
        fallback_owner: parts[3],
        approvers: parts[4],
    }
}

// ── State helpers ──

fn set_state_u64(key: &str, n: u64) {
    let mut buf: [u8; 20] = [0; 20];
    let len = write_u64_decimal(&mut buf, 0, n);
    let _ = state_set_raw(key, &buf[..len]);
}

fn state_get_u64(key: &str, default: u64) -> u64 {
    state_get(key)
        .and_then(|s| parse_u64_str(s.deref()))
        .unwrap_or(default)
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
    data: [u8; 384],
    len: usize,
}

impl KeyBuf {
    fn new() -> Self {
        KeyBuf {
            data: [0; 384],
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

impl StateVal {
    fn empty() -> Self {
        StateVal { buf: StateBuf::new() }
    }
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
