pub mod manifest;
pub mod runtime_identity;
pub mod startup;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdmissionSettings {
    pub network_id: String,
    pub manifest_path: Option<PathBuf>,
    pub manifest_enforce: bool,
    pub startup_secret: Option<String>,
    pub expected_genesis_hash: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AdmissionContext {
    pub network_id: String,
    pub genesis_hash: String,
    pub manifest_digest: String,
    pub manifest_version: Option<u64>,
}

#[derive(thiserror::Error, Debug)]
pub enum AdmissionError {
    #[error("manifest file is required when manifest_enforce=true")]
    ManifestRequired,
    #[error("failed to read manifest at {path}: {source}")]
    ManifestRead {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse manifest json: {0}")]
    ManifestParse(serde_json::Error),
    #[error("failed to canonicalize manifest payload: {0}")]
    ManifestCanonicalization(serde_json::Error),
    #[error("invalid manifest signature: {0}")]
    InvalidManifestSignature(String),
    #[error("manifest key is not trusted: {0}")]
    UntrustedManifestKey(String),
    #[error("unsupported manifest signature algorithm: {0}")]
    UnsupportedManifestAlgorithm(String),
    #[error("manifest network mismatch: manifest={manifest}, configured={configured}")]
    ManifestNetworkMismatch {
        manifest: String,
        configured: String,
    },
    #[error("manifest genesis mismatch: manifest={manifest}, expected={expected}")]
    ManifestGenesisMismatch { manifest: String, expected: String },
    #[error("runtime network mismatch: runtime={runtime}, configured={configured}")]
    RuntimeNetworkMismatch { runtime: String, configured: String },
    #[error("psk verification failed: {0}")]
    PskVerificationFailed(String),
    #[error("local genesis mismatch: local={local}, expected={expected}")]
    LocalGenesisMismatch { local: String, expected: String },
    #[error("storage error while computing local genesis hash: {0}")]
    Storage(citizen_types::ProtocolError),
}
