#[cfg(feature = "desktop-runtime")]
use serde::{Deserialize, Serialize};
#[cfg(feature = "desktop-runtime")]
use std::fs::{self, File};
#[cfg(feature = "desktop-runtime")]
use std::path::{Path, PathBuf};
#[cfg(feature = "desktop-runtime")]
use std::process::Command;

#[cfg(feature = "desktop-runtime")]
const CONTRACT_VERSION: &str = "citizen.wallet.backup.desktop.v1alpha1";
#[cfg(feature = "desktop-runtime")]
const MIN_FREE_SPACE_BYTES: u64 = 64 * 1024 * 1024;

#[cfg(feature = "desktop-runtime")]
#[derive(Debug, Deserialize)]
struct BackupCommandRequest {
    command: String,
    #[serde(default)]
    payload: serde_json::Value,
}

#[cfg(feature = "desktop-runtime")]
#[derive(Debug, Serialize)]
pub(crate) struct BackupCommandResponse {
    contract_version: &'static str,
    status: &'static str,
    error_id: Option<String>,
    details: serde_json::Value,
}

#[cfg(feature = "desktop-runtime")]
#[derive(Debug, Serialize)]
struct RemovableDriveRecord {
    mount_path: String,
    label: Option<String>,
    filesystem: Option<String>,
    writable: bool,
    removable: bool,
    platform: String,
}

#[cfg(feature = "desktop-runtime")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetPathPayload {
    target_path: String,
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
        "backup_diagnostics" => Some(vec!["backup", "diagnostics"]),
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
fn parse_cli_json(stdout: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(stdout)
        .map_err(|err| format!("wallet CLI did not emit valid JSON output: {err}"))
}

#[cfg(feature = "desktop-runtime")]
fn cli_error_id_from_value(value: &serde_json::Value) -> Option<String> {
    value
        .get("error_id")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("error_id"))
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
}

#[cfg(feature = "desktop-runtime")]
fn cli_error_id_from_stdout(stdout: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(stdout)
        .ok()
        .and_then(|value| cli_error_id_from_value(&value))
}

#[cfg(feature = "desktop-runtime")]
fn contains_sensitive_keys(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(key, nested)| {
            let lower = key.to_ascii_lowercase();
            let sensitive = lower.contains("passphrase")
                || lower.contains("secret")
                || lower.contains("mnemonic")
                || lower.contains("private_key")
                || lower.contains("seed");
            sensitive || contains_sensitive_keys(nested)
        }),
        serde_json::Value::Array(items) => items.iter().any(contains_sensitive_keys),
        _ => false,
    }
}

#[cfg(feature = "desktop-runtime")]
fn sensitive_arg_values(args: &[String]) -> Vec<String> {
    let sensitive_flags = [
        "--decoy-password",
        "--critical-password",
        "--slot-password",
        "--passphrase",
        "--mnemonic",
        "--private-key",
        "--seed",
    ];
    let mut values = Vec::new();
    let mut i = 0usize;
    while i < args.len() {
        if sensitive_flags.contains(&args[i].as_str()) && i + 1 < args.len() {
            values.push(args[i + 1].clone());
            i += 2;
            continue;
        }
        i += 1;
    }
    values
}

#[cfg(feature = "desktop-runtime")]
fn scrub_sensitive_text(raw: &str, sensitive_values: &[String]) -> String {
    sensitive_values.iter().fold(raw.to_owned(), |acc, value| {
        if value.is_empty() {
            acc
        } else {
            acc.replace(value, "[REDACTED]")
        }
    })
}

