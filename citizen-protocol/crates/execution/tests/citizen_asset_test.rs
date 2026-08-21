use citizen_execution::{ExecutionConfig, ExecutionEngine, WasmHost};
use std::sync::Arc;

/// Test host for the citizen-asset module. Mirrors the host in
/// treasurenet_test.rs: signature validity keyed by signer DID, persistent
/// per-module state across execute() calls, adjustable block height.
struct TestHost {
    signatures: std::sync::Mutex<std::collections::HashMap<String, bool>>,
    governance: std::collections::HashMap<String, bool>,
    block_height: std::sync::Mutex<u64>,
    storage: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl TestHost {
    fn new(block_height: u64) -> Self {
        Self {
            signatures: std::sync::Mutex::new(std::collections::HashMap::new()),
            governance: std::collections::HashMap::new(),
            block_height: std::sync::Mutex::new(block_height),
            storage: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn set_block_height(&self, height: u64) {
        *self.block_height.lock().unwrap() = height;
    }

    fn set_signature(&self, key: &str, valid: bool) {
        self.signatures
            .lock()
            .unwrap()
            .insert(key.to_string(), valid);
    }

    fn with_governance(mut self, proposal: &str, approved: bool) -> Self {
        self.governance.insert(proposal.to_string(), approved);
        self
    }
}

impl WasmHost for TestHost {
    fn read_namespace_entry(
        &self,
        _namespace: &str,
        _entry_id: &str,
    ) -> Result<Option<String>, citizen_execution::ExecutionError> {
        Ok(None)
    }

    fn write_namespace_entry(
        &self,
        namespace: &str,
        payload_json: &str,
    ) -> Result<String, citizen_execution::ExecutionError> {
        Ok(format!(
            r#"{{"namespace":"{namespace}","payload":{payload_json}}}"#
        ))
    }

    fn verify_signature(
        &self,
        signer_did: &str,
        _message_hex: &str,
        _signature_hex: &str,
    ) -> Result<bool, citizen_execution::ExecutionError> {
        Ok(self
            .signatures
            .lock()
            .unwrap()
            .get(signer_did)
            .copied()
            .unwrap_or(true))
    }

    fn check_governance_approval(
        &self,
        proposal_id: &str,
    ) -> Result<bool, citizen_execution::ExecutionError> {
        Ok(self.governance.get(proposal_id).copied().unwrap_or(false))
    }

    fn current_block_height(&self) -> Result<u64, citizen_execution::ExecutionError> {
        Ok(*self.block_height.lock().unwrap())
    }

    fn load_module_bytecode(
        &self,
        _module_id: &str,
    ) -> Result<Vec<u8>, citizen_execution::ExecutionError> {
        Err(citizen_execution::ExecutionError::ModuleNotFound(
            "test host does not load modules".into(),
        ))
    }

    fn store_state(
        &self,
        _module_id: &str,
        key: &str,
        value: &str,
    ) -> Result<(), citizen_execution::ExecutionError> {
        self.storage
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn load_state(
        &self,
        _module_id: &str,
        key: &str,
    ) -> Result<Option<String>, citizen_execution::ExecutionError> {
        Ok(self.storage.lock().unwrap().get(key).cloned())
    }

    fn verify_signature_batch(
        &self,
        _batch_json: &str,
    ) -> Result<u32, citizen_execution::ExecutionError> {
        Ok(0)
    }

    fn call_module(
        &self,
        _module_id: &str,
        _params: &str,
    ) -> Result<Option<String>, citizen_execution::ExecutionError> {
        Err(citizen_execution::ExecutionError::HostError(
            "not supported".into(),
        ))
    }
}

fn new_host(height: u64) -> Arc<TestHost> {
    Arc::new(TestHost::new(height).with_governance("proposal-asset", true))
}

fn make_engine() -> ExecutionEngine {
    ExecutionEngine::new(ExecutionConfig::default()).expect("create engine")
}

fn load_fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("tests/fixtures/{}", name)).expect("read fixture")
}

fn run(engine: &ExecutionEngine, wasm: &Vec<u8>, params: &str, host: Arc<TestHost>) -> String {
    let result = engine
        .execute(wasm, "citizen-asset.v1", params, 1_000_000, host)
        .expect("execution should not trap");
    assert!(
        result.success,
        "module should execute cleanly: {:?}",
        result.error
    );
    String::from_utf8_lossy(result.return_value.as_ref().unwrap()).into_owned()
}

fn run_expect_error(engine: &ExecutionEngine, wasm: &Vec<u8>, params: &str, host: Arc<TestHost>, expected: &str) {
    let out = run(engine, wasm, params, host);
    assert!(
        out.contains(&format!(r#""error":"{expected}""#)),
        "expected error {expected}, got: {out}"
    );
}

const ADMIN: &str = "did:key:ed25519:admin1";
const ISSUER_A: &str = "did:key:ed25519:issuerA";
const ISSUER_B: &str = "did:key:ed25519:issuerB";
const GM: &str = "did:key:ed25519:gamemaster1";
const ORACLE: &str = "did:key:ed25519:oracle1";
const PLAYER: &str = "did:key:ed25519:player1";
const FRIEND: &str = "did:key:ed25519:friend1";

fn configure(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>) {
    let out = run(
        engine,
        wasm,
        r#"{"operation":"configure","admin_did":"did:key:ed25519:admin1","issuers":"did:key:ed25519:issuerA,did:key:ed25519:issuerB","threshold":"2","proposal_id":"proposal-asset"}"#,
        host,
    );
    assert!(out.contains(r#""ok":true"#), "configure failed: {out}");
}

fn create_gold(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>) {
    let out = run(
        engine,
        wasm,
        r#"{"operation":"create_token","token_id":"gold","symbol":"GLD","decimals":"2","issuer_dids":"did:key:ed25519:issuerA,did:key:ed25519:issuerB","signatures":"sig-a,sig-b"}"#,
        host,
    );
    assert!(out.contains(r#""ok":true"#), "create_token failed: {out}");
}

fn mint_gold(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>, recipient: &str, amount: u64, reference: &str) {
    let params = format!(
        r#"{{"operation":"mint","token_id":"gold","recipient_did":"{recipient}","amount":"{amount}","ref":"{reference}","issuer_dids":"did:key:ed25519:issuerA,did:key:ed25519:issuerB","signatures":"sig-a,sig-b"}}"#
    );
    let out = run(engine, wasm, &params, host);
    assert!(out.contains(r#""ok":true"#), "mint failed: {out}");
}

fn balance(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>, token: &str, did: &str) -> u64 {
    let params = format!(
        r#"{{"operation":"balance","token_id":"{token}","did":"{did}"}}"#
    );
    let out = run(engine, wasm, &params, host);
    let marker = "\"balance\":";
    let start = out.find(marker).expect("balance field") + marker.len();
    let end = out[start..].find('}').expect("balance end") + start;
    out[start..end].parse().expect("balance numeric")
}

// ═══════════════════════════════════════════════════════════════
// Configuration and token creation
// ═══════════════════════════════════════════════════════════════

#[test]
fn asset_configure_requires_governance() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"configure","admin_did":"did:key:ed25519:admin1","issuers":"did:key:ed25519:issuerA","threshold":"1"}"#,
        host,
        "governance proposal_id required for initial configuration",
    );
}

#[test]
fn asset_configure_governance_rejected() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = Arc::new(TestHost::new(100));
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"configure","admin_did":"did:key:ed25519:admin1","issuers":"did:key:ed25519:issuerA","threshold":"1","proposal_id":"proposal-asset"}"#,
        host,
        "governance has not approved this asset configuration",
    );
}

#[test]
fn asset_create_token_and_duplicate() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"create_token","token_id":"gold","symbol":"GLD","decimals":"2","issuer_dids":"did:key:ed25519:issuerA,did:key:ed25519:issuerB","signatures":"sig-a,sig-b"}"#,
        host,
        "TokenExists",
    );
}

#[test]
fn asset_create_token_below_issuer_threshold() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    host.set_signature(ISSUER_B, false);
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"create_token","token_id":"gold","symbol":"GLD","decimals":"2","issuer_dids":"did:key:ed25519:issuerA,did:key:ed25519:issuerB","signatures":"sig-a,sig-b"}"#,
        host,
        "issuer threshold not met",
    );
}

