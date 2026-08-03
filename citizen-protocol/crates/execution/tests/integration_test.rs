use citizen_execution::{
    ExecutionConfig, ExecutionEngine, ExecutionError, ExecutionResult, WasmHost,
};
use std::sync::Arc;

/// A test host that returns canned responses for determinism testing
struct TestHost {
    entries: std::collections::HashMap<String, String>,
    signatures: std::collections::HashMap<String, bool>,
    governance: std::collections::HashMap<String, bool>,
    block_height: u64,
    storage: std::sync::Mutex<std::collections::HashMap<String, String>>,
    writes: std::sync::Mutex<Vec<(String, String)>>,
    cross_calls: std::sync::Mutex<Vec<(String, String)>>,
    cross_call_results: std::collections::HashMap<String, String>,
}

impl TestHost {
    fn new(block_height: u64) -> Self {
        Self {
            entries: std::collections::HashMap::new(),
            signatures: std::collections::HashMap::new(),
            governance: std::collections::HashMap::new(),
            block_height,
            storage: std::sync::Mutex::new(std::collections::HashMap::new()),
            writes: std::sync::Mutex::new(Vec::new()),
            cross_calls: std::sync::Mutex::new(Vec::new()),
            cross_call_results: std::collections::HashMap::new(),
        }
    }

    fn with_entry(mut self, key: &str, json: &str) -> Self {
        self.entries.insert(key.to_string(), json.to_string());
        self
    }

    fn with_signature(mut self, key: &str, valid: bool) -> Self {
        self.signatures.insert(key.to_string(), valid);
        self
    }

    fn with_governance(mut self, proposal: &str, approved: bool) -> Self {
        self.governance.insert(proposal.to_string(), approved);
        self
    }

    fn with_cross_call_result(mut self, module_id: &str, result: &str) -> Self {
        self.cross_call_results.insert(module_id.to_string(), result.to_string());
        self
    }

    fn get_writes(&self) -> Vec<(String, String)> {
        self.writes.lock().unwrap().clone()
    }

    fn get_cross_calls(&self) -> Vec<(String, String)> {
        self.cross_calls.lock().unwrap().clone()
    }
}

impl WasmHost for TestHost {
    fn read_namespace_entry(
        &self,
        _namespace: &str,
        entry_id: &str,
    ) -> Result<Option<String>, ExecutionError> {
        Ok(self.entries.get(entry_id).cloned())
    }

    fn write_namespace_entry(
        &self,
        namespace: &str,
        payload_json: &str,
    ) -> Result<String, ExecutionError> {
        self.writes
            .lock()
            .unwrap()
            .push((namespace.to_string(), payload_json.to_string()));
        Ok(format!(r#"{{"namespace":"{namespace}","status":"ok"}}"#))
    }

    fn verify_signature(
        &self,
        signer_did: &str,
        _message_hex: &str,
        _signature_hex: &str,
    ) -> Result<bool, ExecutionError> {
        // In test mode, if the host knows this did, return the recorded result
        // Otherwise, accept all signatures for test simplicity
        Ok(self
            .signatures
            .get(signer_did)
            .copied()
            .unwrap_or(true))
    }

    fn check_governance_approval(
        &self,
        proposal_id: &str,
    ) -> Result<bool, ExecutionError> {
        Ok(self.governance.get(proposal_id).copied().unwrap_or(false))
    }

    fn current_block_height(&self) -> Result<u64, ExecutionError> {
        Ok(self.block_height)
    }

    fn load_module_bytecode(
        &self,
        _module_id: &str,
    ) -> Result<Vec<u8>, ExecutionError> {
        Err(ExecutionError::ModuleNotFound(
            "test host does not load modules".into(),
        ))
    }

    fn store_state(
        &self,
        _module_id: &str,
        key: &str,
        value: &str,
    ) -> Result<(), ExecutionError> {
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
    ) -> Result<Option<String>, ExecutionError> {
        Ok(self.storage.lock().unwrap().get(key).cloned())
    }

    fn verify_signature_batch(&self, batch_json: &str) -> Result<u32, ExecutionError> {
        let items: Vec<serde_json::Value> =
            serde_json::from_str(batch_json).map_err(|e| ExecutionError::HostError(e.to_string()))?;
        let mut valid = 0u32;
        for item in &items {
            let did = item.get("signer_did").and_then(|v| v.as_str()).unwrap_or("");
            let msg = item.get("message_hex").and_then(|v| v.as_str()).unwrap_or("");
            let sig = item.get("signature_hex").and_then(|v| v.as_str()).unwrap_or("");
            if self.verify_signature(did, msg, sig).unwrap_or(false) {
                valid += 1;
            }
        }
        Ok(valid)
    }

    fn call_module(
        &self,
        target_module_id: &str,
        params_json: &str,
    ) -> Result<Option<String>, ExecutionError> {
        self.cross_calls
            .lock()
            .unwrap()
            .push((target_module_id.to_string(), params_json.to_string()));
        Ok(self.cross_call_results.get(target_module_id).cloned())
    }
}

fn make_engine() -> ExecutionEngine {
    ExecutionEngine::new(ExecutionConfig::default()).expect("create engine")
}

fn load_fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("tests/fixtures/{}", name)).expect("read fixture")
}

