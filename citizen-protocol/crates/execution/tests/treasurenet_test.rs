use citizen_execution::{
    ExecutionConfig, ExecutionEngine, ExecutionError, ExecutionResult, WasmHost,
};
use std::sync::Arc;

/// Test host for TreasureNet Citizen Edition module scenarios. Mirrors the
/// host in integration_test.rs: canned signature/governance results for
/// determinism, persistent per-module state across execute() calls.
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

    fn with_signature(mut self, key: &str, valid: bool) -> Self {
        self.signatures
            .lock()
            .unwrap()
            .insert(key.to_string(), valid);
        self
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
    ) -> Result<Option<String>, ExecutionError> {
        Ok(None)
    }

    fn write_namespace_entry(
        &self,
        namespace: &str,
        payload_json: &str,
    ) -> Result<String, ExecutionError> {
        Ok(format!(
            r#"{{"namespace":"{namespace}","payload":{payload_json}}}"#
        ))
    }

    fn verify_signature(
        &self,
        signer_did: &str,
        _message_hex: &str,
        _signature_hex: &str,
    ) -> Result<bool, ExecutionError> {
        Ok(self
            .signatures
            .lock()
            .unwrap()
            .get(signer_did)
            .copied()
            .unwrap_or(true))
    }

    fn check_governance_approval(&self, proposal_id: &str) -> Result<bool, ExecutionError> {
        Ok(self.governance.get(proposal_id).copied().unwrap_or(false))
    }

    fn current_block_height(&self) -> Result<u64, ExecutionError> {
        Ok(*self.block_height.lock().unwrap())
    }

    fn load_module_bytecode(&self, _module_id: &str) -> Result<Vec<u8>, ExecutionError> {
        Err(ExecutionError::ModuleNotFound(
            "test host does not load modules".into(),
        ))
    }

    fn store_state(&self, _module_id: &str, key: &str, value: &str) -> Result<(), ExecutionError> {
        self.storage
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn load_state(&self, _module_id: &str, key: &str) -> Result<Option<String>, ExecutionError> {
        Ok(self.storage.lock().unwrap().get(key).cloned())
    }

    fn verify_signature_batch(&self, _batch_json: &str) -> Result<u32, ExecutionError> {
        Ok(0)
    }

    fn call_module(
        &self,
        _module_id: &str,
        _params: &str,
    ) -> Result<Option<String>, ExecutionError> {
        Err(ExecutionError::HostError("not supported".into()))
    }
}

fn make_engine() -> ExecutionEngine {
    ExecutionEngine::new(ExecutionConfig::default()).expect("create engine")
}

fn load_fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("tests/fixtures/{}", name)).expect("read fixture")
}

fn run(
    engine: &ExecutionEngine,
    wasm: &Vec<u8>,
    module_id: &str,
    params: &str,
    host: Arc<TestHost>,
) -> String {
    let result = engine
        .execute(wasm, module_id, params, 1_000_000, host)
        .expect("execution should not trap");
    assert!(
        result.success,
        "module should execute cleanly: {:?}",
        result.error
    );
    String::from_utf8_lossy(result.return_value.as_ref().unwrap()).into_owned()
}

