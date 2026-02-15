use super::manifest::SignedManifest;
use super::runtime_identity::{
    MANIFEST_MAX_AGE_SECS, MANIFEST_MAX_FUTURE_SKEW_SECS, RUNTIME_NETWORK_ID, RUNTIME_PSK_HASH,
};
use super::{AdmissionContext, AdmissionError, AdmissionSettings};
use citizen_crypto::hash_block_header;
use citizen_storage::LedgerStorage;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StartupAdmissionMetricsSnapshot {
    pub startup_fail_total: HashMap<&'static str, u64>,
    pub manifest_verification_duration_ms: Vec<u64>,
    pub manifest_verification_duration_histogram: HashMap<&'static str, u64>,
}

static STARTUP_FAIL_TOTAL: OnceLock<Mutex<HashMap<&'static str, u64>>> = OnceLock::new();
static MANIFEST_VERIFICATION_DURATION_MS: OnceLock<Mutex<Vec<u64>>> = OnceLock::new();
static MANIFEST_VERIFICATION_DURATION_HISTOGRAM: OnceLock<Mutex<HashMap<&'static str, u64>>> =
    OnceLock::new();

pub fn run_preflight<S: LedgerStorage>(
    settings: &AdmissionSettings,
    storage: &S,
) -> Result<AdmissionContext, AdmissionError> {
    let result = run_preflight_inner(settings, storage);
    if let Err(err) = &result {
        increment_startup_failure(reason_code(err));
    }
    result
}

pub fn startup_metrics_snapshot() -> StartupAdmissionMetricsSnapshot {
    let startup_fail_total = STARTUP_FAIL_TOTAL
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("startup failure metrics lock poisoned")
        .clone();
    let manifest_verification_duration_ms = MANIFEST_VERIFICATION_DURATION_MS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("manifest verification metrics lock poisoned")
        .clone();
    let manifest_verification_duration_histogram = MANIFEST_VERIFICATION_DURATION_HISTOGRAM
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("manifest verification histogram metrics lock poisoned")
        .clone();

    StartupAdmissionMetricsSnapshot {
        startup_fail_total,
        manifest_verification_duration_ms,
        manifest_verification_duration_histogram,
    }
}

fn run_preflight_inner<S: LedgerStorage>(
    settings: &AdmissionSettings,
    storage: &S,
) -> Result<AdmissionContext, AdmissionError> {
    if settings.network_id != RUNTIME_NETWORK_ID {
        return Err(AdmissionError::RuntimeNetworkMismatch {
            runtime: RUNTIME_NETWORK_ID.to_string(),
            configured: settings.network_id.clone(),
        });
    }

    if RUNTIME_PSK_HASH.is_some() && settings.startup_secret.is_none() {
        return Err(AdmissionError::PskVerificationFailed(
            "startup_secret is required when runtime PSK mode is enabled".into(),
        ));
    }

    let local_genesis_hash = compute_local_genesis_hash(storage)?;
    let expected_genesis = settings
        .expected_genesis_hash
        .clone()
        .unwrap_or_else(|| local_genesis_hash.clone());

    if let Some(path) = &settings.manifest_path {
        let manifest = SignedManifest::load(path)?;
        if settings.manifest_enforce {
            let verify_started = Instant::now();
            let now_unix_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or_default();
            manifest.verify_signatures_at(now_unix_secs)?;
            manifest.verify_freshness(
                now_unix_secs,
                MANIFEST_MAX_AGE_SECS,
                MANIFEST_MAX_FUTURE_SKEW_SECS,
            )?;
            observe_manifest_verification_duration(verify_started.elapsed().as_millis() as u64);
        }

        if manifest.payload.network_id != settings.network_id {
            return Err(AdmissionError::ManifestNetworkMismatch {
                manifest: manifest.payload.network_id,
                configured: settings.network_id.clone(),
            });
        }

        if manifest.payload.genesis_hash != expected_genesis {
            return Err(AdmissionError::ManifestGenesisMismatch {
                manifest: manifest.payload.genesis_hash,
                expected: expected_genesis.clone(),
            });
        }

        if local_genesis_hash != expected_genesis {
            return Err(AdmissionError::LocalGenesisMismatch {
                local: local_genesis_hash,
                expected: expected_genesis.clone(),
            });
        }

        return Ok(AdmissionContext {
            network_id: settings.network_id.clone(),
            genesis_hash: expected_genesis.clone(),
            manifest_digest: manifest.digest_hex()?,
            manifest_version: Some(manifest.payload.version),
        });
    }

    if settings.manifest_enforce {
        return Err(AdmissionError::ManifestRequired);
    }

    if local_genesis_hash != expected_genesis {
        return Err(AdmissionError::LocalGenesisMismatch {
            local: local_genesis_hash,
            expected: expected_genesis.clone(),
        });
    }

    Ok(AdmissionContext {
        network_id: settings.network_id.clone(),
        genesis_hash: expected_genesis.clone(),
        manifest_digest: String::from("manifest-not-enforced"),
        manifest_version: None,
    })
}