#[test]
fn asset_token_info() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    mint_gold(&engine, &wasm, host.clone(), GM, 500, "m1");
    let out = run(
        &engine,
        &wasm,
        r#"{"operation":"token_info","token_id":"gold"}"#,
        host,
    );
    assert!(out.contains(r#""symbol":"GLD""#), "symbol missing: {out}");
    assert!(out.contains(r#""total_supply":500"#), "supply missing: {out}");
    assert!(out.contains(r#""transferable":true"#), "transferability missing: {out}");
}

// ═══════════════════════════════════════════════════════════════
// Mint, transfer, burn
// ═══════════════════════════════════════════════════════════════

#[test]
fn asset_mint_threshold_enforced() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());

    host.set_signature(ISSUER_B, false);
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"mint","token_id":"gold","recipient_did":"did:key:ed25519:player1","amount":"100","ref":"m1","issuer_dids":"did:key:ed25519:issuerA,did:key:ed25519:issuerB","signatures":"sig-a,sig-b"}"#,
        host.clone(),
        "issuer threshold not met",
    );
    host.set_signature(ISSUER_B, true);

    mint_gold(&engine, &wasm, host.clone(), PLAYER, 100, "m2");
    assert_eq!(balance(&engine, &wasm, host, "gold", PLAYER), 100);
}

#[test]
fn asset_mint_unknown_token() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"mint","token_id":"silver","recipient_did":"did:key:ed25519:player1","amount":"100","ref":"m1","issuer_dids":"did:key:ed25519:issuerA,did:key:ed25519:issuerB","signatures":"sig-a,sig-b"}"#,
        host,
        "TokenNotFound",
    );
}