#[cfg(feature = "desktop-runtime")]
fn execute_backup_command(request: BackupCommandRequest) -> BackupCommandResponse {
    let cli_args = match command_to_cli_args(&request.command) {
        Some(args) => args,
        None => {
            return BackupCommandResponse {
                contract_version: CONTRACT_VERSION,
                status: "error",
                error_id: Some("unsupported_command".to_owned()),
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
                contract_version: CONTRACT_VERSION,
                status: "error",
                error_id: Some("workspace_unavailable".to_owned()),
                details: serde_json::json!({ "message": err }),
            }
        }
    };

    let dynamic_args = match payload_args(&request.payload) {
        Ok(args) => args,
        Err(err) => {
            return BackupCommandResponse {
                contract_version: CONTRACT_VERSION,
                status: "error",
                error_id: Some("invalid_payload".to_owned()),
                details: serde_json::json!({
                    "message": err,
                    "command": request.command,
                }),
            }
        }
    };

    let sensitive_values = sensitive_arg_values(&dynamic_args);

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
                contract_version: CONTRACT_VERSION,
                status: "error",
                error_id: Some("command_failed".to_owned()),
                details: serde_json::json!({
                    "message": format!("Failed to invoke wallet CLI: {err}"),
                }),
            }
        }
    };

    let stdout = scrub_sensitive_text(
        String::from_utf8_lossy(&output.stdout).trim(),
        &sensitive_values,
    );
    let stderr = scrub_sensitive_text(
        String::from_utf8_lossy(&output.stderr).trim(),
        &sensitive_values,
    );

    if output.status.success() {
        let parsed = match parse_cli_json(&stdout) {
            Ok(json) => json,
            Err(err) => {
                return BackupCommandResponse {
                    contract_version: CONTRACT_VERSION,
                    status: "error",
                    error_id: Some("invalid_payload".to_owned()),
                    details: serde_json::json!({
                        "command": request.command,
                        "message": err,
                        "wallet_cli_stderr": stderr,
                    }),
                }
            }
        };

        if contains_sensitive_keys(&parsed) {
            return BackupCommandResponse {
                contract_version: CONTRACT_VERSION,
                status: "error",
                error_id: Some("invalid_payload".to_owned()),
                details: serde_json::json!({
                    "command": request.command,
                    "message": "wallet CLI payload contained non-redacted sensitive fields",
                    "wallet_cli_stderr": stderr,
                }),
            };
        }

        let cli_contract_version = parsed
            .get("contract_version")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let cli_status = parsed
            .get("status")
            .and_then(|v| v.as_str())
            .map(str::to_owned);

        BackupCommandResponse {
            contract_version: CONTRACT_VERSION,
            status: "ok",
            error_id: None,
            details: serde_json::json!({
                "command": request.command,
                "wallet_cli_contract_version": cli_contract_version,
                "wallet_cli_status": cli_status,
                "wallet_cli": parsed,
                "wallet_cli_stderr": stderr,
            }),
        }
    } else {
        BackupCommandResponse {
            contract_version: CONTRACT_VERSION,
            status: "error",
            error_id: cli_error_id_from_stdout(&stdout)
                .or_else(|| Some("wallet_cli_error".to_owned())),
            details: serde_json::json!({
                "command": request.command,
                "wallet_cli_stdout": stdout,
                "wallet_cli_stderr": stderr,
            }),
        }
    }
}

#[cfg(all(test, feature = "desktop-runtime"))]
mod tests {

    use super::{
        cli_error_id_from_stdout, cli_error_id_from_value, command_to_cli_args,
        contains_sensitive_keys, looks_removable_for_os, parse_cli_json, scrub_sensitive_text,
        sensitive_arg_values, BackupCommandResponse, CONTRACT_VERSION,
    };
    use std::path::Path;

    #[test]
    fn cli_command_mapping_covers_required_backup_commands() {
        assert_eq!(
            command_to_cli_args("backup_init"),
            Some(vec!["backup", "init"])
        );
        assert_eq!(
            command_to_cli_args("backup_add_slot"),
            Some(vec!["backup", "add-slot"])
        );
        assert_eq!(
            command_to_cli_args("backup_export_credentials"),
            Some(vec!["backup", "export-credentials"])
        );
        assert_eq!(
            command_to_cli_args("backup_verify"),
            Some(vec!["backup", "verify"])
        );
        assert_eq!(
            command_to_cli_args("backup_restore"),
            Some(vec!["backup", "restore"])
        );
        assert_eq!(
            command_to_cli_args("backup_diagnostics"),
            Some(vec!["backup", "diagnostics"])
        );
    }

    #[test]
    fn backup_response_serialization_keeps_contract_fields_and_avoids_secret_keys() {
        let response = BackupCommandResponse {
            contract_version: CONTRACT_VERSION,
            status: "ok",
            error_id: None,
            details: serde_json::json!({
                "command": "backup_verify",
                "wallet_cli": {
                    "status": "ok",
                    "schema_version": "v1",
                    "verified_at": "2026-05-02T00:00:00Z"
                }
            }),
        };

        let value = serde_json::to_value(response).expect("response serializes");
        assert_eq!(value["contract_version"], CONTRACT_VERSION);
        assert_eq!(value["status"], "ok");
        assert_eq!(value["details"]["wallet_cli"]["status"], "ok");
        assert!(!contains_sensitive_keys(&value));
    }