#[test]
fn execute_access_control_check_access_granted() {
    let engine = make_engine();
    let wasm = load_fixture("access_control_guard.wasm");
    let host = Arc::new(TestHost::new(42));

    let params = r#"{
        "operation": "check_access",
        "signer_did": "did:key:ed25519:test",
        "message_hex": "deadbeef",
        "signature_hex": "abcdef"
    }"#;

    let result = engine
        .execute(&wasm, "test-module", params, 1_000_000, host)
        .expect("execution should succeed");

    assert!(result.success);
    let output = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(output.contains(r#""allowed":true"#));
    assert!(output.contains(r#""block_height":42"#));
    assert!(output.contains(r#""signer":"did:key:ed25519:test""#));

    // Verify log
    assert!(
        result.logs.iter().any(|l| l.contains("GRANTED")),
        "should log GRANTED message"
    );
}

#[test]
fn execute_access_control_check_access_denied() {
    let engine = make_engine();
    let wasm = load_fixture("access_control_guard.wasm");
    let host = Arc::new(
        TestHost::new(42).with_signature("did:key:ed25519:test", false),
    );

    let params = r#"{
        "operation": "check_access",
        "signer_did": "did:key:ed25519:test",
        "message_hex": "deadbeef",
        "signature_hex": "abcdef"
    }"#;

    let result = engine
        .execute(&wasm, "test-module", params, 1_000_000, host)
        .expect("execution should succeed");

    assert!(result.success);
    let output = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(output.contains(r#""allowed":false"#));
    assert!(output.contains("signature verification failed"));
}

#[test]
fn execute_access_control_guard_write_with_entry_found() {
    let engine = make_engine();
    let wasm = load_fixture("access_control_guard.wasm");
    let host = Arc::new(
        TestHost::new(10).with_entry(
            "target-entry",
            r#"{"author":"did:key:ed25519:test","payload":{"data":"hello"}}"#,
        ),
    );

    let params = r#"{
        "operation": "guard_write",
        "signer_did": "did:key:ed25519:test",
        "message_hex": "deadbeef",
        "signature_hex": "abcdef",
        "namespace": "test-ns",
        "entry_id": "target-entry"
    }"#;

    let result = engine
        .execute(&wasm, "test-module", params, 1_000_000, host)
        .expect("execution should succeed");

    assert!(result.success);
    let output = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(output.contains(r#""allowed":true"#));
    assert!(output.contains("entry exists"));
}

#[test]
fn execute_access_control_guard_write_entry_not_found() {
    let engine = make_engine();
    let wasm = load_fixture("access_control_guard.wasm");
    let host = Arc::new(TestHost::new(10));

    let params = r#"{
        "operation": "guard_write",
        "signer_did": "did:key:ed25519:test",
        "message_hex": "deadbeef",
        "signature_hex": "abcdef",
        "namespace": "test-ns",
        "entry_id": "nonexistent"
    }"#;

    let result = engine
        .execute(&wasm, "test-module", params, 1_000_000, host)
        .expect("execution should succeed");

    assert!(result.success);
    let output = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(output.contains(r#""allowed":false"#));
    assert!(output.contains("entry not found"));
}

#[test]
fn execute_access_control_missing_required_field() {
    let engine = make_engine();
    let wasm = load_fixture("access_control_guard.wasm");
    let host = Arc::new(TestHost::new(0));

    let params = r#"{
        "operation": "check_access",
        "signer_did": "did:key:ed25519:test"
    }"#;

    let result = engine
        .execute(&wasm, "test-module", params, 1_000_000, host)
        .expect("execution should succeed");

    let output = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(output.contains(r#""allowed":false"#));
    assert!(output.contains("missing required fields"));
}

#[test]
fn engine_rejects_invalid_wasm() {
    let engine = make_engine();
    let host = Arc::new(TestHost::new(0));
    let bad_wasm = vec![0x00, 0x61, 0x73, 0x6d, 0xFF, 0xFF, 0xFF, 0xFF]; // corrupt wasm

    let result = engine.execute(&bad_wasm, "test-module", "{}", 1_000_000, host);
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("CompileError") || err.contains("compile") || err.contains("parse"),
        "expected compile/runtime error, got: {err}"
    );
}

#[test]
fn engine_deterministic_same_input_same_output() {
    let engine = make_engine();
    let wasm = load_fixture("access_control_guard.wasm");

    let params = r#"{
        "operation": "check_access",
        "signer_did": "did:key:ed25519:alice",
        "message_hex": "01",
        "signature_hex": "02"
    }"#;

    let host1 = Arc::new(TestHost::new(42));
    let host2 = Arc::new(TestHost::new(42));

    let r1 = engine
        .execute(&wasm, "test-module", params, 1_000_000, host1)
        .expect("first execution");
    let r2 = engine
        .execute(&wasm, "test-module", params, 1_000_000, host2)
        .expect("second execution");

    assert_eq!(r1.return_value, r2.return_value);
    assert_eq!(r1.success, r2.success);
    assert_eq!(r1.logs, r2.logs);
}

#[test]
fn engine_enforces_gas_limit() {
    let engine = make_engine();
    let wasm = load_fixture("access_control_guard.wasm");
    let host = Arc::new(TestHost::new(0));
    // 0 fuel should trap immediately on the first instruction
    let result = engine.execute(&wasm, "test-module", r#"{"a":1}"#, 1, host);
    assert!(result.is_err(), "should err with 1 fuel");
}

#[test]
fn engine_gas_is_deterministic() {
    let engine = make_engine();
    let wasm = load_fixture("access_control_guard.wasm");
    let params = r#"{"operation":"check_access","signer_did":"d","message_hex":"e","signature_hex":"f"}"#;
    let h1 = Arc::new(TestHost::new(42));
    let h2 = Arc::new(TestHost::new(42));
    let r1 = engine.execute(&wasm, "test-module", params, 500_000, h1).unwrap();
    let r2 = engine.execute(&wasm, "test-module", params, 500_000, h2).unwrap();
    assert_eq!(r1.gas_consumed, r2.gas_consumed, "gas consumption must be deterministic");
    assert!(r1.gas_consumed > 0, "should consume some gas (consumed {})", r1.gas_consumed);
}

#[test]
fn engine_batch_signature_verification() {
    let host = TestHost::new(0)
        .with_signature("did:key:ed25519:alice", true)
        .with_signature("did:key:ed25519:bob", false)
        .with_signature("did:key:ed25519:carol", true);
    let batch = r#"[
        {"signer_did":"did:key:ed25519:alice","message_hex":"aa","signature_hex":"bb"},
        {"signer_did":"did:key:ed25519:bob","message_hex":"cc","signature_hex":"dd"},
        {"signer_did":"did:key:ed25519:carol","message_hex":"ee","signature_hex":"ff"}
    ]"#;
    assert_eq!(host.verify_signature_batch(batch).unwrap(), 2);
}

#[test]
fn engine_batch_all_rejected() {
    let host = TestHost::new(0).with_signature("did:key:ed25519:a", false);
    let batch = r#"[{"signer_did":"did:key:ed25519:a","message_hex":"x","signature_hex":"y"}]"#;
    assert_eq!(host.verify_signature_batch(batch).unwrap(), 0);
}

#[test]
fn engine_batch_empty() {
    let host = TestHost::new(0);
    assert_eq!(host.verify_signature_batch("[]").unwrap(), 0);
}

#[test]
fn engine_rejects_oversized_bytecode() {
    let mut config = ExecutionConfig::default();
    config.max_bytecode_size = 100;
    let engine = ExecutionEngine::new(config).expect("create engine");
    let wasm = load_fixture("access_control_guard.wasm");
    let host = Arc::new(TestHost::new(0));

    let result = engine.execute(&wasm, "test-module", "{}", 1_000_000, host);
    assert!(result.is_err(), "should reject oversized bytecode");
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("bytecode") || err.contains("size"),
        "expected size violation, got: {err}"
    );
}

#[test]
fn engine_default_config_has_security_limits() {
    let config = ExecutionConfig::default();
    assert!(config.max_bytecode_size > 0, "bytecode size must be bounded");
    assert!(config.max_memory_pages > 0, "memory pages must be bounded");
    assert!(config.max_batch_items > 0, "batch items must be bounded");
    assert!(config.max_batch_json_size > 0, "batch JSON size must be bounded");
    assert!(config.execution_epoch_deadline > 0, "epoch deadline must be set");
    assert!(config.max_call_depth > 0, "call depth must be bounded");
    assert!(config.cross_call_gas_limit > 0, "cross-call gas must be set");
}

#[test]
fn host_call_module_default_returns_error() {
    struct NoCallHost;
    impl WasmHost for NoCallHost {
        fn read_namespace_entry(&self, _: &str, _: &str) -> Result<Option<String>, ExecutionError> { Ok(None) }
        fn write_namespace_entry(&self, _: &str, _: &str) -> Result<String, ExecutionError> { Ok(String::new()) }
        fn verify_signature(&self, _: &str, _: &str, _: &str) -> Result<bool, ExecutionError> { Ok(false) }
        fn check_governance_approval(&self, _: &str) -> Result<bool, ExecutionError> { Ok(false) }
        fn current_block_height(&self) -> Result<u64, ExecutionError> { Ok(0) }
        fn load_module_bytecode(&self, _: &str) -> Result<Vec<u8>, ExecutionError> { Ok(vec![]) }
        fn store_state(&self, _: &str, _: &str, _: &str) -> Result<(), ExecutionError> { Ok(()) }
        fn load_state(&self, _: &str, _: &str) -> Result<Option<String>, ExecutionError> { Ok(None) }
        fn verify_signature_batch(&self, _: &str) -> Result<u32, ExecutionError> { Ok(0) }
    }

    let host = NoCallHost;
    let result = host.call_module("target", "{}");
    assert!(result.is_err(), "default call_module should error");
    let err = result.unwrap_err().to_string();
    assert!(err.contains("not supported"), "expected not-supported error: {err}");
}

#[test]
fn test_host_records_cross_calls() {
    let host = TestHost::new(0)
        .with_cross_call_result("oracle-module", r#"{"price":42000}"#);

    let result = host.call_module("oracle-module", r#"{"query":"btc_usd"}"#).unwrap();
    assert_eq!(result.as_deref(), Some(r#"{"price":42000}"#));

    let calls = host.get_cross_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "oracle-module");
    assert!(calls[0].1.contains("btc_usd"));
}

#[test]
fn test_host_records_writes() {
    let host = TestHost::new(0);
    let receipt = host.write_namespace_entry(
        "records",
        r#"{"object_id":"rec1","payload":{"data":"hello"}}"#,
    ).unwrap();
    assert!(receipt.contains("records"));

    let writes = host.get_writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].0, "records");
    assert!(writes[0].1.contains("rec1"));
}

#[test]
fn test_host_state_persists() {
    let host = TestHost::new(0);
    host.store_state("m1", "counter", "42").unwrap();
    let val = host.load_state("m1", "counter").unwrap();
    assert_eq!(val.as_deref(), Some("42"));

    assert_eq!(host.load_state("m1", "missing").unwrap(), None);
}

// ═══════════════════════════════════════════════════════════════
// CTZN Token (SBT) Module Integration Tests
// ═══════════════════════════════════════════════════════════════
//
// The SBT module is a non-transferable NFT. Tests verify:
//   - mint creates ownership + increments supply
//   - owner_of retrieves the correct owner
//   - total_supply tracks active tokens
//   - get_metadata returns stored metadata
//   - transfer is always rejected
//   - burn removes the token + decrements supply
//   - double-mint is rejected
//   - unauthorized mint (bad signature) is rejected
//
// State persists across execute() calls when sharing the same Arc<TestHost>.

#[test]
fn ctzn_mint_and_owner_of() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    let mint_params = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer1","signature_hex":"abc123","token_id":"token_001","recipient_did":"did:key:ed25519:alice"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", mint_params, 1_000_000, host.clone())
        .expect("mint should succeed");
    assert!(result.success, "mint execution should not trap");
    let mint_out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        mint_out.contains(r#""ok":true"#),
        "mint should return ok:true, got: {mint_out}"
    );
    assert!(mint_out.contains(r#""token_id":"token_001""#));
    assert!(mint_out.contains(r#""owner":"did:key:ed25519:alice""#));
    assert!(mint_out.contains(r#""soulbound":true"#));
    assert!(mint_out.contains(r#""total_supply":1"#));

    // owner_of should see the minted token
    let owner_params = r#"{"operation":"owner_of","token_id":"token_001"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", owner_params, 1_000_000, host)
        .expect("owner_of should succeed");
    assert!(result.success);
    let owner_out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        owner_out.contains(r#""owner":"did:key:ed25519:alice""#),
        "owner_of should return alice, got: {owner_out}"
    );
}

#[test]
fn ctzn_total_supply_increments() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Mint token A
    let params_a = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"a","token_id":"ctzn_a","recipient_did":"did:key:ed25519:bob"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", params_a, 1_000_000, host.clone())
        .expect("mint A");
    assert!(result.success);

    // Mint token B
    let params_b = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"b","token_id":"ctzn_b","recipient_did":"did:key:ed25519:carol"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", params_b, 1_000_000, host.clone())
        .expect("mint B");
    assert!(result.success);

    // Check total_supply
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"total_supply"}"#, 1_000_000, host)
        .expect("total_supply");
    assert!(result.success);
    let supply_out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        supply_out.contains(r#""total_supply":2"#),
        "supply should be 2, got: {supply_out}"
    );
}

#[test]
fn ctzn_transfer_always_rejected() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Mint a token first
    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"x","token_id":"ctzn_t1","recipient_did":"did:key:ed25519:dave"}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    // Attempt transfer — must be rejected
    let transfer = r#"{"operation":"transfer","token_id":"ctzn_t1","from_did":"did:key:ed25519:dave","to_did":"did:key:ed25519:eve"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", transfer, 1_000_000, host.clone())
        .expect("transfer should not trap");
    assert!(result.success, "transfer should not cause a WASM trap");
    let transfer_out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        transfer_out.contains(r#""ok":false"#),
        "transfer should fail, got: {transfer_out}"
    );
    assert!(
        transfer_out.contains("non-transferable"),
        "should explain rejection, got: {transfer_out}"
    );

    // Owner should still be dave, not eve
    let owner = r#"{"operation":"owner_of","token_id":"ctzn_t1"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", owner, 1_000_000, host)
        .expect("owner_of");
    let owner_out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        owner_out.contains(r#""owner":"did:key:ed25519:dave""#),
        "owner should still be dave after failed transfer, got: {owner_out}"
    );
}

#[test]
fn ctzn_burn_removes_token() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Mint
    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"m","token_id":"ctzn_burn","recipient_did":"did:key:ed25519:frank"}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    // Verify supply = 1
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"total_supply"}"#, 1_000_000, host.clone())
        .expect("supply check");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""total_supply":1"#), "supply should be 1: {out}");

    // Burn
    let burn = r#"{"operation":"burn","issuer_did":"did:key:ed25519:issuer","signature_hex":"b","token_id":"ctzn_burn"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", burn, 1_000_000, host.clone())
        .expect("burn should not trap");
    assert!(result.success);
    let burn_out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        burn_out.contains(r#""ok":true"#) && burn_out.contains(r#""burned":true"#),
        "burn should succeed, got: {burn_out}"
    );

    // Verify supply decremented to 0
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"total_supply"}"#, 1_000_000, host.clone())
        .expect("supply after burn");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        out.contains(r#""total_supply":0"#),
        "supply should be 0 after burn, got: {out}"
    );

    // owner_of should show burned state
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"owner_of","token_id":"ctzn_burn"}"#, 1_000_000, host)
        .expect("owner_of burned");
    let owner_out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        owner_out.contains(r#""burned":true"#),
        "burned token should show burned:true, got: {owner_out}"
    );
}

#[test]
fn ctzn_get_metadata() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Mint with metadata
    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:gov","signature_hex":"g","token_id":"ctzn_meta","recipient_did":"did:key:ed25519:grace","metadata":{"degree":"PhD","field":"Cryptography","year":2026}}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint with metadata");

    // Retrieve metadata
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"get_metadata","token_id":"ctzn_meta"}"#, 1_000_000, host)
        .expect("get_metadata");
    assert!(result.success);
    let meta_out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        meta_out.contains(r#""token_id":"ctzn_meta""#),
        "should echo token_id, got: {meta_out}"
    );
    assert!(
        meta_out.contains("PhD") && meta_out.contains("Cryptography"),
        "should contain metadata fields, got: {meta_out}"
    );
}

#[test]
fn ctzn_double_mint_rejected() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // First mint succeeds
    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"1","token_id":"ctzn_dup","recipient_did":"did:key:ed25519:henry"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("first mint");
    assert!(result.success);
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""ok":true"#), "first mint ok: {out}");

    // Second mint of same token_id must fail
    let mint2 = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"2","token_id":"ctzn_dup","recipient_did":"did:key:ed25519:ivan"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", mint2, 1_000_000, host)
        .expect("second mint should not trap");
    assert!(result.success, "should not cause WASM trap");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        out.contains(r#""ok":false"#),
        "double mint should fail, got: {out}"
    );
    assert!(
        out.contains("already minted"),
        "should explain duplicate, got: {out}"
    );
}