#[test]
fn asset_transfer_and_guards() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    mint_gold(&engine, &wasm, host.clone(), PLAYER, 100, "m1");

    let transfer = r#"{"operation":"transfer","token_id":"gold","from_did":"did:key:ed25519:player1","to_did":"did:key:ed25519:friend1","amount":"40","ref":"t1","signature":"sig-p"}"#;
    let out = run(&engine, &wasm, transfer, host.clone());
    assert!(out.contains(r#""recipient_balance":40"#), "transfer failed: {out}");
    assert_eq!(balance(&engine, &wasm, host.clone(), "gold", PLAYER), 60);
    assert_eq!(balance(&engine, &wasm, host.clone(), "gold", FRIEND), 40);

    // self transfer
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"transfer","token_id":"gold","from_did":"did:key:ed25519:player1","to_did":"did:key:ed25519:player1","amount":"10","ref":"t2","signature":"sig-p"}"#,
        host.clone(),
        "cannot transfer to self",
    );
    // insufficient funds
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"transfer","token_id":"gold","from_did":"did:key:ed25519:player1","to_did":"did:key:ed25519:friend1","amount":"61","ref":"t3","signature":"sig-p"}"#,
        host.clone(),
        "InsufficientFunds",
    );
    // bad sender signature
    host.set_signature(PLAYER, false);
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"transfer","token_id":"gold","from_did":"did:key:ed25519:player1","to_did":"did:key:ed25519:friend1","amount":"10","ref":"t4","signature":"sig-bad"}"#,
        host,
        "sender signature verification failed",
    );
}

#[test]
fn asset_burn() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    mint_gold(&engine, &wasm, host.clone(), PLAYER, 100, "m1");

    let out = run(
        &engine,
        &wasm,
        r#"{"operation":"burn","token_id":"gold","owner_did":"did:key:ed25519:player1","amount":"30","ref":"b1","signature":"sig-p"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""balance":70"#), "burn failed: {out}");
    assert_eq!(balance(&engine, &wasm, host, "gold", PLAYER), 70);
}

// ═══════════════════════════════════════════════════════════════
// Timed multisig vaults
// ═══════════════════════════════════════════════════════════════