fn run_expect_error(
    engine: &ExecutionEngine,
    wasm: &Vec<u8>,
    module_id: &str,
    params: &str,
    host: Arc<TestHost>,
    expected_error: &str,
) {
    let out = run(engine, wasm, module_id, params, host);
    assert!(
        out.contains(&format!(r#""error":"{expected_error}""#)),
        "expected error {expected_error}, got: {out}"
    );
}

const GM: &str = "did:key:ed25519:gamemaster1";
const PLAYER: &str = "did:key:ed25519:player1";
const ORACLE: &str = "did:key:ed25519:oracle1";
const ADMIN: &str = "did:key:ed25519:admin1";

fn configure_escrow(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>) {
    let out = run(
        engine,
        wasm,
        "treasure-escrow.v1",
        r#"{"operation":"configure","admin_did":"did:key:ed25519:admin1","oracles":"did:key:ed25519:oracle1","proposal_id":"proposal-escrow"}"#,
        host,
    );
    assert!(out.contains(r#""ok":true"#), "configure failed: {out}");
}

fn init_escrow(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>, deadline: u64) {
    let params = format!(
        r#"{{"operation":"init","escrow_id":"esc1","owner_did":"{GM}","claimer_did":"{PLAYER}","amount":"500","token":"CTZN","deadline_block":"{deadline}"}}"#
    );
    let out = run(engine, wasm, "treasure-escrow.v1", &params, host);
    assert!(out.contains(r#""ok":true"#), "init failed: {out}");
}

fn fund_escrow(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>) {
    let out = run(
        engine,
        wasm,
        "treasure-escrow.v1",
        r#"{"operation":"fund","escrow_id":"esc1","funder_did":"did:key:ed25519:gamemaster1","signature":"sig-fund"}"#,
        host,
    );
    assert!(out.contains(r#""ok":true"#), "fund failed: {out}");
}

// ═══════════════════════════════════════════════════════════════
// Treasure Escrow: ported Stellar test scenarios
// ═══════════════════════════════════════════════════════════════

#[test]
fn escrow_init() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);

    let out = run(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"get_status","escrow_id":"esc1"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""status":"Created""#), "got: {out}");

    let out = run(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"get_reward","escrow_id":"esc1"}"#,
        host,
    );
    assert!(out.contains(r#""amount":500"#), "got: {out}");
    assert!(out.contains(r#""token":"CTZN""#), "got: {out}");
}

#[test]
fn escrow_init_twice_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);

    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"init","escrow_id":"esc1","owner_did":"did:key:ed25519:gamemaster1","claimer_did":"did:key:ed25519:player1","amount":"500","token":"CTZN","deadline_block":"500"}"#,
        host,
        "AlreadyInitialized",
    );
}

#[test]
fn escrow_fund() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    let out = run(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"get_status","escrow_id":"esc1"}"#,
        host,
    );
    assert!(
        out.contains(r#""status":"Active""#),
        "funded escrow must read Active, got: {out}"
    );
}

#[test]
fn escrow_fund_not_owner_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);

    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"fund","escrow_id":"esc1","funder_did":"did:key:ed25519:intruder","signature":"sig"}"#,
        host,
        "NotOwner",
    );
}

#[test]
fn escrow_double_fund_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"fund","escrow_id":"esc1","funder_did":"did:key:ed25519:gamemaster1","signature":"sig-fund-2"}"#,
        host,
        "AlreadyFunded",
    );
}