fn increment_startup_failure(reason: &'static str) {
    let mut counters = STARTUP_FAIL_TOTAL
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("startup failure metrics lock poisoned");
    *counters.entry(reason).or_insert(0) += 1;
}

fn observe_manifest_verification_duration(duration_ms: u64) {
    MANIFEST_VERIFICATION_DURATION_MS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("manifest verification metrics lock poisoned")
        .push(duration_ms);

    let mut histogram = MANIFEST_VERIFICATION_DURATION_HISTOGRAM
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("manifest verification histogram metrics lock poisoned");
    let bucket = manifest_duration_bucket_label(duration_ms);
    *histogram.entry(bucket).or_insert(0) += 1;
}

fn manifest_duration_bucket_label(duration_ms: u64) -> &'static str {
    match duration_ms {
        0..=9 => "0_9ms",
        10..=49 => "10_49ms",
        50..=99 => "50_99ms",
        100..=249 => "100_249ms",
        250..=499 => "250_499ms",
        _ => "500ms_plus",
    }
}

fn reason_code(err: &AdmissionError) -> &'static str {
    match err {
        AdmissionError::ManifestRequired => "manifest_required",
        AdmissionError::ManifestRead { .. } => "manifest_read",
        AdmissionError::ManifestParse(_) => "manifest_parse",
        AdmissionError::ManifestCanonicalization(_) => "manifest_canonicalization",
        AdmissionError::InvalidManifestSignature(_) => "invalid_manifest_signature",
        AdmissionError::ManifestTransitionSignatureRequired => {
            "manifest_transition_signature_required"
        }
        AdmissionError::ManifestOldSignatureAfterCutoff => "manifest_old_signature_after_cutoff",
        AdmissionError::UntrustedManifestKey(_) => "untrusted_manifest_key",
        AdmissionError::UnsupportedManifestAlgorithm(_) => "unsupported_manifest_algorithm",
        AdmissionError::ManifestIssuedInFuture { .. } => "manifest_issued_in_future",
        AdmissionError::ManifestExpired { .. } => "manifest_expired",
        AdmissionError::ManifestNetworkMismatch { .. } => "manifest_network_mismatch",
        AdmissionError::ManifestGenesisMismatch { .. } => "manifest_genesis_mismatch",
        AdmissionError::RuntimeNetworkMismatch { .. } => "runtime_network_mismatch",
        AdmissionError::PskVerificationFailed(_) => "psk_verification_failed",
        AdmissionError::LocalGenesisMismatch { .. } => "local_genesis_mismatch",
        AdmissionError::Storage(_) => "storage",
    }
}

