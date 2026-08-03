use crate::{ExecutionConfig, ExecutionError, ExecutionResult, WasmHost};
use std::sync::Arc;
use wasmtime::{Engine, Linker, Memory, Module, Store, StoreLimits, StoreLimitsBuilder};

const MODULE_CATEGORY: &str = "env";

/// Host functions that modules are allowed to import.
/// Any import outside this list or the "env" namespace is rejected.
const ALLOWED_HOST_FUNCTIONS: &[&str] = &[
    "host_log",
    "host_read_namespace_entry",
    "host_write_namespace_entry",
    "host_verify_signature",
    "host_check_governance_approval",
    "host_verify_signature_batch",
    "host_current_block_height",
    "host_store_state",
    "host_load_state",
    "host_call_module",
];

/// Maximum length of a single host string read from WASM memory (1 MB).
const MAX_HOST_STRING_LEN: usize = 1_048_576;

/// The WASM execution engine.
///
/// Compiles modules from bytecode, registers host functions that bridge
/// to the Citizen ledger, and executes modules with deterministic gas metering.
pub struct ExecutionEngine {
    engine: Engine,
    config: ExecutionConfig,
}

impl ExecutionEngine {
    pub fn new(config: ExecutionConfig) -> Result<Self, ExecutionError> {
        let mut wasmtime_config = wasmtime::Config::new();
        wasmtime_config.consume_fuel(true);
        wasmtime_config.strategy(wasmtime::Strategy::Cranelift);
        wasmtime_config.cranelift_opt_level(wasmtime::OptLevel::Speed);
        wasmtime_config.epoch_interruption(true);

        let engine = Engine::new(&wasmtime_config)
            .map_err(|e| ExecutionError::CompileError(e.to_string()))?;

        Ok(Self { engine, config })
    }

    /// Execute a WASM module's exported `handle` function.
    ///
    /// Module ABI:
    /// - `alloc(u32) -> u32` — allocates bytes in linear memory
    /// - `handle(u32, u32) -> u64` — main handler: (param_ptr, param_len) -> packed_result
    ///   Packed result: `(result_ptr << 32) | result_len`
    pub fn execute(
        &self,
        wasm_bytes: &[u8],
        module_id: &str,
        params_json: &str,
        gas_limit: u64,
        host: Arc<dyn WasmHost>,
    ) -> Result<ExecutionResult, ExecutionError> {
        if wasm_bytes.len() > self.config.max_bytecode_size {
            return Err(ExecutionError::SecurityViolation(format!(
                "module bytecode exceeds size limit: {} bytes (max {})",
                wasm_bytes.len(),
                self.config.max_bytecode_size
            )));
        }

        let module = Module::new(&self.engine, wasm_bytes)
            .map_err(|e| ExecutionError::CompileError(e.to_string()))?;

        Self::validate_module_imports(&module)?;

        let max_memory_bytes = (self.config.max_memory_pages as usize) * 64 * 1024;
        let limits = StoreLimitsBuilder::new()
            .memory_size(max_memory_bytes)
            .build();

        let mut store = Store::new(
            &self.engine,
            StoreState {
                host,
                logs: Vec::new(),
                module_id: module_id.to_string(),
                limits,
            },
        );

        store.limiter(|state| &mut state.limits);

        store
            .set_fuel(gas_limit)
            .map_err(|e| ExecutionError::RuntimeError(format!("set_fuel: {e}")))?;

        store.set_epoch_deadline(self.config.execution_epoch_deadline);

        let mut linker: Linker<StoreState> = Linker::new(&self.engine);
        self.link_host_functions(&mut linker)?;

        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| ExecutionError::RuntimeError("module must export 'memory'".into()))?;

        let alloc = instance
            .get_typed_func::<u32, u32>(&mut store, "alloc")
            .map_err(|_| {
                ExecutionError::FunctionNotFound(
                    "module must export 'alloc' (u32) -> u32".into(),
                )
            })?;

        let handle = instance
            .get_typed_func::<(u32, u32), u64>(&mut store, "handle")
            .map_err(|_| {
                ExecutionError::FunctionNotFound(
                    "module must export 'handle' (u32, u32) -> u64".into(),
                )
            })?;

        let params_bytes = params_json.as_bytes();
        let params_ptr = alloc
            .call(&mut store, params_bytes.len() as u32)
            .map_err(|e| Self::classify_runtime_error(&e.to_string(), gas_limit))?;