#[test]
fn ctzn_unauthorized_mint_rejected() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");

    // Mark the issuer's signature as invalid
    let host = Arc::new(
        TestHost::new(100).with_signature("did:key:ed25519:bad_issuer", false),
    );

    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:bad_issuer","signature_hex":"fakesig","token_id":"ctzn_unauth","recipient_did":"did:key:ed25519:judy"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("unauthorized mint should not trap");
    assert!(result.success, "should not cause WASM trap");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        out.contains(r#""ok":false"#),
        "unauthorized mint should fail, got: {out}"
    );
    assert!(
        out.contains("signature"),
        "should mention signature failure, got: {out}"
    );

    // Token should not exist
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"owner_of","token_id":"ctzn_unauth"}"#, 1_000_000, host)
        .expect("owner_of");
    let owner_out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        owner_out.contains(r#""ok":false"#) || owner_out.contains("not found"),
        "token should not exist, got: {owner_out}"
    );
}

// ═══════════════════════════════════════════════════════════════
// CTZN Advanced Feature Tests
// ═══════════════════════════════════════════════════════════════

// ── Multi-Issuer Authority ──

#[test]
fn ctzn_configure_and_mint_multi_issuer() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Bootstrap configuration: 3 issuers, threshold 2
    let configure = r#"{"operation":"configure","admin_did":"did:key:ed25519:admin","admin_sig":"sig","issuers":"did:key:ed25519:uni,did:key:ed25519:gov,did:key:ed25519:corp","threshold":"2"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", configure, 1_000_000, host.clone())
        .expect("configure");
    assert!(result.success);
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""ok":true"#), "configure should succeed: {out}");
    assert!(out.contains(r#""issuers":3"#));
    assert!(out.contains(r#""threshold":2"#));

    // Mint with 2 valid issuers (uni + gov) — meets threshold
    let mint = r#"{"operation":"mint","issuer_dids":"did:key:ed25519:uni,did:key:ed25519:gov","signatures":"sig1,sig2","token_id":"ctzn_multi","recipient_did":"did:key:ed25519:alice"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");
    assert!(result.success);
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""ok":true"#), "mint with 2 issuers should succeed: {out}");
    assert!(out.contains(r#""verified_issuers":2"#));
    assert!(out.contains(r#""required_issuers":2"#));
}

#[test]
fn ctzn_mint_below_threshold_rejected() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Configure: threshold 2
    let configure = r#"{"operation":"configure","admin_did":"did:key:ed25519:admin","admin_sig":"s","issuers":"did:key:ed25519:a,did:key:ed25519:b","threshold":"2"}"#;
    engine
        .execute(&wasm, "ctzn-module", configure, 1_000_000, host.clone())
        .expect("configure");

    // Mint with only 1 issuer — below threshold
    let mint = r#"{"operation":"mint","issuer_dids":"did:key:ed25519:a","signatures":"sig1","token_id":"ctzn_low","recipient_did":"did:key:ed25519:bob"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host)
        .expect("mint");
    assert!(result.success);
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""ok":false"#), "below-threshold mint should fail: {out}");
    assert!(out.contains("insufficient"), "should explain: {out}");
}

#[test]
fn ctzn_mint_unauthorized_issuer_rejected() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Configure: only uni and gov are authorized
    let configure = r#"{"operation":"configure","admin_did":"did:key:ed25519:admin","admin_sig":"s","issuers":"did:key:ed25519:uni,did:key:ed25519:gov","threshold":"2"}"#;
    engine
        .execute(&wasm, "ctzn-module", configure, 1_000_000, host.clone())
        .expect("configure");

    // Mint with an unauthorized issuer + authorized issuer
    let mint = r#"{"operation":"mint","issuer_dids":"did:key:ed25519:evil,did:key:ed25519:uni","signatures":"s1,s2","token_id":"ctzn_unauthz","recipient_did":"did:key:ed25519:bob"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host)
        .expect("mint");
    assert!(result.success);
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(
        out.contains(r#""ok":false"#) && out.contains("insufficient"),
        "unauthorized issuer should not count, got: {out}"
    );
}

#[test]
fn ctzn_reconfigure_requires_admin_sig() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(
        TestHost::new(100)
            .with_signature("did:key:ed25519:admin", false),
    );

    // Bootstrap (no verification needed)
    let configure1 = r#"{"operation":"configure","admin_did":"did:key:ed25519:admin","admin_sig":"s","issuers":"did:key:ed25519:uni","threshold":"1"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", configure1, 1_000_000, host.clone())
        .expect("bootstrap");
    assert!(result.success);

    // Reconfigure — admin sig marked as invalid
    let configure2 = r#"{"operation":"configure","admin_did":"did:key:ed25519:attacker","admin_sig":"fake","issuers":"did:key:ed25519:evil","threshold":"1"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", configure2, 1_000_000, host)
        .expect("reconfigure");
    assert!(result.success);
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""ok":false"#), "reconfigure without admin sig should fail: {out}");
    assert!(out.contains("signature"), "should mention signature: {out}");
}

// ── Hierarchical Tiers ──

#[test]
fn ctzn_tiers_and_per_tier_supply() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Mint one of each tier
    let mint_bronze = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"s","token_id":"ctzn_b","recipient_did":"did:key:ed25519:b1","tier":"bronze"}"#;
    engine.execute(&wasm, "ctzn-module", mint_bronze, 1_000_000, host.clone()).expect("bronze");

    let mint_silver = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"s","token_id":"ctzn_s","recipient_did":"did:key:ed25519:s1","tier":"silver"}"#;
    engine.execute(&wasm, "ctzn-module", mint_silver, 1_000_000, host.clone()).expect("silver");

    let mint_gold = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"s","token_id":"ctzn_g","recipient_did":"did:key:ed25519:g1","tier":"2"}"#;
    engine.execute(&wasm, "ctzn-module", mint_gold, 1_000_000, host.clone()).expect("gold");

    // Check supply breakdown
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"total_supply"}"#, 1_000_000, host.clone())
        .expect("supply");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""total_supply":3"#), "total should be 3: {out}");
    assert!(out.contains(r#""bronze":1"#));
    assert!(out.contains(r#""silver":1"#));
    assert!(out.contains(r#""gold":1"#));

    // Verify tier in owner_of
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"owner_of","token_id":"ctzn_g"}"#, 1_000_000, host.clone())
        .expect("owner");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""tier":"gold""#), "should show gold tier: {out}");
}

// ── Custom Metadata Schemas ──

#[test]
fn ctzn_schema_and_metadata() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:uni","signature_hex":"s","token_id":"ctzn_deg","recipient_did":"did:key:ed25519:student","tier":"gold","schema_type":"degree","metadata":{"degree":"MSc","field":"Computer Science","university":"Citizen U"}}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    // Verify schema in mint response was correct
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"get_metadata","token_id":"ctzn_deg"}"#, 1_000_000, host)
        .expect("metadata");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""schema":"degree""#), "should show degree schema: {out}");
    assert!(out.contains("MSc") && out.contains("Computer Science"), "should contain metadata: {out}");
    assert!(out.contains(r#""tier":"gold""#), "should show tier: {out}");
}

// ── Time-Locked / Expirable Tokens ──

#[test]
fn ctzn_expiry_active_token() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Mint with expiry at block 500 (current = 100, so not expired)
    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"s","token_id":"ctzn_exp_ok","recipient_did":"did:key:ed25519:alice","expiry_block":"500"}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"owner_of","token_id":"ctzn_exp_ok"}"#, 1_000_000, host)
        .expect("owner");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""expired":false"#), "should not be expired: {out}");
    assert!(out.contains(r#""expiry_block":500"#));
}

#[test]
fn ctzn_expiry_already_expired() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(300));

    // Mint with expiry at block 50 (current = 300, so already expired)
    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"s","token_id":"ctzn_exp_dead","recipient_did":"did:key:ed25519:bob","expiry_block":"50"}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"owner_of","token_id":"ctzn_exp_dead"}"#, 1_000_000, host)
        .expect("owner");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""expired":true"#), "should be expired: {out}");
}