fn compute_local_genesis_hash<S: LedgerStorage>(storage: &S) -> Result<String, AdmissionError> {
    match storage.get_block(1).map_err(AdmissionError::Storage)? {
        Some(block) => Ok(hash_block_header(&block.header)),
        None => Ok(blake3::hash(b"GENESIS::EMPTY").to_hex().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use citizen_storage::MemoryStorage;

    fn reset_metrics() {
        if let Some(startup_fail_total) = STARTUP_FAIL_TOTAL.get() {
            startup_fail_total
                .lock()
                .expect("startup failure metrics lock poisoned")
                .clear();
        }
        if let Some(manifest_verification_duration_ms) = MANIFEST_VERIFICATION_DURATION_MS.get() {
            manifest_verification_duration_ms
                .lock()
                .expect("manifest verification metrics lock poisoned")
                .clear();
        }
        if let Some(manifest_verification_duration_histogram) =
            MANIFEST_VERIFICATION_DURATION_HISTOGRAM.get()
        {
            manifest_verification_duration_histogram
                .lock()
                .expect("manifest verification histogram metrics lock poisoned")
                .clear();
        }
    }

    fn base_settings() -> AdmissionSettings {
        AdmissionSettings {
            network_id: "citizen-localnet".to_string(),
            manifest_path: None,
            manifest_enforce: false,
            startup_secret: None,
            expected_genesis_hash: None,
        }
    }

    #[test]
    fn preflight_rejects_runtime_network_mismatch() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let mut settings = base_settings();
        settings.network_id = "citizen-othernet".to_string();

        let result = run_preflight(&settings, &storage);
        assert!(matches!(
            result,
            Err(AdmissionError::RuntimeNetworkMismatch { .. })
        ));
    }

    #[test]
    fn preflight_requires_manifest_when_enforced() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let mut settings = base_settings();
        settings.manifest_enforce = true;

        let result = run_preflight(&settings, &storage);
        assert!(matches!(result, Err(AdmissionError::ManifestRequired)));
    }

    #[test]
    fn preflight_allows_no_manifest_when_not_enforced() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let settings = base_settings();

        let context = run_preflight(&settings, &storage).expect("preflight should pass");
        assert_eq!(context.network_id, "citizen-localnet");
        assert_eq!(context.manifest_digest, "manifest-not-enforced");
    }
    #[test]
    fn preflight_rejects_expired_manifest() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let genesis_hash = compute_local_genesis_hash(&storage).expect("genesis hash");
        let issued_at = unix_now() - MANIFEST_MAX_AGE_SECS - 10;
        let path = write_signed_manifest(issued_at, &genesis_hash);

        let mut settings = base_settings();
        settings.manifest_enforce = true;
        settings.manifest_path = Some(path.clone());

        let result = run_preflight(&settings, &storage);
        std::fs::remove_file(path).ok();
        assert!(matches!(
            result,
            Err(AdmissionError::ManifestExpired { .. })
        ));
    }

    #[test]
    fn preflight_accepts_fresh_manifest() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let genesis_hash = compute_local_genesis_hash(&storage).expect("genesis hash");
        let issued_at = unix_now();
        let path = write_signed_manifest(issued_at, &genesis_hash);

        let mut settings = base_settings();
        settings.manifest_enforce = true;
        settings.manifest_path = Some(path.clone());

        let result = run_preflight(&settings, &storage);
        std::fs::remove_file(path).ok();
        assert!(result.is_ok());
    }

    #[test]
    fn preflight_rejects_invalid_manifest_signature() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let genesis_hash = compute_local_genesis_hash(&storage).expect("genesis hash");
        let issued_at = unix_now();
        let path = write_signed_manifest(issued_at, &genesis_hash);

        let mut manifest: SignedManifest =
            serde_json::from_slice(&std::fs::read(&path).expect("read manifest"))
                .expect("parse manifest");
        manifest.signatures[0].signature = "00".repeat(64);
        std::fs::write(
            &path,
            serde_json::to_vec(&manifest).expect("serialize broken manifest"),
        )
        .expect("write broken manifest");

        let mut settings = base_settings();
        settings.manifest_enforce = true;
        settings.manifest_path = Some(path.clone());

        let result = run_preflight(&settings, &storage);
        std::fs::remove_file(path).ok();
        assert!(matches!(
            result,
            Err(AdmissionError::InvalidManifestSignature(_))
        ));
    }

    #[test]
    fn preflight_rejects_manifest_genesis_mismatch() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let issued_at = unix_now();
        let path = write_signed_manifest(issued_at, "different-genesis");

        let mut settings = base_settings();
        settings.manifest_enforce = true;
        settings.manifest_path = Some(path.clone());

        let result = run_preflight(&settings, &storage);
        std::fs::remove_file(path).ok();
        assert!(matches!(
            result,
            Err(AdmissionError::ManifestGenesisMismatch { .. })
        ));
    }

    #[test]
    fn preflight_rejects_local_genesis_mismatch() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let issued_at = unix_now();
        let expected_genesis = "manually-overridden-genesis";
        let path = write_signed_manifest(issued_at, expected_genesis);

        let mut settings = base_settings();
        settings.manifest_enforce = true;
        settings.expected_genesis_hash = Some(expected_genesis.to_string());
        settings.manifest_path = Some(path.clone());

        let result = run_preflight(&settings, &storage);
        std::fs::remove_file(path).ok();
        assert!(matches!(
            result,
            Err(AdmissionError::LocalGenesisMismatch { .. })
        ));
    }

    #[test]
    fn preflight_records_startup_failure_reason_metric() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let mut settings = base_settings();
        settings.manifest_enforce = true;

        let baseline = startup_metrics_snapshot()
            .startup_fail_total
            .get("manifest_required")
            .copied()
            .unwrap_or(0);

        let result = run_preflight(&settings, &storage);
        assert!(matches!(result, Err(AdmissionError::ManifestRequired)));

        let metrics = startup_metrics_snapshot();
        assert!(
            metrics
                .startup_fail_total
                .get("manifest_required")
                .copied()
                .unwrap_or(0)
                >= baseline + 1,
            "expected manifest_required counter to increment"
        );
    }

    #[test]
    fn preflight_records_manifest_verification_duration_metric() {
        reset_metrics();
        let storage = MemoryStorage::new();
        let genesis_hash = compute_local_genesis_hash(&storage).expect("genesis hash");
        let path = write_signed_manifest(unix_now(), &genesis_hash);

        let mut settings = base_settings();
        settings.manifest_enforce = true;
        settings.manifest_path = Some(path.clone());

        let baseline = startup_metrics_snapshot()
            .manifest_verification_duration_ms
            .len();

        run_preflight(&settings, &storage).expect("preflight should pass");
        std::fs::remove_file(path).ok();

        let metrics = startup_metrics_snapshot();
        assert!(
            metrics.manifest_verification_duration_ms.len() >= baseline + 1,
            "expected at least one additional manifest verification duration sample"
        );
        let histogram_total: u64 = metrics
            .manifest_verification_duration_histogram
            .values()
            .sum();
        assert!(
            histogram_total >= 1,
            "expected at least one histogram bucket sample"
        );
    }

    fn write_signed_manifest(issued_at: i64, genesis_hash: &str) -> std::path::PathBuf {
        use crate::admission::manifest::{
            ManifestPayload, ManifestSignature, ManifestValidator, SignedManifest,
        };
        use ed25519_dalek::{Signer, SigningKey};

        let seed = blake3::hash(format!("manifest-seed-{issued_at}-{genesis_hash}").as_bytes());
        let signing_key = SigningKey::from_bytes(seed.as_bytes());
        let key_id = hex::encode(signing_key.verifying_key().to_bytes());

        let manifest = SignedManifest {
            payload: ManifestPayload {
                network_id: "citizen-localnet".to_string(),
                genesis_hash: genesis_hash.to_string(),
                boot_nodes: vec!["127.0.0.1:9000".to_string()],
                validator_allowlist: vec![ManifestValidator {
                    validator_id: "validator-1".to_string(),
                    public_key: key_id.clone(),
                }],
                issued_at,
                version: 1,
                manifest_id: "manifest-test".to_string(),
            },
            signatures: vec![],
        };

        let payload = serde_json::to_vec(&manifest.payload).expect("canonical payload");
        let signature = signing_key.sign(&payload);
        let signed_manifest = SignedManifest {
            payload: manifest.payload,
            signatures: vec![ManifestSignature {
                key_id,
                algorithm: "ed25519".to_string(),
                signature: hex::encode(signature.to_bytes()),
            }],
        };

        let mut path = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        path.push(format!("citizen-manifest-{nanos}.json"));
        let bytes = serde_json::to_vec(&signed_manifest).expect("encode signed manifest");
        std::fs::write(&path, bytes).expect("write manifest");
        path
    }

    fn unix_now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default()
    }
}