#[test]
fn escrow_full_lifecycle_claim() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    let claim = format!(
        r#"{{"operation":"claim","escrow_id":"esc1","winner_did":"{PLAYER}","cosigner_dids":"{GM},{ORACLE}","signatures":"gm-sig,oracle-sig"}}"#
    );
    let out = run(&engine, &wasm, "treasure-escrow.v1", &claim, host.clone());
    assert!(out.contains(r#""ok":true"#), "claim failed: {out}");
    assert!(out.contains(r#""status":"completed""#), "got: {out}");
    assert!(
        out.contains(r#""winner":"did:key:ed25519:player1""#),
        "got: {out}"
    );
    assert!(out.contains(r#""payout":500"#), "got: {out}");

    let out = run(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"get_status","escrow_id":"esc1"}"#,
        host,
    );
    assert!(out.contains(r#""status":"Completed""#), "got: {out}");
}

#[test]
fn escrow_full_lifecycle_refund() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    // Block 200 is past the deadline of 150.
    let host = Arc::new(TestHost::new(200).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 150);
    fund_escrow(&engine, &wasm, host.clone());

    let out = run(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"refund","escrow_id":"esc1","owner_did":"did:key:ed25519:gamemaster1","signature":"sig-refund"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""ok":true"#), "refund failed: {out}");
    assert!(out.contains(r#""status":"refunded""#), "got: {out}");

    let out = run(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"get_status","escrow_id":"esc1"}"#,
        host,
    );
    assert!(out.contains(r#""status":"Refunded""#), "got: {out}");
}

#[test]
fn escrow_claim_without_fund_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);

    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"claim","escrow_id":"esc1","winner_did":"did:key:ed25519:player1","cosigner_dids":"did:key:ed25519:gamemaster1,did:key:ed25519:oracle1","signatures":"a,b"}"#,
        host,
        "NotActive",
    );
}

#[test]
fn escrow_claim_not_owner_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    // The GM signature now verifies as false: the owner did not co-sign.
    host.set_signature(GM, false);

    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"claim","escrow_id":"esc1","winner_did":"did:key:ed25519:player1","cosigner_dids":"did:key:ed25519:gamemaster1,did:key:ed25519:oracle1","signatures":"bad-gm-sig,oracle-sig"}"#,
        host,
        "NotOwner",
    );
}

#[test]
fn escrow_claim_oracle_missing_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    // Only the GM signed: the 2-of-2 multisig policy is not satisfied.
    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"claim","escrow_id":"esc1","winner_did":"did:key:ed25519:player1","cosigner_dids":"did:key:ed25519:gamemaster1","signatures":"gm-sig-only"}"#,
        host,
        "OracleSignatureRequired",
    );
}

#[test]
fn escrow_double_claim_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    let claim = format!(
        r#"{{"operation":"claim","escrow_id":"esc1","winner_did":"{PLAYER}","cosigner_dids":"{GM},{ORACLE}","signatures":"gm-sig,oracle-sig"}}"#
    );
    let out = run(&engine, &wasm, "treasure-escrow.v1", &claim, host.clone());
    assert!(out.contains(r#""ok":true"#));

    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        &claim,
        host,
        "AlreadyClaimed",
    );
}

#[test]
fn escrow_refund_before_expiry_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"refund","escrow_id":"esc1","owner_did":"did:key:ed25519:gamemaster1","signature":"sig-refund"}"#,
        host,
        "NotExpired",
    );
}

#[test]
fn escrow_refund_after_claim_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    let claim = format!(
        r#"{{"operation":"claim","escrow_id":"esc1","winner_did":"{PLAYER}","cosigner_dids":"{GM},{ORACLE}","signatures":"gm-sig,oracle-sig"}}"#
    );
    run(&engine, &wasm, "treasure-escrow.v1", &claim, host.clone());

    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"refund","escrow_id":"esc1","owner_did":"did:key:ed25519:gamemaster1","signature":"sig-refund"}"#,
        host,
        "NotActive",
    );
}

#[test]
fn escrow_refund_after_expiry() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(200).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 150);
    fund_escrow(&engine, &wasm, host.clone());

    let out = run(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"refund","escrow_id":"esc1","owner_did":"did:key:ed25519:gamemaster1","signature":"sig-refund"}"#,
        host,
    );
    assert!(out.contains(r#""ok":true"#), "got: {out}");
    assert!(out.contains(r#""refund":500"#), "got: {out}");
}

#[test]
fn escrow_is_expired() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);

    let out = run(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"is_expired","escrow_id":"esc1"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""expired":false"#), "got: {out}");

    let host_late = Arc::new(TestHost::new(600));
    // Re-init on a fresh host with a past deadline.
    init_escrow(&engine, &wasm, host_late.clone(), 500);
    let out = run(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"is_expired","escrow_id":"esc1"}"#,
        host_late,
    );
    assert!(out.contains(r#""expired":true"#), "got: {out}");
}

#[test]
fn escrow_get_status_uninitialized() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100));
    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"get_status","escrow_id":"missing"}"#,
        host,
        "Uninitialized",
    );
}

#[test]
fn escrow_get_reward_uninitialized() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100));
    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"get_reward","escrow_id":"missing"}"#,
        host,
        "Uninitialized",
    );
}

