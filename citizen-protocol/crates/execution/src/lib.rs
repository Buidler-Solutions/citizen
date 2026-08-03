use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

/// Result of a WASM module execution
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecutionResult {
    /// Whether the module executed successfully
    pub success: bool,
    /// The return value from the module (serialized JSON)
    pub return_value: Option<Vec<u8>>,
    /// Gas consumed during execution
    pub gas_consumed: u64,
    /// Any error message if execution failed
    pub error: Option<String>,
    /// Log messages emitted by the module
    pub logs: Vec<String>,
}

/// Errors that can occur during WASM execution
#[derive(Error, Debug)]
pub enum ExecutionError {
    #[error("module not found: {0}")]
    ModuleNotFound(String),

    #[error("function not found in module: {0}")]
    FunctionNotFound(String),

    #[error("gas limit exceeded: consumed {consumed} of {limit}")]
    GasLimitExceeded { consumed: u64, limit: u64 },

    #[error("host function error: {0}")]
    HostError(String),

    #[error("WASM runtime error: {0}")]
    RuntimeError(String),

    #[error("serialization error: {0}")]
    SerializationError(String),

    #[error("module compilation error: {0}")]
    CompileError(String),

    #[error("access denied: {0}")]
    AccessDenied(String),
}

/// Configuration for the execution engine
#[derive(Clone, Debug)]
pub struct ExecutionConfig {
    /// Default gas limit when none is specified
    pub default_gas_limit: u64,

    /// Maximum memory (in pages, 64KB each) a module can allocate
    pub max_memory_pages: u32,

    /// Maximum stack size for WASM execution (bytes)
    pub max_stack_size: usize,

    /// Allowed module classes that this engine will execute
    pub allowed_module_classes: Vec<String>,
}

impl Default for ExecutionConfig {
    fn default() -> Self {
        Self {
            default_gas_limit: 1_000_000,
            max_memory_pages: 256, // 16 MB
            max_stack_size: 1_048_576, // 1 MB
            allowed_module_classes: vec![
                "policy-guard".into(),
                "deterministic-indexer".into(),
                "receipt-verifier".into(),
            ],
        }
    }
}

/// Host functions available to WASM modules.
///
/// Implementations bridge the WASM sandbox to the Citizen ledger, storage, and
/// governance systems. Each function is deterministic — given the same inputs
/// and state, it must return the same output.
pub trait WasmHost: Send + Sync {
    /// Read an entry from a namespace. Returns JSON.
    fn read_namespace_entry(
        &self,
        namespace: &str,
        entry_id: &str,
    ) -> Result<Option<String>, ExecutionError>;

    /// Write an entry to a namespace. Returns the entry's receipt JSON.
    fn write_namespace_entry(
        &self,
        namespace: &str,
        payload_json: &str,
    ) -> Result<String, ExecutionError>;

    /// Verify a signature from a signer DID.
    fn verify_signature(
        &self,
        signer_did: &str,
        message_hex: &str,
        signature_hex: &str,
    ) -> Result<bool, ExecutionError>;

    /// Check if a governance proposal has been approved.
    fn check_governance_approval(&self, proposal_id: &str) -> Result<bool, ExecutionError>;

    /// Get the current block height.
    fn current_block_height(&self) -> Result<u64, ExecutionError>;

    /// Look up WASM bytecode for a module by its module ID.
    fn load_module_bytecode(&self, module_id: &str) -> Result<Vec<u8>, ExecutionError>;

    /// Store a key-value pair in the module's persistent state.
    /// State is scoped to the calling module ID and persisted across invocations.
    fn store_state(&self, module_id: &str, key: &str, value: &str) -> Result<(), ExecutionError>;

    /// Load a value from the module's persistent state.
    /// Returns None if the key has not been set.
    fn load_state(&self, module_id: &str, key: &str) -> Result<Option<String>, ExecutionError>;
}

/// Registry of deployed WASM modules
#[derive(Clone, Debug, Default)]
pub struct ModuleRegistry {
    modules: HashMap<String, ModuleMetadata>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModuleMetadata {
    pub module_id: String,
    pub module_class: String,
    pub wasm_hash: String,
    pub audit_hash: String,
    pub active: bool,
    pub governance_approvals: u64,
}

impl ModuleRegistry {
    pub fn new() -> Self {
        Self {
            modules: HashMap::new(),
        }
    }

    pub fn register(&mut self, metadata: ModuleMetadata) {
        self.modules.insert(metadata.module_id.clone(), metadata);
    }

    pub fn get(&self, module_id: &str) -> Option<&ModuleMetadata> {
        self.modules.get(module_id)
    }

    pub fn activate(&mut self, module_id: &str) -> Result<(), ExecutionError> {
        let meta = self
            .modules
            .get_mut(module_id)
            .ok_or_else(|| ExecutionError::ModuleNotFound(module_id.to_string()))?;
        meta.active = true;
        Ok(())
    }

    pub fn is_active(&self, module_id: &str) -> bool {
        self.modules
            .get(module_id)
            .map(|m| m.active)
            .unwrap_or(false)
    }
}

// Re-exports
pub use wasmtime;
mod engine;
pub use engine::ExecutionEngine;