// ── Revocable Tokens ──

#[test]
fn ctzn_revoke_flow() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:issuer","signature_hex":"s","token_id":"ctzn_rev","recipient_did":"did:key:ed25519:carol"}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    // Revoke
    let revoke = r#"{"operation":"revoke","issuer_did":"did:key:ed25519:issuer","signature_hex":"s","token_id":"ctzn_rev"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", revoke, 1_000_000, host.clone())
        .expect("revoke");
    assert!(result.success);
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""ok":true"#) && out.contains(r#""revoked":true"#), "revoke should succeed: {out}");

    // Verify revoked status in owner_of
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"owner_of","token_id":"ctzn_rev"}"#, 1_000_000, host.clone())
        .expect("owner");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""revoked":true"#), "should show revoked: {out}");

    // Supply should have decremented
    let result = engine
        .execute(&wasm, "ctzn-module", r#"{"operation":"total_supply"}"#, 1_000_000, host)
        .expect("supply");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""total_supply":0"#), "supply should be 0 after revoke: {out}");
}

// ── Attribute-Based Access Control ──

#[test]
fn ctzn_check_access_with_token_id_granted() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Mint a gold degree token to alice
    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:uni","signature_hex":"s","token_id":"ctzn_access_1","recipient_did":"did:key:ed25519:alice","tier":"gold","schema_type":"degree"}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    // Alice checks access with her token
    let check = r#"{"operation":"check_access","did":"did:key:ed25519:alice","token_id":"ctzn_access_1","required_tier":"silver"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", check, 1_000_000, host)
        .expect("check");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""has_access":true"#), "gold >= silver, should be granted: {out}");
    assert!(out.contains(r#""tier":"gold""#));
}

#[test]
fn ctzn_check_access_denied_insufficient_tier() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Mint a bronze token to alice
    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:uni","signature_hex":"s","token_id":"ctzn_low_tier","recipient_did":"did:key:ed25519:alice","tier":"0"}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    // Check access requiring silver — bronze < silver
    let check = r#"{"operation":"check_access","did":"did:key:ed25519:alice","token_id":"ctzn_low_tier","required_tier":"silver"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", check, 1_000_000, host)
        .expect("check");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""has_access":false"#), "bronze < silver, should be denied: {out}");
    assert!(out.contains("tier"), "should mention tier: {out}");
}