#[test]
fn escrow_configure_requires_governance() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", false));
    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"configure","admin_did":"did:key:ed25519:admin1","oracles":"did:key:ed25519:oracle1","proposal_id":"proposal-escrow"}"#,
        host,
        "governance has not approved this escrow configuration",
    );
}

// ═══════════════════════════════════════════════════════════════
// Treasure Hunt: ported Stellar test scenarios
// ═══════════════════════════════════════════════════════════════

fn configure_hunt(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>) {
    let out = run(
        engine,
        wasm,
        "treasure-hunt.v1",
        r#"{"operation":"configure","admin_did":"did:key:ed25519:admin1","oracles":"did:key:ed25519:oracle1","proposal_id":"proposal-hunt"}"#,
        host,
    );
    assert!(out.contains(r#""ok":true"#), "configure failed: {out}");
}

fn create_hunt(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>, expires: u64) {
    let params = format!(
        r#"{{"operation":"create_hunt","hunt_id":"hunt1","gm_did":"{GM}","signature":"sig-create","reward_amount":"250","reward_token":"CTZN","expires_block":"{expires}","escrow_id":"esc-hunt1"}}"#
    );
    let out = run(engine, wasm, "treasure-hunt.v1", &params, host);
    assert!(out.contains(r#""ok":true"#), "create failed: {out}");
}

fn fund_hunt(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>) {
    let out = run(
        engine,
        wasm,
        "treasure-hunt.v1",
        r#"{"operation":"fund_hunt","hunt_id":"hunt1","funder_did":"did:key:ed25519:gamemaster1","signature":"sig-fund","amount":"250"}"#,
        host,
    );
    assert!(out.contains(r#""ok":true"#), "fund failed: {out}");
}

fn activate_hunt(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>) {
    let out = run(
        engine,
        wasm,
        "treasure-hunt.v1",
        r#"{"operation":"activate","hunt_id":"hunt1","gm_did":"did:key:ed25519:gamemaster1","signature":"sig-activate"}"#,
        host,
    );
    assert!(out.contains(r#""ok":true"#), "activate failed: {out}");
}

fn claim_hunt_params() -> String {
    format!(
        r#"{{"operation":"claim","hunt_id":"hunt1","winner_did":"{PLAYER}","cosigner_dids":"{GM},{ORACLE}","signatures":"gm-sig,oracle-sig"}}"#
    )
}

#[test]
fn hunt_create_and_fund() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"get_hunt","hunt_id":"hunt1"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""status":"Created""#), "got: {out}");
    assert!(out.contains(r#""reward":250"#), "got: {out}");
    assert!(out.contains(r#""escrow_id":"esc-hunt1""#), "got: {out}");

    fund_hunt(&engine, &wasm, host.clone());
    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"get_hunt","hunt_id":"hunt1"}"#,
        host,
    );
    assert!(out.contains(r#""status":"Funded""#), "got: {out}");
}

#[test]
fn hunt_activate_and_claim() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);
    fund_hunt(&engine, &wasm, host.clone());
    activate_hunt(&engine, &wasm, host.clone());

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"get_hunt","hunt_id":"hunt1"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""status":"Active""#), "got: {out}");

    let claim = claim_hunt_params();
    let out = run(&engine, &wasm, "treasure-hunt.v1", &claim, host.clone());
    assert!(out.contains(r#""ok":true"#), "claim failed: {out}");
    assert!(out.contains(r#""payout":250"#), "got: {out}");
    assert!(
        out.contains(r#""winner":"did:key:ed25519:player1""#),
        "got: {out}"
    );

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"get_hunt","hunt_id":"hunt1"}"#,
        host,
    );
    assert!(out.contains(r#""status":"Completed""#), "got: {out}");
}

#[test]
fn hunt_double_claim_prevented() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);
    fund_hunt(&engine, &wasm, host.clone());
    activate_hunt(&engine, &wasm, host.clone());

    let claim = claim_hunt_params();
    let out = run(&engine, &wasm, "treasure-hunt.v1", &claim, host.clone());
    assert!(out.contains(r#""ok":true"#));

    run_expect_error(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        &claim,
        host,
        "AlreadyClaimed",
    );
}

#[test]
fn hunt_refund_on_expiry() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);
    fund_hunt(&engine, &wasm, host.clone());
    activate_hunt(&engine, &wasm, host.clone());

    // Time passes: the block height advances past the hunt deadline.
    host.set_block_height(600);

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"get_hunt","hunt_id":"hunt1"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""status":"Expired""#), "got: {out}");

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"refund","hunt_id":"hunt1","gm_did":"did:key:ed25519:gamemaster1","signature":"sig-refund"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""ok":true"#), "refund failed: {out}");
    assert!(out.contains(r#""refund":250"#), "got: {out}");

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"get_hunt","hunt_id":"hunt1"}"#,
        host,
    );
    assert!(out.contains(r#""status":"Refunded""#), "got: {out}");
}

#[test]
fn hunt_cancel_before_activation() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);
    fund_hunt(&engine, &wasm, host.clone());

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"cancel","hunt_id":"hunt1","gm_did":"did:key:ed25519:gamemaster1","signature":"sig-cancel"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""ok":true"#), "cancel failed: {out}");

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"get_hunt","hunt_id":"hunt1"}"#,
        host,
    );
    assert!(out.contains(r#""status":"Cancelled""#), "got: {out}");
}

#[test]
fn hunt_cancel_after_activation_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);
    fund_hunt(&engine, &wasm, host.clone());
    activate_hunt(&engine, &wasm, host.clone());

    run_expect_error(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"cancel","hunt_id":"hunt1","gm_did":"did:key:ed25519:gamemaster1","signature":"sig-cancel"}"#,
        host,
        "CannotCancel",
    );
}

#[test]
fn hunt_pause_and_resume() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);
    fund_hunt(&engine, &wasm, host.clone());
    activate_hunt(&engine, &wasm, host.clone());

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"pause","hunt_id":"hunt1","gm_did":"did:key:ed25519:gamemaster1","signature":"sig-pause"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""status":"Paused""#), "got: {out}");

    // Pausing twice fails with AlreadyPaused.
    run_expect_error(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"pause","hunt_id":"hunt1","gm_did":"did:key:ed25519:gamemaster1","signature":"sig-pause"}"#,
        host.clone(),
        "AlreadyPaused",
    );

    // Claiming a paused hunt fails with NotActive.
    run_expect_error(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        &claim_hunt_params(),
        host.clone(),
        "NotActive",
    );

    let out = run(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"resume","hunt_id":"hunt1","gm_did":"did:key:ed25519:gamemaster1","signature":"sig-resume"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""status":"Active""#), "got: {out}");

    // Resuming a non-paused hunt fails with NotPaused.
    run_expect_error(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"resume","hunt_id":"hunt1","gm_did":"did:key:ed25519:gamemaster1","signature":"sig-resume"}"#,
        host,
        "NotPaused",
    );
}

#[test]
fn hunt_duplicate_create_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);

    run_expect_error(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"create_hunt","hunt_id":"hunt1","gm_did":"did:key:ed25519:gamemaster1","signature":"sig-create","reward_amount":"250","reward_token":"CTZN","expires_block":"500"}"#,
        host,
        "AlreadyExists",
    );
}

#[test]
fn hunt_fund_insufficient_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);

    run_expect_error(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"fund_hunt","hunt_id":"hunt1","funder_did":"did:key:ed25519:gamemaster1","signature":"sig-fund","amount":"100"}"#,
        host,
        "InsufficientFunds",
    );
}