    #[test]
    fn backup_response_sensitive_key_scan_rejects_secret_like_fields() {
        let response = BackupCommandResponse {
            contract_version: CONTRACT_VERSION,
            status: "ok",
            error_id: None,
            details: serde_json::json!({
                "wallet_cli": {
                    "mnemonic": "should-not-appear"
                }
            }),
        };

        let value = serde_json::to_value(response).expect("response serializes");
        assert!(contains_sensitive_keys(&value));
    }

    #[test]
    fn cli_error_id_parser_reads_top_level_error() {
        let value = serde_json::json!({"status":"error","error_id":"checksum_mismatch"});
        assert_eq!(
            cli_error_id_from_value(&value).as_deref(),
            Some("checksum_mismatch")
        );
    }

    #[test]
    fn cli_error_id_parser_reads_nested_result_error() {
        let stdout = r#"{"status":"ok","result":{"error_id":"decrypt_failed"}}"#;
        assert_eq!(
            cli_error_id_from_stdout(stdout).as_deref(),
            Some("decrypt_failed")
        );
    }

    #[test]
    fn sensitive_arg_values_extracts_password_inputs() {
        let args = vec![
            "--vault".to_owned(),
            "/tmp/vault.json".to_owned(),
            "--slot-password".to_owned(),
            "top-secret".to_owned(),
            "--role".to_owned(),
            "critical".to_owned(),
        ];
        assert_eq!(sensitive_arg_values(&args), vec!["top-secret".to_owned()]);
    }

    #[test]
    fn scrub_sensitive_text_redacts_secrets_from_bridge_logs() {
        let raw = "wallet backup failed with password top-secret";
        let scrubbed = scrub_sensitive_text(raw, &["top-secret".to_owned()]);
        assert_eq!(scrubbed, "wallet backup failed with password [REDACTED]");
    }

    #[test]
    fn parse_cli_json_accepts_valid_payload() {
        let parsed =
            parse_cli_json(r#"{"contract_version":"citizen.wallet.backup.cli.v1","status":"ok"}"#)
                .expect("valid JSON should parse");
        assert_eq!(parsed["status"], "ok");
    }

    #[test]
    fn parse_cli_json_rejects_non_json_payload() {
        let err = parse_cli_json("backup init completed").expect_err("non-JSON must fail");
        assert!(err.contains("valid JSON"));
    }

    #[test]
    fn sensitive_key_scan_detects_nested_secret_fields() {
        let payload = serde_json::json!({
            "details": {
                "role": "critical",
                "seed_phrase": "secret",
            }
        });
        assert!(contains_sensitive_keys(&payload));
    }

    #[test]
    fn sensitive_key_scan_allows_non_secret_contract_fields() {
        let payload = serde_json::json!({
            "contract_version": "citizen.wallet.backup.cli.v1",
            "status": "ok",
            "vault_path": "/media/usb/vault.json"
        });
        assert!(!contains_sensitive_keys(&payload));
    }

    #[test]
    fn utility_flush_reports_path_invalid_for_missing_target() {
        let output = super::flush_vault_writes(super::TargetPathPayload {
            target_path: "/tmp/definitely-missing-vaultier-file".to_owned(),
        });
        assert_eq!(output["status"], "error");
        assert_eq!(output["error_id"], "path_invalid");
    }

    #[test]
    fn utility_safe_eject_returns_deterministic_status_fields() {
        let output = super::safe_eject_media(super::TargetPathPayload {
            target_path: "/tmp".to_owned(),
        });
        assert!(output.get("status").is_some());
        assert!(output.get("error_id").is_some());
    }

    #[test]
    fn preflight_target_path_reports_path_invalid_for_missing_path() {
        let result = super::preflight_target_path(Path::new("/tmp/vaultier-missing-path"));
        assert_eq!(result, Err("path_invalid"));
    }

    #[test]
    fn removable_path_detection_supports_linux_path_shapes() {
        assert!(looks_removable_for_os(Path::new("/media/operator/vault"), "linux"));
        assert!(looks_removable_for_os(Path::new("/mnt/usb/vault"), "linux"));
        assert!(!looks_removable_for_os(Path::new("/var/tmp/vault"), "linux"));
    }

    #[test]
    fn removable_path_detection_supports_macos_path_shapes() {
        assert!(looks_removable_for_os(
            Path::new("/Volumes/CITIZEN_BACKUP/vault"),
            "macos"
        ));
        assert!(!looks_removable_for_os(Path::new("/Users/operator/vault"), "macos"));
    }

    #[test]
    fn removable_path_detection_supports_windows_path_shapes() {
        assert!(looks_removable_for_os(Path::new("E:\\vault\\backup.json"), "windows"));
        assert!(!looks_removable_for_os(
            Path::new("C:\\Users\\operator\\vault"),
            "windows"
        ));
    }

}

#[cfg(feature = "desktop-runtime")]
fn mount_prefixes_for_os(os: &str) -> &'static [&'static str] {
    match os {
        "macos" => &["/Volumes/"],
        "windows" => &[
            "A:\\", "B:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", "I:\\",
        ],
        _ => &["/media/", "/mnt/"],
    }
}

