#![no_std]
#![no_main]

/// CTZN Token — a soulbound (non-transferable) identity WASM module for Citizen Protocol.
///
/// Once minted to a recipient, a CTZN token is permanently bound to that identity.
/// Transfers are always rejected. Features:
/// - Custom metadata schemas (degree, reputation, identity, custom)
/// - Multi-issuer authority (N-of-M signatures required for mint)
/// - Time-locked/expirable tokens (via expiry_block)
/// - Revocable by authorized issuers
/// - Hierarchical tiers (bronze/silver/gold)
/// - Attribute-based access control (check_access)
///
/// ## Operations
///
/// | Operation      | Parameters                                              | Returns                          |
/// |----------------|---------------------------------------------------------|----------------------------------|
/// | `configure`    | admin_did, admin_sig, issuers, threshold                | `{"ok":true,"issuers":N,...}`    |
/// | `mint`         | issuer_dids, signatures, token_id, recipient_did,       | `{"ok":true,"token_id":...,...}` |
/// |                | tier?, schema_type?, metadata?, expiry_block?           |                                  |
/// | `owner_of`     | token_id                                                | `{"owner":"...","burned":F,...}` |
/// | `total_supply` | (none)                                                  | `{"total_supply":N,"bronze":N}`  |
/// | `get_metadata` | token_id                                                | `{"token_id":"...","metadata":{}}` |
/// | `burn`         | issuer_did, signature_hex, token_id                     | `{"ok":true,"burned":true}`      |
/// | `revoke`       | issuer_did, signature_hex, token_id                     | `{"ok":true,"revoked":true}`     |
/// | `transfer`     | (any)                                                   | `{"ok":false,"reason":"..."}`    |
/// | `check_access` | did, token_id?, required_tier?, required_schema?        | `{"has_access":true,...}`        |

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
        "mint" => handle_mint(&fields),
        "owner_of" => handle_owner_of(&fields),
        "total_supply" => handle_total_supply(),
        "get_metadata" => handle_get_metadata(&fields),
        "burn" => handle_burn(&fields),
        "revoke" => handle_revoke(&fields),
        "transfer" => {
            log("ctzn: transfer rejected — CTZN tokens are non-transferable");
            json_err("soulbound: non-transferable")
        }
        "check_access" => handle_check_access(&fields),
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

    let threshold: u32 = if threshold_str.is_empty() {
        1
    } else {
        match parse_u64_str(threshold_str) {
            Some(t) => t as u32,
            None => return err("invalid threshold"),
        }
    };

    let existing_admin = state_get("config:admin");
    match &existing_admin {
        Some(admin) => {
            if admin_sig.is_empty() {
                return err("admin signature required for reconfiguration");
            }
            let mut msg_buf: [u8; 256] = [0; 256];
            let mut msg_len = 0;
            write_bytes(&mut msg_buf, &mut msg_len, b"configure:");
            write_bytes(&mut msg_buf, &mut msg_len, issuers.as_bytes());
            write_bytes(&mut msg_buf, &mut msg_len, b":");
            msg_len += write_u64_decimal(&mut msg_buf, msg_len, threshold as u64);
            let msg = core::str::from_utf8(&msg_buf[..msg_len]).unwrap_or("");
            if !verify_sig(admin, msg, admin_sig) {
                return err("admin signature verification failed");
            }
        }
        None => {
            // Bootstrap requires explicit governance approval.
            // A governance proposal must exist and be approved to authorize
            // the initial admin and issuer set.
            let proposal_id = field(fields, "proposal_id");
            if proposal_id.is_empty() {
                return err("governance proposal_id required for initial configuration");
            }
            if !check_governance(proposal_id) {
                return err("governance has not approved this CTZN configuration");
            }
            log("ctzn: initial configuration (governance-approved bootstrap)");
        }
    }

    let _ = state_set("config:admin", admin_did);
    let _ = state_set("config:issuers", issuers);
    let mut tbuf: [u8; 4] = [0; 4];
    let tlen = write_u64_decimal(&mut tbuf, 0, threshold as u64);
    let _ = state_set_raw("config:threshold", &tbuf[..tlen]);

    let mut tmp: [&str; 16] = [""; 16];
    let n_issuers = split_commas(issuers, &mut tmp);

    log("ctzn: configured");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"admin\":\"");
    write_bytes(&mut buf, &mut off, admin_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"issuers\":");
    off += write_u64_decimal(&mut buf, off, n_issuers as u64);
    write_bytes(&mut buf, &mut off, b",\"threshold\":");
    off += write_u64_decimal(&mut buf, off, threshold as u64);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_mint(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let issuer_dids_str = {
        let v = field(fields, "issuer_dids");
        if v.is_empty() { field(fields, "issuer_did") } else { v }
    };
    let signatures_str = {
        let v = field(fields, "signatures");
        if v.is_empty() { field(fields, "signature_hex") } else { v }
    };
    let token_id = field(fields, "token_id");
    let recipient_did = field(fields, "recipient_did");
    let tier_str = field(fields, "tier");
    let schema_type = field(fields, "schema_type");
    let metadata = field(fields, "metadata");
    let expiry_str = field(fields, "expiry_block");

    if token_id.is_empty() || recipient_did.is_empty()
        || issuer_dids_str.is_empty() || signatures_str.is_empty()
    {
        return err("missing required fields: issuer_dids, signatures, token_id, recipient_did");
    }

    let tier = if tier_str.is_empty() { 0u32 } else {
        match parse_tier(tier_str) {
            Some(t) => t,
            None => return err("invalid tier"),
        }
    };

    let schema = if schema_type.is_empty() { "general" } else { schema_type };

    let expiry: u64 = if expiry_str.is_empty() { 0 } else {
        match parse_u64_str(expiry_str) {
            Some(e) => e,
            None => return err("invalid expiry_block"),
        }
    };

    if state_get(&format_key("owner:", token_id)).is_some() {
        return err("token already minted");
    }

    let mint_msg = format_key3("mint:", token_id, ":", recipient_did);
    let (verified, required) = verify_multi_issuer(
        issuer_dids_str, &mint_msg, signatures_str,
    );
    if verified < required {
        let mut buf: [u8; 128] = [0; 128];
        let mut off = 0;
        write_bytes(&mut buf, &mut off, b"{\"ok\":false,\"error\":\"insufficient issuer signatures\",\"verified\":");
        off += write_u64_decimal(&mut buf, off, verified as u64);
        write_bytes(&mut buf, &mut off, b",\"required\":");
        off += write_u64_decimal(&mut buf, off, required as u64);
        write_bytes(&mut buf, &mut off, b"}");
        return write_result(&buf[..off]);
    }

    if !state_set(&format_key("owner:", token_id), recipient_did) {
        return err("failed to store ownership");
    }

    let meta_value = if metadata.is_empty() { "{}" } else { metadata };
    let _ = state_set(&format_key("meta:", token_id), meta_value);

    {
        let mut tbuf: [u8; 4] = [0; 4];
        let tlen = write_u64_decimal(&mut tbuf, 0, tier as u64);
        let _ = state_set_raw(&format_key("tier:", token_id), &tbuf[..tlen]);
    }

    let _ = state_set(&format_key("schema:", token_id), schema);

    {
        let mut ebuf: [u8; 20] = [0; 20];
        let elen = write_u64_decimal(&mut ebuf, 0, expiry);
        let _ = state_set_raw(&format_key("expiry:", token_id), &ebuf[..elen]);
    }

    let supply = get_total_supply() + 1;
    set_total_supply(supply);
    let tier_supply = get_tier_supply(tier) + 1;
    set_tier_supply(tier, tier_supply);

    add_to_held(recipient_did, token_id);

    let block = current_block();
    log("ctzn: minted");

    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"owner\":\"");
    write_bytes(&mut buf, &mut off, recipient_did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"tier\":\"");
    write_bytes(&mut buf, &mut off, tier_name(tier).as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"schema\":\"");
    write_bytes(&mut buf, &mut off, schema.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"total_supply\":");
    off += write_u64_decimal(&mut buf, off, supply);
    write_bytes(&mut buf, &mut off, b",\"block\":");
    off += write_u64_decimal(&mut buf, off, block);
    write_bytes(&mut buf, &mut off, b",\"soulbound\":true,\"expiry\":");
    off += write_u64_decimal(&mut buf, off, expiry);
    write_bytes(&mut buf, &mut off, b",\"verified_issuers\":");
    off += write_u64_decimal(&mut buf, off, verified as u64);
    write_bytes(&mut buf, &mut off, b",\"required_issuers\":");
    off += write_u64_decimal(&mut buf, off, required as u64);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_owner_of(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let token_id = field(fields, "token_id");
    if token_id.is_empty() {
        return err("missing token_id");
    }

    let burned = is_burned(token_id);
    let revoked = is_revoked(token_id);
    let expired = is_expired(token_id);

    let owner_val = state_get(&format_key("owner:", token_id));
    let owner = owner_val.as_deref().unwrap_or("");

    if owner.is_empty() && !burned {
        return err("token not found");
    }

    if burned {
        let mut buf: [u8; 256] = [0; 256];
        let mut off = 0;
        write_bytes(&mut buf, &mut off, b"{\"owner\":null,\"burned\":true,\"revoked\":");
        write_bytes(&mut buf, &mut off, json_bool(revoked).as_bytes());
        write_bytes(&mut buf, &mut off, b",\"expired\":");
        write_bytes(&mut buf, &mut off, json_bool(expired).as_bytes());
        write_bytes(&mut buf, &mut off, b"}");
        return write_result(&buf[..off]);
    }

    let tier = get_tier(token_id);
    let schema_val = state_get(&format_key("schema:", token_id));
    let schema = schema_val.as_deref().unwrap_or("general");
    let expiry = get_expiry(token_id);

    let mut buf: [u8; 512] = [0; 512];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"owner\":\"");
    write_bytes(&mut buf, &mut off, owner.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"tier\":\"");
    write_bytes(&mut buf, &mut off, tier_name(tier).as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"schema\":\"");
    write_bytes(&mut buf, &mut off, schema.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"burned\":false,\"revoked\":");
    write_bytes(&mut buf, &mut off, json_bool(revoked).as_bytes());
    write_bytes(&mut buf, &mut off, b",\"expired\":");
    write_bytes(&mut buf, &mut off, json_bool(expired).as_bytes());
    write_bytes(&mut buf, &mut off, b",\"expiry_block\":");
    off += write_u64_decimal(&mut buf, off, expiry);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_total_supply() -> u64 {
    let supply = get_total_supply();
    let bronze = get_tier_supply(0);
    let silver = get_tier_supply(1);
    let gold = get_tier_supply(2);

    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"total_supply\":");
    off += write_u64_decimal(&mut buf, off, supply);
    write_bytes(&mut buf, &mut off, b",\"bronze\":");
    off += write_u64_decimal(&mut buf, off, bronze);
    write_bytes(&mut buf, &mut off, b",\"silver\":");
    off += write_u64_decimal(&mut buf, off, silver);
    write_bytes(&mut buf, &mut off, b",\"gold\":");
    off += write_u64_decimal(&mut buf, off, gold);
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_get_metadata(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let token_id = field(fields, "token_id");
    if token_id.is_empty() {
        return err("missing token_id");
    }

    if state_get(&format_key("owner:", token_id)).is_none() {
        return err("metadata not found");
    }

    let tier = get_tier(token_id);
    let schema_val = state_get(&format_key("schema:", token_id));
    let schema = schema_val.as_deref().unwrap_or("general");
    let meta_val = state_get(&format_key("meta:", token_id));
    let meta = meta_val.as_deref().unwrap_or("{}");
    let revoked = is_revoked(token_id);
    let expired = is_expired(token_id);

    let mut buf: [u8; 1024] = [0; 1024];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"tier\":\"");
    write_bytes(&mut buf, &mut off, tier_name(tier).as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"schema\":\"");
    write_bytes(&mut buf, &mut off, schema.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"metadata\":");
    write_bytes(&mut buf, &mut off, meta.as_bytes());
    write_bytes(&mut buf, &mut off, b",\"revoked\":");
    write_bytes(&mut buf, &mut off, json_bool(revoked).as_bytes());
    write_bytes(&mut buf, &mut off, b",\"expired\":");
    write_bytes(&mut buf, &mut off, json_bool(expired).as_bytes());
    write_bytes(&mut buf, &mut off, b"}");
    write_result(&buf[..off])
}