#[test]
fn hunt_not_found() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100));
    run_expect_error(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"get_hunt","hunt_id":"ghost"}"#,
        host,
        "NotFound",
    );
}

#[test]
fn hunt_fund_not_owner_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);

    run_expect_error(
        &engine,
        &wasm,
        "treasure-hunt.v1",
        r#"{"operation":"fund_hunt","hunt_id":"hunt1","funder_did":"did:key:ed25519:intruder","signature":"sig","amount":"250"}"#,
        host,
        "NotOwner",
    );
}

// ═══════════════════════════════════════════════════════════════
// Player Registry (soulbound roles): ported SBT + registry scenarios
// ═══════════════════════════════════════════════════════════════

fn configure_registry(engine: &ExecutionEngine, wasm: &Vec<u8>, host: Arc<TestHost>) {
    let out = run(
        engine,
        wasm,
        "player-registry.v1",
        r#"{"operation":"configure","admin_did":"did:key:ed25519:admin1","proposal_id":"proposal-registry"}"#,
        host,
    );
    assert!(out.contains(r#""ok":true"#), "configure failed: {out}");
}

fn grant_role(
    engine: &ExecutionEngine,
    wasm: &Vec<u8>,
    host: Arc<TestHost>,
    did: &str,
    role: &str,
) {
    let params = format!(
        r#"{{"operation":"grant_role","admin_did":"{ADMIN}","signature":"sig-grant","player_did":"{did}","role":"{role}"}}"#
    );
    let out = run(engine, wasm, "player-registry.v1", &params, host);
    assert!(out.contains(r#""ok":true"#), "grant failed: {out}");
}

#[test]
fn registry_init() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());

    let out = run(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"list_counts"}"#,
        host,
    );
    assert!(out.contains(r#""total":0"#), "got: {out}");
}

#[test]
fn registry_init_without_governance_fails() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", false));
    run_expect_error(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"configure","admin_did":"did:key:ed25519:admin1","proposal_id":"proposal-registry"}"#,
        host,
        "governance has not approved this registry configuration",
    );
}

#[test]
fn registry_mint_and_role_of() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());
    grant_role(&engine, &wasm, host.clone(), PLAYER, "player");

    let out = run(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"role_of","did":"did:key:ed25519:player1"}"#,
        host,
    );
    assert!(out.contains(r#""role":"player""#), "got: {out}");
    assert!(out.contains(r#""revoked":false"#), "got: {out}");
}

#[test]
fn registry_mint_duplicate_fails() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());
    grant_role(&engine, &wasm, host.clone(), PLAYER, "player");

    let params = format!(
        r#"{{"operation":"grant_role","admin_did":"{ADMIN}","signature":"sig-grant","player_did":"{PLAYER}","role":"player"}}"#
    );
    run_expect_error(
        &engine,
        &wasm,
        "player-registry.v1",
        &params,
        host,
        "AlreadyRegistered",
    );
}

#[test]
fn registry_non_admin_cannot_mint() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());

    let params = format!(
        r#"{{"operation":"grant_role","admin_did":"{PLAYER}","signature":"sig-grant","player_did":"did:key:ed25519:someone","role":"player"}}"#
    );
    run_expect_error(
        &engine,
        &wasm,
        "player-registry.v1",
        &params,
        host,
        "Unauthorized",
    );
}

