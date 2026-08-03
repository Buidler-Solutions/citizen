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
