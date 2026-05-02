#[cfg(feature = "desktop-runtime")]
mod backup_bridge;

#[cfg(feature = "desktop-runtime")]
use backup_bridge::{
    backup_add_slot, backup_diagnostics, backup_export_credentials, backup_init, backup_restore,
    backup_verify, discover_removable_drives, flush_vault_writes, safe_eject_media,
};

#[cfg(feature = "desktop-runtime")]
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            discover_removable_drives,
            flush_vault_writes,
            safe_eject_media,
            backup_init,
            backup_add_slot,
            backup_export_credentials,
            backup_verify,
            backup_restore,
            backup_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running vaultier desktop shell");
}

#[cfg(not(feature = "desktop-runtime"))]
fn main() {
    println!(
        "citizen-wallet-desktop compiled without desktop-runtime feature; enable with `--features desktop-runtime` for Tauri runtime builds."
    );
}