#[test]
fn ctzn_check_access_denied_schema_mismatch() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:uni","signature_hex":"s","token_id":"ctzn_schema_m","recipient_did":"did:key:ed25519:alice","schema_type":"degree"}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    // Check access requiring "reputation" schema — token is "degree"
    let check = r#"{"operation":"check_access","did":"did:key:ed25519:alice","token_id":"ctzn_schema_m","required_schema":"reputation"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", check, 1_000_000, host)
        .expect("check");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""has_access":false"#), "schema mismatch should be denied: {out}");
    assert!(out.contains("schema"), "should mention schema: {out}");
}

#[test]
fn ctzn_check_access_denied_not_owner() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    let mint = r#"{"operation":"mint","issuer_did":"did:key:ed25519:uni","signature_hex":"s","token_id":"ctzn_notown","recipient_did":"did:key:ed25519:alice"}"#;
    engine
        .execute(&wasm, "ctzn-module", mint, 1_000_000, host.clone())
        .expect("mint");

    // Bob tries to access alice's token
    let check = r#"{"operation":"check_access","did":"did:key:ed25519:bob","token_id":"ctzn_notown"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", check, 1_000_000, host)
        .expect("check");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""has_access":false"#), "non-owner should be denied: {out}");
    assert!(out.contains("not owner"), "should explain: {out}");
}