        memory
            .write(&mut store, params_ptr as usize, params_bytes)
            .map_err(|e| ExecutionError::RuntimeError(format!("memory write failed: {e}")))?;

        let packed = handle
            .call(&mut store, (params_ptr, params_bytes.len() as u32))
            .map_err(|e| Self::classify_runtime_error(&e.to_string(), gas_limit))?;

        let gas_consumed = store.get_fuel().map(|remaining| {
            gas_limit.saturating_sub(remaining)
        }).unwrap_or(gas_limit);

        let result_ptr = (packed >> 32) as u32;
        let result_len = (packed & 0xFFFF_FFFF) as usize;

        if result_len > MAX_HOST_STRING_LEN {
            return Err(ExecutionError::SecurityViolation(format!(
                "module returned result exceeding max size: {result_len} bytes (max {MAX_HOST_STRING_LEN})"
            )));
        }

        let return_value = if result_ptr > 0 && result_len > 0 {
            let mut buf = vec![0u8; result_len];
            memory
                .read(&store, result_ptr as usize, &mut buf)
                .map_err(|e| ExecutionError::RuntimeError(format!("memory read failed: {e}")))?;
            Some(buf)
        } else {
            None
        };

        let logs = store.into_data().logs;

        Ok(ExecutionResult {
            success: true,
            return_value,
            gas_consumed,
            error: None,
            logs,
        })
    }

    /// Classify a wasmtime error as either gas exhaustion or a generic runtime error.
    fn classify_runtime_error(msg: &str, gas_limit: u64) -> ExecutionError {
        if msg.contains("fuel")
            || msg.contains("all fuel consumed")
            || msg.contains("out of fuel")
        {
            ExecutionError::GasLimitExceeded {
                consumed: gas_limit,
                limit: gas_limit,
            }
        } else {
            ExecutionError::RuntimeError(msg.to_string())
        }
    }

    /// Validate that a module only imports from the allowed "env" namespace
    /// and only imports known host functions.
    fn validate_module_imports(module: &Module) -> Result<(), ExecutionError> {
        for import in module.imports() {
            if import.module() != MODULE_CATEGORY {
                return Err(ExecutionError::SecurityViolation(format!(
                    "module imports from unauthorized namespace '{}' (only '{}' is allowed)",
                    import.module(),
                    MODULE_CATEGORY
                )));
            }
            if !ALLOWED_HOST_FUNCTIONS.contains(&import.name()) {
                return Err(ExecutionError::SecurityViolation(format!(
                    "module imports unknown host function '{}'",
                    import.name()
                )));
            }
        }
        Ok(())
    }

    fn link_host_functions(&self, linker: &mut Linker<StoreState>) -> Result<(), ExecutionError> {
        let max_batch_items = self.config.max_batch_items;
        let max_batch_json_size = self.config.max_batch_json_size;

        // host_log(ptr: u32, len: u32)
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_log",
                move |mut caller: wasmtime::Caller<'_, StoreState>, ptr: u32, len: u32| {
                    if len as usize > MAX_HOST_STRING_LEN {
                        return;
                    }
                    if let Some(mem) = get_memory(&mut caller) {
                        let mut buf = vec![0u8; len as usize];
                        if mem.read(&caller, ptr as usize, &mut buf).is_ok() {
                            if let Ok(msg) = std::str::from_utf8(&buf) {
                                caller.data_mut().logs.push(msg.to_string());
                            }
                        }
                    }
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        // host_read_namespace_entry(
        //   ns_ptr, ns_len, entry_id_ptr, entry_id_len,
        //   out_buf_ptr, out_buf_len
        // ) -> u64 — packed: (bytes_written << 32) | status (0=ok, 1=not_found, 2=error)
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_read_namespace_entry",
                |mut caller: wasmtime::Caller<'_, StoreState>,
                 ns_ptr: u32,
                 ns_len: u32,
                 eid_ptr: u32,
                 eid_len: u32,
                 out_ptr: u32,
                 out_len: u32|
                 -> u64 {
                    let namespace = read_wasm_str(&mut caller, ns_ptr, ns_len);
                    let entry_id = read_wasm_str(&mut caller, eid_ptr, eid_len);
                    let host = &caller.data().host;
                    let result = host.read_namespace_entry(&namespace, &entry_id);
                    write_host_result(&mut caller, out_ptr, out_len, result)
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        // host_write_namespace_entry(ns_ptr, ns_len, payload_ptr, payload_len, out_ptr, out_len) -> u64
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_write_namespace_entry",
                |mut caller: wasmtime::Caller<'_, StoreState>,
                 ns_ptr: u32,
                 ns_len: u32,
                 payload_ptr: u32,
                 payload_len: u32,
                 out_ptr: u32,
                 out_len: u32|
                 -> u64 {
                    let namespace = read_wasm_str(&mut caller, ns_ptr, ns_len);
                    let payload = read_wasm_str(&mut caller, payload_ptr, payload_len);
                    let host = &caller.data().host;
                    let result = host.write_namespace_entry(&namespace, &payload);
                    write_host_string_result(&mut caller, out_ptr, out_len, result)
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        // host_verify_signature(did_ptr, did_len, msg_ptr, msg_len, sig_ptr, sig_len) -> u32
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_verify_signature",
                |mut caller: wasmtime::Caller<'_, StoreState>,
                 did_ptr: u32,
                 did_len: u32,
                 msg_ptr: u32,
                 msg_len: u32,
                 sig_ptr: u32,
                 sig_len: u32|
                 -> u32 {
                    let did = read_wasm_str(&mut caller, did_ptr, did_len);
                    let msg = read_wasm_str(&mut caller, msg_ptr, msg_len);
                    let sig = read_wasm_str(&mut caller, sig_ptr, sig_len);
                    let valid = caller
                        .data()
                        .host
                        .verify_signature(&did, &msg, &sig)
                        .unwrap_or(false);
                    if valid { 1 } else { 0 }
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        // host_check_governance_approval(pid_ptr, pid_len) -> u32
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_check_governance_approval",
                |mut caller: wasmtime::Caller<'_, StoreState>, pid_ptr: u32, pid_len: u32| -> u32 {
                    let proposal_id = read_wasm_str(&mut caller, pid_ptr, pid_len);
                    let approved = caller
                        .data()
                        .host
                        .check_governance_approval(&proposal_id)
                        .unwrap_or(false);
                    if approved { 1 } else { 0 }
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        // host_verify_signature_batch(json_ptr, json_len) -> u32
        // Returns the count of valid signatures in the batch.
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_verify_signature_batch",
                move |mut caller: wasmtime::Caller<'_, StoreState>, json_ptr: u32, json_len: u32| -> u32 {
                    if json_len as usize > max_batch_json_size {
                        return 0;
                    }
                    let batch_json = read_wasm_str(&mut caller, json_ptr, json_len);
                    let _ = max_batch_items;
                    caller
                        .data()
                        .host
                        .verify_signature_batch(&batch_json)
                        .unwrap_or(0)
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        // host_current_block_height() -> u64
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_current_block_height",
                |caller: wasmtime::Caller<'_, StoreState>| -> u64 {
                    caller.data().host.current_block_height().unwrap_or(0)
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        // host_store_state(key_ptr, key_len, val_ptr, val_len) -> u32 (0=ok, 1=error)
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_store_state",
                |mut caller: wasmtime::Caller<'_, StoreState>,
                 key_ptr: u32, key_len: u32,
                 val_ptr: u32, val_len: u32| -> u32 {
                    let key = read_wasm_str(&mut caller, key_ptr, key_len);
                    let val = read_wasm_str(&mut caller, val_ptr, val_len);
                    let module_id = &caller.data().module_id;
                    match caller.data().host.store_state(module_id, &key, &val) {
                        Ok(()) => 0,
                        Err(_) => 1,
                    }
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        // host_load_state(key_ptr, key_len, out_ptr, out_len) -> u64
        // packed: (bytes_written << 32) | status (0=ok, 1=not_found, 2=error)
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_load_state",
                |mut caller: wasmtime::Caller<'_, StoreState>,
                 key_ptr: u32, key_len: u32,
                 out_ptr: u32, out_len: u32| -> u64 {
                    let key = read_wasm_str(&mut caller, key_ptr, key_len);
                    let module_id = &caller.data().module_id;
                    let result = caller.data().host.load_state(module_id, &key);
                    match result {
                        Ok(Some(json)) => {
                            let bytes = json.as_bytes();
                            let written = bytes.len().min(out_len as usize) as u64;
                            if let Some(mem) = get_memory(&mut caller) {
                                let _ = mem.write(&mut caller, out_ptr as usize, &bytes[..written as usize]);
                            }
                            (written << 32) | 0
                        }
                        Ok(None) => 1,
                        Err(e) => {
                            let msg = format!(r#"{{"error":"{}"}}"#, e);
                            let bytes = msg.as_bytes();
                            let written = bytes.len().min(out_len as usize) as u64;
                            if let Some(mem) = get_memory(&mut caller) {
                                let _ = mem.write(&mut caller, out_ptr as usize, &bytes[..written as usize]);
                            }
                            (written << 32) | 2
                        }
                    }
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        // host_call_module(target_ptr, target_len, params_ptr, params_len, out_ptr, out_len) -> u64
        // packed: (bytes_written << 32) | status (0=ok, 1=not_found/none, 2=error)
        // Executes another module and returns its serialized result.
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_call_module",
                |mut caller: wasmtime::Caller<'_, StoreState>,
                 target_ptr: u32,
                 target_len: u32,
                 params_ptr: u32,
                 params_len: u32,
                 out_ptr: u32,
                 out_len: u32|
                 -> u64 {
                    let target_module_id = read_wasm_str(&mut caller, target_ptr, target_len);
                    let params_json = read_wasm_str(&mut caller, params_ptr, params_len);
                    let result = caller
                        .data()
                        .host
                        .call_module(&target_module_id, &params_json);
                    write_host_result(&mut caller, out_ptr, out_len, result)
                },
            )
            .map_err(|e| ExecutionError::RuntimeError(e.to_string()))?;

        Ok(())
    }
}

// --- Store ---

struct StoreState {
    host: Arc<dyn WasmHost>,
    logs: Vec<String>,
    module_id: String,
    limits: StoreLimits,
}

// --- Helpers ---

fn get_memory(caller: &mut wasmtime::Caller<'_, StoreState>) -> Option<Memory> {
    caller.get_export("memory").and_then(|e| e.into_memory())
}

fn read_wasm_str(
    caller: &mut wasmtime::Caller<'_, StoreState>,
    ptr: u32,
    len: u32,
) -> String {
    if len == 0 {
        return String::new();
    }
    if len as usize > MAX_HOST_STRING_LEN {
        return String::new();
    }
    if let Some(mem) = get_memory(caller) {
        let mut buf = vec![0u8; len as usize];
        if mem.read(caller, ptr as usize, &mut buf).is_ok() {
            return String::from_utf8_lossy(&buf).to_string();
        }
    }
    String::new()
}

fn write_host_result(
    caller: &mut wasmtime::Caller<'_, StoreState>,
    out_ptr: u32,
    out_len: u32,
    result: Result<Option<String>, ExecutionError>,
) -> u64 {
    let (status, text) = match result {
        Ok(Some(json)) => (0u64, json),
        Ok(None) => return 1,
        Err(e) => (2u64, format!(r#"{{"error":"{}"}}"#, e)),
    };

    if let Some(mem) = get_memory(caller) {
        let bytes = text.as_bytes();
        let written = bytes.len().min(out_len as usize);
        let _ = mem.write(caller, out_ptr as usize, &bytes[..written]);
        ((written as u64) << 32) | status
    } else {
        2
    }
}

fn write_host_string_result(
    caller: &mut wasmtime::Caller<'_, StoreState>,
    out_ptr: u32,
    out_len: u32,
    result: Result<String, ExecutionError>,
) -> u64 {
    match result {
        Ok(text) => {
            if let Some(mem) = get_memory(caller) {
                let bytes = text.as_bytes();
                let written = bytes.len().min(out_len as usize);
                let _ = mem.write(caller, out_ptr as usize, &bytes[..written]);
                ((written as u64) << 32) | 0
            } else {
                2
            }
        }
        Err(e) => {
            let msg = format!(r#"{{"error":"{}"}}"#, e);
            if let Some(mem) = get_memory(caller) {
                let bytes = msg.as_bytes();
                let written = bytes.len().min(out_len as usize);
                let _ = mem.write(caller, out_ptr as usize, &bytes[..written]);
                ((written as u64) << 32) | 2
            } else {
                2
            }
        }
    }
}