fn handle_burn(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let issuer_did = field(fields, "issuer_did");
    let signature_hex = field(fields, "signature_hex");
    let token_id = field(fields, "token_id");

    if issuer_did.is_empty() || signature_hex.is_empty() || token_id.is_empty() {
        return err("missing required fields: issuer_did, signature_hex, token_id");
    }

    let burn_msg = format_key("burn:", token_id);
    if !verify_sig(issuer_did, &burn_msg, signature_hex) {
        return err("issuer signature verification failed");
    }

    if state_get(&format_key("owner:", token_id)).is_none() {
        return err("token not found");
    }

    if is_burned(token_id) {
        return err("token already burned");
    }

    if !state_set_raw(&format_key("burned:", token_id), b"1") {
        return err("failed to burn token");
    }

    let supply = get_total_supply();
    if supply > 0 {
        set_total_supply(supply - 1);
    }
    let tier = get_tier(token_id);
    let tsupply = get_tier_supply(tier);
    if tsupply > 0 {
        set_tier_supply(tier, tsupply - 1);
    }

    log("ctzn: burned");

    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"burned\":true,\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_revoke(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let issuer_did = field(fields, "issuer_did");
    let signature_hex = field(fields, "signature_hex");
    let token_id = field(fields, "token_id");

    if issuer_did.is_empty() || signature_hex.is_empty() || token_id.is_empty() {
        return err("missing required fields: issuer_did, signature_hex, token_id");
    }

    let revoke_msg = format_key("revoke:", token_id);
    if !verify_sig(issuer_did, &revoke_msg, signature_hex) {
        return err("issuer signature verification failed");
    }

    if state_get(&format_key("owner:", token_id)).is_none() {
        return err("token not found");
    }

    if is_revoked(token_id) {
        return err("token already revoked");
    }

    if !state_set_raw(&format_key("revoked:", token_id), b"1") {
        return err("failed to revoke token");
    }

    let supply = get_total_supply();
    if supply > 0 {
        set_total_supply(supply - 1);
    }
    let tier = get_tier(token_id);
    let tsupply = get_tier_supply(tier);
    if tsupply > 0 {
        set_tier_supply(tier, tsupply - 1);
    }

    log("ctzn: revoked");

    let mut buf: [u8; 128] = [0; 128];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"ok\":true,\"revoked\":true,\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

fn handle_check_access(fields: &[(StackStr, StackStr); 12]) -> u64 {
    let did = field(fields, "did");
    let token_id = field(fields, "token_id");
    let required_tier_str = field(fields, "required_tier");
    let required_schema = field(fields, "required_schema");

    if did.is_empty() {
        return err("missing required field: did");
    }

    let required_tier: u32 = if required_tier_str.is_empty() {
        0
    } else {
        parse_tier(required_tier_str).unwrap_or(0)
    };

    if !token_id.is_empty() {
        return check_token_access(did, token_id, required_tier, required_schema);
    }

    let held_key = format_key("held:", did);
    let held_val = state_get(&held_key);
    let held_str: &str = held_val.as_deref().unwrap_or("");
    if held_str.is_empty() {
        return json_response(r#"{"has_access":false,"reason":"no tokens held"}"#);
    }

    let mut tokens: [&str; 16] = [""; 16];
    let n_tokens = split_commas(held_str, &mut tokens);

    for i in 0..n_tokens {
        let tid = tokens[i];
        if tid.is_empty() { continue; }

        let owner_val = state_get(&format_key("owner:", tid));
        if owner_val.as_deref().unwrap_or("") != did { continue; }
        if is_burned(tid) || is_revoked(tid) || is_expired(tid) { continue; }

        let tier = get_tier(tid);
        if tier < required_tier { continue; }

        if !required_schema.is_empty() {
            let schema_val = state_get(&format_key("schema:", tid));
            if schema_val.as_deref().unwrap_or("") != required_schema { continue; }
        }

        return access_granted_response(did, tid, tier);
    }

    json_response(r#"{"has_access":false,"reason":"no qualifying token"}"#)
}

fn check_token_access(
    did: &str,
    token_id: &str,
    required_tier: u32,
    required_schema: &str,
) -> u64 {
    let owner_val = state_get(&format_key("owner:", token_id));
    let owner = owner_val.as_deref().unwrap_or("");
    if owner != did {
        return json_response(r#"{"has_access":false,"reason":"not owner"}"#);
    }
    if is_burned(token_id) {
        return json_response(r#"{"has_access":false,"reason":"token burned"}"#);
    }
    if is_revoked(token_id) {
        return json_response(r#"{"has_access":false,"reason":"token revoked"}"#);
    }
    if is_expired(token_id) {
        return json_response(r#"{"has_access":false,"reason":"token expired"}"#);
    }

    let tier = get_tier(token_id);
    if tier < required_tier {
        let mut buf: [u8; 256] = [0; 256];
        let mut off = 0;
        write_bytes(&mut buf, &mut off, b"{\"has_access\":false,\"reason\":\"insufficient tier\",\"tier\":\"");
        write_bytes(&mut buf, &mut off, tier_name(tier).as_bytes());
        write_bytes(&mut buf, &mut off, b"\",\"required\":\"");
        write_bytes(&mut buf, &mut off, tier_name(required_tier).as_bytes());
        write_bytes(&mut buf, &mut off, b"\"}");
        return write_result(&buf[..off]);
    }

    if !required_schema.is_empty() {
        let schema_val = state_get(&format_key("schema:", token_id));
        let schema = schema_val.as_deref().unwrap_or("general");
        if schema != required_schema {
            let mut buf: [u8; 256] = [0; 256];
            let mut off = 0;
            write_bytes(&mut buf, &mut off, b"{\"has_access\":false,\"reason\":\"schema mismatch\",\"schema\":\"");
            write_bytes(&mut buf, &mut off, schema.as_bytes());
            write_bytes(&mut buf, &mut off, b"\",\"required\":\"");
            write_bytes(&mut buf, &mut off, required_schema.as_bytes());
            write_bytes(&mut buf, &mut off, b"\"}");
            return write_result(&buf[..off]);
        }
    }

    access_granted_response(did, token_id, tier)
}

fn access_granted_response(did: &str, token_id: &str, tier: u32) -> u64 {
    let schema_val = state_get(&format_key("schema:", token_id));
    let schema = schema_val.as_deref().unwrap_or("general");

    let mut buf: [u8; 256] = [0; 256];
    let mut off = 0;
    write_bytes(&mut buf, &mut off, b"{\"has_access\":true,\"did\":\"");
    write_bytes(&mut buf, &mut off, did.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"token_id\":\"");
    write_bytes(&mut buf, &mut off, token_id.as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"tier\":\"");
    write_bytes(&mut buf, &mut off, tier_name(tier).as_bytes());
    write_bytes(&mut buf, &mut off, b"\",\"schema\":\"");
    write_bytes(&mut buf, &mut off, schema.as_bytes());
    write_bytes(&mut buf, &mut off, b"\"}");
    write_result(&buf[..off])
}

// ── Multi-issuer verification ──

fn verify_multi_issuer(
    issuer_dids: &str,
    message: &str,
    signatures: &str,
) -> (u32, u32) {
    let mut dids: [&str; 16] = [""; 16];
    let mut sigs: [&str; 16] = [""; 16];
    let n_dids = split_commas(issuer_dids, &mut dids);
    let n_sigs = split_commas(signatures, &mut sigs);

    let config_threshold = state_get("config:threshold");
    let threshold: u32 = config_threshold
        .as_ref()
        .and_then(|s| parse_u64_str(s))
        .unwrap_or(1) as u32;

    let config_issuers = state_get("config:issuers");
    let authorized_str = config_issuers.as_deref().unwrap_or("");
    let mut authorized: [&str; 16] = [""; 16];
    let n_authorized = if authorized_str.is_empty() {
        0
    } else {
        split_commas(authorized_str, &mut authorized)
    };

    let mut verified: u32 = 0;
    let n = n_dids.min(n_sigs);
    for i in 0..n {
        let did = dids[i];
        let sig = sigs[i];
        if did.is_empty() || sig.is_empty() { continue; }

        if n_authorized > 0 && !is_in_list(did, &authorized[..n_authorized]) {
            continue;
        }

        if verify_sig(did, message, sig) {
            verified += 1;
        }
    }

    (verified, threshold)
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

fn get_tier_supply(tier: u32) -> u64 {
    let key = tier_supply_key(tier);
    state_get(&key)
        .as_ref().and_then(|s| parse_u64_str(s))
        .unwrap_or(0)
}

fn set_tier_supply(tier: u32, n: u64) {
    let key = tier_supply_key(tier);
    let mut buf: [u8; 20] = [0; 20];
    let len = write_u64_decimal(&mut buf, 0, n);
    let _ = state_set_raw(&key, &buf[..len]);
}

fn is_burned(token_id: &str) -> bool {
    state_get(&format_key("burned:", token_id)).is_some()
}

fn is_revoked(token_id: &str) -> bool {
    state_get(&format_key("revoked:", token_id)).is_some()
}

fn is_expired(token_id: &str) -> bool {
    let expiry = get_expiry(token_id);
    expiry > 0 && current_block() > expiry
}

fn get_tier(token_id: &str) -> u32 {
    state_get(&format_key("tier:", token_id))
        .as_ref().and_then(|s| parse_u64_str(s))
        .unwrap_or(0) as u32
}

fn get_expiry(token_id: &str) -> u64 {
    state_get(&format_key("expiry:", token_id))
        .as_ref().and_then(|s| parse_u64_str(s))
        .unwrap_or(0)
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

// ── Held-list management ──

fn add_to_held(did: &str, token_id: &str) {
    let key = format_key("held:", did);
    let mut buf: [u8; 512] = [0; 512];
    let mut len = 0;

    if let Some(existing) = state_get(&key) {
        let existing_bytes = existing.as_bytes();
        let copy_len = existing_bytes.len().min(buf.len());
        buf[..copy_len].copy_from_slice(&existing_bytes[..copy_len]);
        len = copy_len;
        if len > 0 && len < buf.len() {
            buf[len] = b',';
            len += 1;
        }
    }

    let tid_bytes = token_id.as_bytes();
    let remaining = buf.len() - len;
    let tid_copy = tid_bytes.len().min(remaining);
    if tid_copy > 0 {
        buf[len..len + tid_copy].copy_from_slice(&tid_bytes[..tid_copy]);
        len += tid_copy;
    }

    let _ = state_set_raw(&key, &buf[..len]);
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

fn tier_supply_key(tier: u32) -> KeyBuf {
    let mut buf = KeyBuf::new();
    buf.push_str("supply:");
    let mut num: [u8; 4] = [0; 4];
    let nlen = write_u64_decimal(&mut num, 0, tier as u64);
    let num_str = core::str::from_utf8(&num[..nlen]).unwrap_or("0");
    buf.push_str(num_str);
    buf
}

// ── Tier helpers ──

fn parse_tier(s: &str) -> Option<u32> {
    match s {
        "0" | "bronze" => Some(0),
        "1" | "silver" => Some(1),
        "2" | "gold" => Some(2),
        _ => {
            let mut n: u32 = 0;
            let mut any = false;
            for b in s.as_bytes() {
                if *b >= b'0' && *b <= b'9' {
                    n = n * 10 + (*b - b'0') as u32;
                    any = true;
                }
            }
            if any && n <= 2 { Some(n) } else { None }
        }
    }
}

fn tier_name(tier: u32) -> &'static str {
    match tier {
        0 => "bronze",
        1 => "silver",
        2 => "gold",
        _ => "unknown",
    }
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
        if *s == item { return true; }
    }
    false
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