#[test]
fn registry_transfer_disabled() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());
    grant_role(&engine, &wasm, host.clone(), PLAYER, "player");

    let out = run(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"transfer","from_did":"did:key:ed25519:player1","to_did":"did:key:ed25519:other"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""ok":false"#), "got: {out}");
    assert!(out.contains("non-transferable"), "got: {out}");

    // Role must remain bound to the original identity.
    let out = run(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"role_of","did":"did:key:ed25519:player1"}"#,
        host,
    );
    assert!(out.contains(r#""role":"player""#), "got: {out}");
}

#[test]
fn registry_revoke() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());
    grant_role(&engine, &wasm, host.clone(), PLAYER, "player");

    let out = run(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"revoke_role","admin_did":"did:key:ed25519:admin1","signature":"sig-revoke","player_did":"did:key:ed25519:player1"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""ok":true"#), "got: {out}");
    assert!(out.contains(r#""revoked":true"#), "got: {out}");

    // Revoked players are no longer registered and fail role gates.
    let out = run(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"is_registered","did":"did:key:ed25519:player1"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""registered":false"#), "got: {out}");

    run_expect_error(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"has_role","did":"did:key:ed25519:player1","role":"player"}"#,
        host,
        "InsufficientRole",
    );
}

#[test]
fn registry_multiple_players() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());
    grant_role(&engine, &wasm, host.clone(), PLAYER, "player");
    grant_role(&engine, &wasm, host.clone(), GM, "gamemaster");
    grant_role(
        &engine,
        &wasm,
        host.clone(),
        "did:key:ed25519:auditor1",
        "auditor",
    );

    let out = run(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"list_counts"}"#,
        host,
    );
    assert!(out.contains(r#""total":3"#), "got: {out}");
    assert!(out.contains(r#""player":1"#), "got: {out}");
    assert!(out.contains(r#""gamemaster":1"#), "got: {out}");
    assert!(out.contains(r#""auditor":1"#), "got: {out}");
}

#[test]
fn registry_role_of_no_token() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());

    run_expect_error(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"role_of","did":"did:key:ed25519:nobody"}"#,
        host,
        "NoRoleToken",
    );
}

#[test]
fn registry_is_registered_no_player() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());

    let out = run(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"is_registered","did":"did:key:ed25519:nobody"}"#,
        host,
    );
    assert!(out.contains(r#""registered":false"#), "got: {out}");
}

#[test]
fn registry_set_sbt_contract_unauthorized() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());

    // Reconfiguration requires a valid admin signature; this one is bogus.
    host.set_signature(ADMIN, false);
    run_expect_error(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"configure","admin_did":"did:key:ed25519:admin1","admin_sig":"bogus"}"#,
        host,
        "Unauthorized",
    );
}