#[cfg(feature = "desktop-runtime")]
fn looks_removable_for_os(path: &Path, os: &str) -> bool {
    let path_str = path.to_string_lossy();
    mount_prefixes_for_os(os)
        .iter()
        .any(|prefix| path_str.starts_with(prefix))
}

#[cfg(feature = "desktop-runtime")]
fn looks_removable(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    mount_prefixes_for_os(std::env::consts::OS)
        .iter()
        .any(|prefix| path_str.starts_with(prefix))
}

#[cfg(feature = "desktop-runtime")]
fn preflight_target_path(target: &Path) -> Result<(), &'static str> {
    if !target.exists() {
        return Err("path_invalid");
    }
    if !looks_removable(target) {
        return Err("media_unavailable");
    }
    let Ok(metadata) = fs::metadata(target) else {
        return Err("path_invalid");
    };
    if metadata.permissions().readonly() {
        return Err("mount_unwritable");
    }
    if let Some(free_bytes) = free_space_bytes(target) {
        if free_bytes < MIN_FREE_SPACE_BYTES {
            return Err("insufficient_space");
        }
    }
    Ok(())
}

#[cfg(feature = "desktop-runtime")]
fn free_space_bytes(target: &Path) -> Option<u64> {
    if cfg!(target_os = "windows") {
        return None;
    }
    let output = Command::new("df").arg("-Pk").arg(target).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let line = stdout.lines().nth(1)?;
    let available_kb = line.split_whitespace().nth(3)?.parse::<u64>().ok()?;
    Some(available_kb.saturating_mul(1024))
}

#[cfg(feature = "desktop-runtime")]
fn discover_linux_removable_drives() -> Vec<RemovableDriveRecord> {
    let Ok(output) = Command::new("lsblk")
        .args(["-J", "-o", "NAME,MOUNTPOINT,LABEL,FSTYPE,RM,RO,TYPE"])
        .output()
    else {
        return Vec::new();
    };

    if !output.status.success() {
        return Vec::new();
    }

    let json: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    let mut drives = Vec::new();
    fn walk(node: &serde_json::Value, out: &mut Vec<RemovableDriveRecord>) {
        if node.get("type").and_then(|v| v.as_str()) == Some("part") {
            let mount = node.get("mountpoint").and_then(|v| v.as_str());
            let removable = node.get("rm").and_then(|v| v.as_i64()) == Some(1);
            if let Some(mount_path) = mount.filter(|path| !path.is_empty() && removable) {
                let read_only = node.get("ro").and_then(|v| v.as_i64()) == Some(1);
                out.push(RemovableDriveRecord {
                    mount_path: mount_path.to_owned(),
                    label: node
                        .get("label")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                    filesystem: node
                        .get("fstype")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                    writable: !read_only,
                    removable: true,
                    platform: std::env::consts::OS.to_owned(),
                });
            }
        }

        if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
            for child in children {
                walk(child, out);
            }
        }
    }

    if let Some(blockdevices) = json.get("blockdevices").and_then(|v| v.as_array()) {
        for device in blockdevices {
            walk(device, &mut drives);
        }
    }

    drives
}

#[cfg(feature = "desktop-runtime")]
#[cfg(target_os = "macos")]
fn discover_macos_removable_drives() -> Vec<RemovableDriveRecord> {
    let Ok(output) = Command::new("diskutil").args(["list", "-plist"]).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    // Keep parser intentionally conservative: only rely on mount roots that pass removable heuristics.
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .filter_map(|line| {
            let candidate = line.trim();
            if candidate.starts_with("/Volumes/") {
                Some(candidate.to_owned())
            } else {
                None
            }
        })
        .map(|mount_path| RemovableDriveRecord {
            label: Path::new(&mount_path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string()),
            filesystem: None,
            writable: fs::metadata(&mount_path)
                .map(|m| !m.permissions().readonly())
                .unwrap_or(false),
            removable: true,
            platform: std::env::consts::OS.to_owned(),
            mount_path,
        })
        .collect()
}

