#[cfg(feature = "desktop-runtime")]
use serde::{Deserialize, Serialize};
#[cfg(feature = "desktop-runtime")]
use std::path::PathBuf;
#[cfg(feature = "desktop-runtime")]
use std::process::Command;

#[cfg(feature = "desktop-runtime")]
#[derive(Debug, Deserialize)]
struct BackupCommandRequest {
    command: String,
    payload: serde_json::Value,
}

#[cfg(feature = "desktop-runtime")]
#[derive(Debug, Serialize)]
struct BackupCommandResponse {
    contract_version: &'static str,
    status: &'static str,
    error_id: Option<&'static str>,
    details: serde_json::Value,
}

#[cfg(feature = "desktop-runtime")]
fn workspace_root() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|err| format!("failed to resolve cwd: {err}"))?;
    cwd.ancestors()
        .find(|path| path.join("citizen-protocol").is_dir())
        .map(|path| path.to_path_buf())
        .ok_or_else(|| "could not locate monorepo workspace root".to_owned())
}

#[cfg(feature = "desktop-runtime")]
fn command_to_cli_args(command: &str) -> Option<Vec<&'static str>> {
    match command {
        "backup_init" => Some(vec!["backup", "init"]),
        "backup_add_slot" => Some(vec!["backup", "add-slot"]),
        "backup_export_credentials" => Some(vec!["backup", "export-credentials"]),
        "backup_verify" => Some(vec!["backup", "verify"]),
        "backup_restore" => Some(vec!["backup", "restore"]),
        _ => None,
    }
}

#[cfg(feature = "desktop-runtime")]
fn payload_args(payload: &serde_json::Value) -> Result<Vec<String>, String> {
    let Some(args_value) = payload.get("args") else {
        return Ok(Vec::new());
    };

    let args = args_value
        .as_array()
        .ok_or_else(|| "payload.args must be an array of strings".to_owned())?;

    args.iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "payload.args entries must be strings".to_owned())
        })
        .collect()
}

#[cfg(feature = "desktop-runtime")]
fn execute_backup_command(request: BackupCommandRequest) -> BackupCommandResponse {
    let cli_args = match command_to_cli_args(&request.command) {
        Some(args) => args,
        None => {
            return BackupCommandResponse {
                contract_version: "citizen.wallet.backup.desktop.v1alpha1",
                status: "error",
                error_id: Some("unsupported_command"),
                details: serde_json::json!({
                    "message": "Unsupported desktop backup command.",
                    "command": request.command,
                }),
            }
        }
    };

    let root = match workspace_root() {
        Ok(path) => path,
        Err(err) => {
            return BackupCommandResponse {
                contract_version: "citizen.wallet.backup.desktop.v1alpha1",
                status: "error",
                error_id: Some("workspace_unavailable"),
                details: serde_json::json!({ "message": err }),
            }
        }
    };

    let dynamic_args = match payload_args(&request.payload) {
        Ok(args) => args,
        Err(err) => {
            return BackupCommandResponse {
                contract_version: "citizen.wallet.backup.desktop.v1alpha1",
                status: "error",
                error_id: Some("invalid_payload"),
                details: serde_json::json!({
                    "message": err,
                    "command": request.command,
                }),
            }
        }
    };

    let mut command = Command::new("cargo");
    command
        .arg("run")
        .arg("-p")
        .arg("citizen-wallet")
        .arg("--")
        .arg("wallet")
        .args(cli_args)
        .args(dynamic_args)
        .arg("--json")
        .current_dir(root.join("citizen-protocol"));

    let output = match command.output() {
        Ok(output) => output,
        Err(err) => {
            return BackupCommandResponse {
                contract_version: "citizen.wallet.backup.desktop.v1alpha1",
                status: "error",
                error_id: Some("command_failed"),
                details: serde_json::json!({
                    "message": format!("Failed to invoke wallet CLI: {err}"),
                }),
            }
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();

    if output.status.success() {
        BackupCommandResponse {
            contract_version: "citizen.wallet.backup.desktop.v1alpha1",
            status: "ok",
            error_id: None,
            details: serde_json::json!({
                "command": request.command,
                "wallet_cli_stdout": stdout,
                "wallet_cli_stderr": stderr,
            }),
        }
    } else {
        BackupCommandResponse {
            contract_version: "citizen.wallet.backup.desktop.v1alpha1",
            status: "error",
            error_id: Some("wallet_cli_error"),
            details: serde_json::json!({
                "command": request.command,
                "wallet_cli_stdout": stdout,
                "wallet_cli_stderr": stderr,
            }),
        }
    }
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn run_backup_command(request: BackupCommandRequest) -> BackupCommandResponse {
    execute_backup_command(request)
}

#[cfg(feature = "desktop-runtime")]
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_backup_command])
        .run(tauri::generate_context!())
        .expect("error while running vaultier desktop shell");
}

#[cfg(not(feature = "desktop-runtime"))]
fn main() {
    println!(
        "citizen-wallet-desktop compiled without desktop-runtime feature; enable with `--features desktop-runtime` for Tauri runtime builds."
    );
}