fn open_vault(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>, expiry: u64) {
    let params = format!(
        r#"{{"operation":"open_vault","vault_id":"esc-hunt","token_id":"gold","approver_dids":"did:key:ed25519:gamemaster1,did:key:ed25519:oracle1","threshold":"2","expiry_block":"{expiry}","fallback_owner_did":"did:key:ed25519:gamemaster1","admin_did":"did:key:ed25519:admin1","admin_sig":"sig-admin"}}"#
    );
    let out = run(engine, wasm, &params, host);
    assert!(out.contains(r#""ok":true"#), "open_vault failed: {out}");
    assert!(out.contains(r#""account":"vault:esc-hunt""#), "vault account missing: {out}");
}

fn deposit(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>, amount: u64) {
    let params = format!(
        r#"{{"operation":"transfer","token_id":"gold","from_did":"did:key:ed25519:gamemaster1","to_did":"vault:esc-hunt","amount":"{amount}","ref":"dep1","signature":"sig-gm"}}"#
    );
    let out = run(engine, wasm, &params, host);
    assert!(out.contains(r#""ok":true"#), "deposit failed: {out}");
}

#[test]
fn asset_vault_open_requires_admin() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    host.set_signature(ADMIN, false);
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"open_vault","vault_id":"esc-hunt","token_id":"gold","approver_dids":"did:key:ed25519:gamemaster1,did:key:ed25519:oracle1","threshold":"2","expiry_block":"500","fallback_owner_did":"did:key:ed25519:gamemaster1","admin_did":"did:key:ed25519:admin1","admin_sig":"sig-admin"}"#,
        host,
        "admin signature verification failed",
    );
}

#[test]
fn asset_vault_threshold_payout_before_expiry() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    mint_gold(&engine, &wasm, host.clone(), GM, 500, "m1");
    open_vault(&engine, &wasm, host.clone(), 500);
    deposit(&engine, &wasm, host.clone(), 500);

    // Single approver is below the 2-of-2 threshold.
    host.set_signature(ORACLE, false);
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"vault_transfer","vault_id":"esc-hunt","token_id":"gold","to_did":"did:key:ed25519:player1","amount":"500","ref":"pay1","cosigner_dids":"did:key:ed25519:gamemaster1,did:key:ed25519:oracle1","signatures":"sig-gm,sig-oracle"}"#,
        host.clone(),
        "vault threshold not met",
    );
    host.set_signature(ORACLE, true);

    let out = run(
        &engine,
        &wasm,
        r#"{"operation":"vault_transfer","vault_id":"esc-hunt","token_id":"gold","to_did":"did:key:ed25519:player1","amount":"500","ref":"pay1","cosigner_dids":"did:key:ed25519:gamemaster1,did:key:ed25519:oracle1","signatures":"sig-gm,sig-oracle"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""recipient_balance":500"#), "payout failed: {out}");
    assert_eq!(balance(&engine, &wasm, host, "gold", PLAYER), 500);
}

#[test]
fn asset_vault_guards() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    mint_gold(&engine, &wasm, host.clone(), GM, 500, "m1");

    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"vault_transfer","vault_id":"missing","token_id":"gold","to_did":"did:key:ed25519:player1","amount":"1","ref":"pay1","cosigner_dids":"did:key:ed25519:gamemaster1","signatures":"sig-gm"}"#,
        host.clone(),
        "VaultNotFound",
    );

    open_vault(&engine, &wasm, host.clone(), 500);
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"vault_transfer","vault_id":"esc-hunt","token_id":"silver","to_did":"did:key:ed25519:player1","amount":"1","ref":"pay1","cosigner_dids":"did:key:ed25519:gamemaster1","signatures":"sig-gm"}"#,
        host.clone(),
        "TokenMismatch",
    );
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"vault_transfer","vault_id":"esc-hunt","token_id":"gold","to_did":"did:key:ed25519:player1","amount":"1","ref":"pay1","cosigner_dids":"did:key:ed25519:gamemaster1","signatures":"sig-gm"}"#,
        host,
        "InsufficientVaultFunds",
    );
}

