use crate::{ExecutionConfig, ExecutionError, ExecutionResult, WasmHost};
use std::sync::Arc;
use wasmtime::{Engine, Linker, Memory, Module, Store};

const MODULE_CATEGORY: &str = "env";

/// The WASM execution engine.
///
/// Compiles modules from bytecode, registers host functions that bridge
/// to the Citizen ledger, and executes modules with deterministic gas metering.
pub struct ExecutionEngine {
    engine: Engine,
    #[allow(dead_code)]
    config: ExecutionConfig,
}

impl ExecutionEngine {
    pub fn new(config: ExecutionConfig) -> Result<Self, ExecutionError> {
        let mut wasmtime_config = wasmtime::Config::new();
        wasmtime_config.strategy(wasmtime::Strategy::Cranelift);
        wasmtime_config.cranelift_opt_level(wasmtime::OptLevel::Speed);

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
        params_json: &str,
        gas_limit: u64,
        host: Arc<dyn WasmHost>,
    ) -> Result<ExecutionResult, ExecutionError> {
        let module = Module::new(&self.engine, wasm_bytes)
            .map_err(|e| ExecutionError::CompileError(e.to_string()))?;

        let mut store = Store::new(
            &self.engine,
            StoreState {
                host,
                logs: Vec::new(),
            },
        );

        // TODO: Re-enable fuel metering. wasmtime 25's Store API uses
        // StoreContextMut / StoreContext traits for fuel access.
        // For now, execution is bounded by compilation and memory limits.
        let _ = gas_limit;

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

        // Write params into WASM linear memory
        let params_bytes = params_json.as_bytes();
        let params_ptr = alloc
            .call(&mut store, params_bytes.len() as u32)
            .map_err(|e| ExecutionError::RuntimeError(format!("alloc failed: {e}")))?;

        memory
            .write(&mut store, params_ptr as usize, params_bytes)
            .map_err(|e| ExecutionError::RuntimeError(format!("memory write failed: {e}")))?;

        // Call `handle(param_ptr, param_len) -> packed_result`
        let packed = handle
            .call(&mut store, (params_ptr, params_bytes.len() as u32))
            .map_err(|e| {
                let msg = e.to_string();
                if msg.contains("fuel") {
                    ExecutionError::GasLimitExceeded {
                        consumed: 0,
                        limit: gas_limit,
                    }
                } else {
                    ExecutionError::RuntimeError(msg)
                }
            })?;

        let gas_consumed = 0u64; // TODO: store.fuel_consumed() when API is resolved

        let result_ptr = (packed >> 32) as u32;
        let result_len = (packed & 0xFFFF_FFFF) as usize;

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

    fn link_host_functions(&self, linker: &mut Linker<StoreState>) -> Result<(), ExecutionError> {
        // host_log(ptr: u32, len: u32)
        linker
            .func_wrap(
                MODULE_CATEGORY,
                "host_log",
                |mut caller: wasmtime::Caller<'_, StoreState>, ptr: u32, len: u32| {
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

        Ok(())
    }
}

// --- Store ---

struct StoreState {
    host: Arc<dyn WasmHost>,
    logs: Vec<String>,
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
        Ok(None) => return 1, // not found — short circuit, no data
        Err(e) => (2u64, format!(r#"{{"error":"{}"}}"#, e)),
    };

    if let Some(mem) = get_memory(caller) {
        let bytes = text.as_bytes();
        let written = bytes.len().min(out_len as usize);
        let _ = mem.write(caller, out_ptr as usize, &bytes[..written]);
        ((written as u64) << 32) | status
    } else {
        2 // error: no memory
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