#[test]
fn registry_has_role_gates_actions() {
    let engine = make_engine();
    let wasm = load_fixture("player_registry.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-registry", true));
    configure_registry(&engine, &wasm, host.clone());
    grant_role(&engine, &wasm, host.clone(), PLAYER, "player");

    let out = run(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"has_role","did":"did:key:ed25519:player1","role":"player"}"#,
        host.clone(),
    );
    assert!(out.contains(r#""has_role":true"#), "got: {out}");

    run_expect_error(
        &engine,
        &wasm,
        "player-registry.v1",
        r#"{"operation":"has_role","did":"did:key:ed25519:player1","role":"gamemaster"}"#,
        host,
        "InsufficientRole",
    );
}

// ═══════════════════════════════════════════════════════════════
// Claim delegation: GM authorizes a delegate DID for instant claims
// ═══════════════════════════════════════════════════════════════

const DELEGATE: &str = "did:key:ed25519:service1";

#[test]
fn escrow_claim_delegate_lifecycle() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    // Only the escrow owner may delegate; a forged signature is rejected.
    host.set_signature(GM, false);
    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"set_claim_delegate","escrow_id":"esc1","gm_did":"did:key:ed25519:gamemaster1","signature":"forged","delegate_did":"did:key:ed25519:service1"}"#,
        host.clone(),
        "NotOwner",
    );
    host.set_signature(GM, true);

    // A third party cannot delegate on the owner's behalf.
    run_expect_error(
        &engine,
        &wasm,
        "treasure-escrow.v1",
        r#"{"operation":"set_claim_delegate","escrow_id":"esc1","gm_did":"did:key:ed25519:player1","signature":"sig","delegate_did":"did:key:ed25519:service1"}"#,
        host.clone(),
        "NotOwner",
    );

    let delegate = format!(
        r#"{{"operation":"set_claim_delegate","escrow_id":"esc1","gm_did":"{GM}","signature":"sig-delegate","delegate_did":"{DELEGATE}"}}"#
    );
    let out = run(&engine, &wasm, "treasure-escrow.v1", &delegate, host.clone());
    assert!(out.contains(r#""ok":true"#), "set_claim_delegate failed: {out}");
    assert!(out.contains(r#""delegate":"did:key:ed25519:service1""#), "got: {out}");

    // Delegate + oracle satisfies the 2-of-2 policy (instant claims).
    let claim = format!(
        r#"{{"operation":"claim","escrow_id":"esc1","winner_did":"{PLAYER}","cosigner_dids":"{DELEGATE},{ORACLE}","signatures":"delegate-sig,oracle-sig"}}"#
    );
    let out = run(&engine, &wasm, "treasure-escrow.v1", &claim, host.clone());
    assert!(out.contains(r#""ok":true"#), "delegated claim failed: {out}");
    assert!(out.contains(r#""status":"completed""#), "got: {out}");
}

#[test]
fn escrow_claim_undelegated_did_fails() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_escrow.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-escrow", true));
    configure_escrow(&engine, &wasm, host.clone());
    init_escrow(&engine, &wasm, host.clone(), 500);
    fund_escrow(&engine, &wasm, host.clone());

    // Without a delegation the service DID is just another third party:
    // the owner side of the 2-of-2 envelope is missing.
    let claim = format!(
        r#"{{"operation":"claim","escrow_id":"esc1","winner_did":"{PLAYER}","cosigner_dids":"{DELEGATE},{ORACLE}","signatures":"delegate-sig,oracle-sig"}}"#
    );
    run_expect_error(&engine, &wasm, "treasure-escrow.v1", &claim, host, "NotOwner");
}

#[test]
fn hunt_claim_delegate_lifecycle() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);
    fund_hunt(&engine, &wasm, host.clone());
    activate_hunt(&engine, &wasm, host.clone());

    let delegate = format!(
        r#"{{"operation":"set_claim_delegate","hunt_id":"hunt1","gm_did":"{GM}","signature":"sig-delegate","delegate_did":"{DELEGATE}"}}"#
    );
    let out = run(&engine, &wasm, "treasure-hunt.v1", &delegate, host.clone());
    assert!(out.contains(r#""ok":true"#), "set_claim_delegate failed: {out}");

    let claim = format!(
        r#"{{"operation":"claim","hunt_id":"hunt1","winner_did":"{PLAYER}","cosigner_dids":"{DELEGATE},{ORACLE}","signatures":"delegate-sig,oracle-sig"}}"#
    );
    let out = run(&engine, &wasm, "treasure-hunt.v1", &claim, host);
    assert!(out.contains(r#""ok":true"#), "delegated claim failed: {out}");
    assert!(out.contains(r#""payout":250"#), "got: {out}");
}

#[test]
fn hunt_refund_delegate_rejected() {
    let engine = make_engine();
    let wasm = load_fixture("treasure_hunt.wasm");
    let host = Arc::new(TestHost::new(100).with_governance("proposal-hunt", true));
    configure_hunt(&engine, &wasm, host.clone());
    create_hunt(&engine, &wasm, host.clone(), 500);
    fund_hunt(&engine, &wasm, host.clone());
    activate_hunt(&engine, &wasm, host.clone());

    let delegate = format!(
        r#"{{"operation":"set_claim_delegate","hunt_id":"hunt1","gm_did":"{GM}","signature":"sig-delegate","delegate_did":"{DELEGATE}"}}"#
    );
    let out = run(&engine, &wasm, "treasure-hunt.v1", &delegate, host.clone());
    assert!(out.contains(r#""ok":true"#), "set_claim_delegate failed: {out}");

    // Refunds stay owner-only: the delegate cannot reclaim the escrow.
    host.set_block_height(600);
    let refund = format!(
        r#"{{"operation":"refund","hunt_id":"hunt1","gm_did":"{DELEGATE}","signature":"delegate-sig"}}"#
    );
    run_expect_error(&engine, &wasm, "treasure-hunt.v1", &refund, host, "NotOwner");
}