#[test]
fn asset_vault_fallback_refund_after_expiry() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    mint_gold(&engine, &wasm, host.clone(), GM, 500, "m1");
    open_vault(&engine, &wasm, host.clone(), 500);
    deposit(&engine, &wasm, host.clone(), 500);

    host.set_block_height(600);

    // A non-fallback approver cannot move funds from an expired vault,
    // even though they were a valid pre-expiry cosigner.
    run_expect_error(
        &engine,
        &wasm,
        r#"{"operation":"vault_transfer","vault_id":"esc-hunt","token_id":"gold","to_did":"did:key:ed25519:player1","amount":"500","ref":"raid1","cosigner_dids":"did:key:ed25519:oracle1","signatures":"sig-oracle"}"#,
        host.clone(),
        "vault expired; fallback owner signature required",
    );

    // GM alone (fallback owner) refunds to themselves.
    let out = run(
        &engine,
        &wasm,
        r#"{"operation":"vault_transfer","vault_id":"esc-hunt","token_id":"gold","to_did":"did:key:ed25519:gamemaster1","amount":"500","ref":"ref1","cosigner_dids":"did:key:ed25519:gamemaster1","signatures":"sig-gm"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""expired":true"#), "refund failed: {out}");
    assert_eq!(balance(&engine, &wasm, host.clone(), "gold", GM), 500);

    let info = run(
        &engine,
        &wasm,
        r#"{"operation":"vault_info","vault_id":"esc-hunt"}"#,
        host,
    );
    assert!(info.contains(r#""expired":true"#), "vault info expiry: {info}");
    assert!(info.contains(r#""balance":0"#), "vault info balance: {info}");
}

/// Deadline-window payout: in node mode the escrow claim and the vault
/// transfer are separate ledger entries, so a claim accepted at exactly the
/// deadline block can pay out one block later when the vault is already
/// expired. The fallback owner (GM) is among the cosigned pair, so the
/// expired branch must accept the full GM+oracle envelope TreasureNet sends.
#[test]
fn asset_vault_deadline_window_payout_after_expiry_with_pair() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());
    mint_gold(&engine, &wasm, host.clone(), GM, 500, "m1");
    open_vault(&engine, &wasm, host.clone(), 500);
    deposit(&engine, &wasm, host.clone(), 500);

    // Escrow deadline == vault expiry 500; the payout entry lands at 501.
    host.set_block_height(501);

    let out = run(
        &engine,
        &wasm,
        r#"{"operation":"vault_transfer","vault_id":"esc-hunt","token_id":"gold","to_did":"did:key:ed25519:player1","amount":"500","ref":"claim-1","cosigner_dids":"did:key:ed25519:gamemaster1,did:key:ed25519:oracle1","signatures":"sig-gm,sig-oracle"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""ok":true"#), "deadline-window payout failed: {out}");
    assert!(out.contains(r#""expired":true"#), "payout should report expired path: {out}");
    assert_eq!(balance(&engine, &wasm, host, "gold", PLAYER), 500);
}

/// Full TreasureNet escrow journey with real token custody: issuers mint
/// to the GM, the GM deposits into a timed 2-of-2 vault, the winners claim
/// via GM+oracle signatures, and the winner can transfer onward because
/// the asset is fungible and transferable.
#[test]
fn asset_full_escrow_journey() {
    let engine = make_engine();
    let wasm = load_fixture("citizen_asset.wasm");
    let host = new_host(100);
    configure(&engine, &wasm, host.clone());
    create_gold(&engine, &wasm, host.clone());

    mint_gold(&engine, &wasm, host.clone(), GM, 250, "fund-h1");
    open_vault(&engine, &wasm, host.clone(), 500);
    deposit(&engine, &wasm, host.clone(), 250);

    // 2-of-2 payout to the winner.
    let out = run(
        &engine,
        &wasm,
        r#"{"operation":"vault_transfer","vault_id":"esc-hunt","token_id":"gold","to_did":"did:key:ed25519:player1","amount":"250","ref":"claim-h1","cosigner_dids":"did:key:ed25519:gamemaster1,did:key:ed25519:oracle1","signatures":"sig-gm,sig-oracle"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""ok":true"#), "claim payout failed: {out}");

    // Winner transfers part of the reward onward — the point of a
    // transferable asset versus the soulbound CTZN.
    let onward = run(
        &engine,
        &wasm,
        r#"{"operation":"transfer","token_id":"gold","from_did":"did:key:ed25519:player1","to_did":"did:key:ed25519:friend1","amount":"100","ref":"tip-1","signature":"sig-p"}"#,
        host.clone(),
    );
    assert!(onward.contains(r#""ok":true"#), "onward transfer failed: {onward}");
    assert_eq!(balance(&engine, &wasm, host.clone(), "gold", PLAYER), 150);
    assert_eq!(balance(&engine, &wasm, host, "gold", FRIEND), 100);
}

#[allow(dead_code)]
fn _references() {
    let _ = (ADMIN, ISSUER_A, ISSUER_B, GM, ORACLE, PLAYER, FRIEND);
}
