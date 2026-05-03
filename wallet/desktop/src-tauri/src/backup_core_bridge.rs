#[cfg(feature = "desktop-runtime")]
use serde::{Deserialize, Serialize};

#[cfg(feature = "desktop-runtime")]
#[derive(Debug, Deserialize)]
pub(crate) struct BackupCommandRequest {
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) payload: serde_json::Value,
}

#[cfg(feature = "desktop-runtime")]
#[derive(Debug, Serialize)]
pub(crate) struct BackupCommandResponse {
    pub(crate) contract_version: &'static str,
    pub(crate) status: &'static str,
    pub(crate) error_id: Option<String>,
    pub(crate) details: serde_json::Value,
}

#[cfg(feature = "desktop-runtime")]
pub(crate) trait BackupCommandExecutor {
    fn execute(&self, request: &BackupCommandRequest) -> BackupCommandResponse;
}