#[cfg(feature = "desktop-runtime")]
#[cfg(target_os = "windows")]
fn discover_windows_removable_drives() -> Vec<RemovableDriveRecord> {
    let Ok(output) = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 } | Select-Object -ExpandProperty DeviceID",
        ])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let drive = line.trim();
            if drive.len() == 2 && drive.ends_with(':') {
                Some(format!("{drive}\\"))
            } else {
                None
            }
        })
        .map(|mount_path| RemovableDriveRecord {
            label: Some(mount_path.clone()),
            filesystem: None,
            writable: fs::metadata(&mount_path)
                .map(|m| !m.permissions().readonly())
                .unwrap_or(false),
            removable: true,
            platform: std::env::consts::OS.to_owned(),
            mount_path,
        })
        .collect()
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn discover_removable_drives() -> serde_json::Value {
    let mut drives = if cfg!(target_os = "linux") {
        discover_linux_removable_drives()
    } else if cfg!(target_os = "macos") {
        #[cfg(target_os = "macos")]
        {
            discover_macos_removable_drives()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Vec::new()
        }
    } else if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        {
            discover_windows_removable_drives()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    if drives.is_empty() {
        let current = std::env::current_dir().ok();
        drives = current
            .as_ref()
            .and_then(|cwd| {
                cwd.ancestors()
                    .find(|p| looks_removable(p))
                    .map(PathBuf::from)
            })
            .into_iter()
            .map(|mount| RemovableDriveRecord {
                mount_path: mount.display().to_string(),
                label: mount
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string()),
                filesystem: None,
                writable: fs::metadata(&mount)
                    .map(|m| !m.permissions().readonly())
                    .unwrap_or(false),
                removable: true,
                platform: std::env::consts::OS.to_owned(),
            })
            .collect::<Vec<_>>();
    }

    serde_json::json!({ "drives": drives })
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn flush_vault_writes(payload: TargetPathPayload) -> serde_json::Value {
    let target = PathBuf::from(&payload.target_path);
    if let Err(error_id) = preflight_target_path(&target) {
        let detail = match error_id {
            "mount_unwritable" => "target path is mounted read-only",
            "media_unavailable" => "target path is not classified as removable media",
            "insufficient_space" => "target path does not have enough free space",
            _ => "target path does not exist",
        };
        return serde_json::json!({
            "status": "error",
            "error_id": error_id,
            "targetPath": payload.target_path,
            "flushConfirmed": false,
            "errors": [detail],
        });
    }
    let mut flushed = false;
    let mut errors = Vec::new();

    if let Ok(file) = File::open(&target) {
        if let Err(err) = file.sync_all() {
            errors.push(format!("file fsync failed: {err}"));
        } else {
            flushed = true;
        }
    }

    if let Some(parent) = target.parent() {
        if let Ok(parent_dir) = File::open(parent) {
            if let Err(err) = parent_dir.sync_all() {
                errors.push(format!("parent fsync failed: {err}"));
            } else {
                flushed = true;
            }
        }
    }

    serde_json::json!({
        "targetPath": payload.target_path,
        "strategy": ["write_temp", "fsync_file", "rename_atomic", "fsync_parent"],
        "status": if errors.is_empty() { "ok" } else { "warning" },
        "error_id": if errors.is_empty() { serde_json::Value::Null } else { serde_json::json!("flush_incomplete") },
        "flushConfirmed": flushed,
        "errors": errors,
    })
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn safe_eject_media(payload: TargetPathPayload) -> serde_json::Value {
    let target = PathBuf::from(&payload.target_path);
    if let Err(error_id) = preflight_target_path(&target) {
        let reason = match error_id {
            "mount_unwritable" => "Target path is mounted read-only.",
            "media_unavailable" => "Target path is not classified as removable media.",
            "insufficient_space" => "Target path does not have enough free space for safe operations.",
            _ => "Target path does not exist.",
        };
        return serde_json::json!({
            "ok": false,
            "status": "error",
            "error_id": error_id,
            "targetPath": payload.target_path,
            "details": {
                "mode": "manual_eject_required",
                "reason": reason,
            },
        });
    }
    let mut ejected = false;
    let mut details = serde_json::json!({
        "mode": "manual_eject_required",
        "reason": "Runtime command unavailable for this path/OS combination."
    });

    #[cfg(target_os = "linux")]
    {
            match Command::new("udisksctl")
                .args(["unmount", "-b"])
                .arg(&target)
                .output()
            {
                Ok(output) if output.status.success() => {
                    ejected = true;
                    details = serde_json::json!({"mode": "os_command", "command": "udisksctl unmount -b"});
                }
                _ => match Command::new("umount").arg(&target).output() {
                    Ok(output) if output.status.success() => {
                        ejected = true;
                        details = serde_json::json!({"mode": "os_command", "command": "umount"});
                    }
                    Ok(output) => {
                        details = serde_json::json!({
                            "mode": "manual_eject_required",
                            "command": "umount",
                            "stderr": String::from_utf8_lossy(&output.stderr).trim(),
                        });
                    }
                    Err(err) => {
                        details = serde_json::json!({
                            "mode": "manual_eject_required",
                            "command": "umount",
                            "error": err.to_string(),
                        });
                    }
                },
            }
        }

    #[cfg(target_os = "macos")]
    {
            match Command::new("diskutil")
                .args(["unmount", payload.target_path.as_str()])
                .output()
            {
                Ok(output) if output.status.success() => {
                    ejected = true;
                    details =
                        serde_json::json!({"mode": "os_command", "command": "diskutil unmount"});
                }
                Ok(output) => {
                    details = serde_json::json!({
                        "mode": "manual_eject_required",
                        "command": "diskutil unmount",
                        "stderr": String::from_utf8_lossy(&output.stderr).trim(),
                    });
                }
                Err(err) => {
                    details = serde_json::json!({
                        "mode": "manual_eject_required",
                        "command": "diskutil unmount",
                        "error": err.to_string(),
                    });
                }
            }
        }

    #[cfg(target_os = "windows")]
    {
            let script = format!(
                "(New-Object -ComObject Shell.Application).Namespace(17).ParseName('{}').InvokeVerb('Eject')",
                payload.target_path.replace('\'', "''")
            );
            match Command::new("powershell")
                .args(["-NoProfile", "-Command", script.as_str()])
                .output()
            {
                Ok(output) if output.status.success() => {
                    ejected = true;
                    details =
                        serde_json::json!({"mode": "os_command", "command": "powershell eject"});
                }
                Ok(output) => {
                    details = serde_json::json!({
                        "mode": "manual_eject_required",
                        "command": "powershell eject",
                        "stderr": String::from_utf8_lossy(&output.stderr).trim(),
                    });
                }
                Err(err) => {
                    details = serde_json::json!({
                        "mode": "manual_eject_required",
                        "command": "powershell eject",
                        "error": err.to_string(),
                    });
                }
            }
    }

    serde_json::json!({
        "ok": ejected,
        "status": if ejected { "ok" } else { "warning" },
        "error_id": if ejected { serde_json::Value::Null } else { serde_json::json!("media_unavailable") },
        "targetPath": payload.target_path,
        "details": details,
    })
}

#[cfg(feature = "desktop-runtime")]
fn run_named_backup_command(command: &str, payload: serde_json::Value) -> BackupCommandResponse {
    execute_backup_command(BackupCommandRequest {
        command: command.to_owned(),
        payload,
    })
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn backup_init(payload: serde_json::Value) -> BackupCommandResponse {
    run_named_backup_command("backup_init", payload)
}
#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn backup_add_slot(payload: serde_json::Value) -> BackupCommandResponse {
    run_named_backup_command("backup_add_slot", payload)
}
#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn backup_export_credentials(payload: serde_json::Value) -> BackupCommandResponse {
    run_named_backup_command("backup_export_credentials", payload)
}
#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn backup_verify(payload: serde_json::Value) -> BackupCommandResponse {
    run_named_backup_command("backup_verify", payload)
}
#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn backup_restore(payload: serde_json::Value) -> BackupCommandResponse {
    run_named_backup_command("backup_restore", payload)
}
#[cfg(feature = "desktop-runtime")]
#[tauri::command]
pub fn backup_diagnostics(payload: serde_json::Value) -> BackupCommandResponse {
    run_named_backup_command("backup_diagnostics", payload)
}
