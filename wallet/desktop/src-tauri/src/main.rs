use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct BackupCommandRequest {
    command: String,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct BackupCommandResponse {
    contract_version: &'static str,
    status: &'static str,
    error_id: Option<&'static str>,
    details: serde_json::Value,
}

#[tauri::command]
fn run_backup_command(request: BackupCommandRequest) -> BackupCommandResponse {
    BackupCommandResponse {
        contract_version: "citizen.wallet.backup.desktop.v1alpha1",
        status: "error",
        error_id: Some("not_implemented"),
        details: serde_json::json!({
            "message": "Desktop wallet-core bridge is scaffolded but not wired yet.",
            "command": request.command,
            "payload_shape": request.payload,
        }),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_backup_command])
        .run(tauri::generate_context!())
        .expect("error while running vaultier desktop shell");
}

fn main() {
    run();
}