#[test]
fn ctzn_check_access_enumerate_held_tokens() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    // Mint two tokens to alice: one bronze degree, one gold reputation
    let mint1 = r#"{"operation":"mint","issuer_did":"did:key:ed25519:uni","signature_hex":"s","token_id":"ctzn_e1","recipient_did":"did:key:ed25519:alice","tier":"bronze","schema_type":"degree"}"#;
    engine.execute(&wasm, "ctzn-module", mint1, 1_000_000, host.clone()).expect("mint1");

    let mint2 = r#"{"operation":"mint","issuer_did":"did:key:ed25519:gov","signature_hex":"s","token_id":"ctzn_e2","recipient_did":"did:key:ed25519:alice","tier":"gold","schema_type":"reputation"}"#;
    engine.execute(&wasm, "ctzn-module", mint2, 1_000_000, host.clone()).expect("mint2");

    // Enumerate: no token_id, require gold tier — should find ctzn_e2
    let check = r#"{"operation":"check_access","did":"did:key:ed25519:alice","required_tier":"gold"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", check, 1_000_000, host.clone())
        .expect("check");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""has_access":true"#), "should find gold token: {out}");
    assert!(out.contains(r#""token_id":"ctzn_e2""#), "should match the gold token: {out}");

    // Enumerate: require silver reputation — ctzn_e2 is gold reputation
    let check2 = r#"{"operation":"check_access","did":"did:key:ed25519:alice","required_tier":"silver","required_schema":"reputation"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", check2, 1_000_000, host)
        .expect("check2");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""has_access":true"#), "gold reputation >= silver reputation: {out}");
}

#[test]
fn ctzn_check_access_no_holdings() {
    let engine = make_engine();
    let wasm = load_fixture("ctzn_token.wasm");
    let host = Arc::new(TestHost::new(100));

    let check = r#"{"operation":"check_access","did":"did:key:ed25519:nobody"}"#;
    let result = engine
        .execute(&wasm, "ctzn-module", check, 1_000_000, host)
        .expect("check");
    let out = String::from_utf8_lossy(result.return_value.as_ref().unwrap());
    assert!(out.contains(r#""has_access":false"#), "no tokens should deny: {out}");
    assert!(out.contains("no tokens"), "should explain: {out}");
}
