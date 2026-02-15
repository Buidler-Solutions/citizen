use super::manifest::SignedManifest;
use super::runtime_identity::{
    MANIFEST_MAX_AGE_SECS, MANIFEST_MAX_FUTURE_SKEW_SECS, RUNTIME_NETWORK_ID, RUNTIME_PSK_HASH,
};
use super::{AdmissionContext, AdmissionError, AdmissionSettings};
use citizen_crypto::hash_block_header;
use citizen_storage::LedgerStorage;

pub fn run_preflight<S: LedgerStorage>(
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
            manifest.verify_signatures()?;
            let now_unix_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or_default();
            manifest.verify_freshness(
                now_unix_secs,
                MANIFEST_MAX_AGE_SECS,
                MANIFEST_MAX_FUTURE_SKEW_SECS,
            )?;
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
        let storage = MemoryStorage::new();
        let mut settings = base_settings();
        settings.manifest_enforce = true;

        let result = run_preflight(&settings, &storage);
        assert!(matches!(result, Err(AdmissionError::ManifestRequired)));
    }

    #[test]
    fn preflight_allows_no_manifest_when_not_enforced() {
        let storage = MemoryStorage::new();
        let settings = base_settings();

        let context = run_preflight(&settings, &storage).expect("preflight should pass");
        assert_eq!(context.network_id, "citizen-localnet");
        assert_eq!(context.manifest_digest, "manifest-not-enforced");
    }
    #[test]
    fn preflight_rejects_expired_manifest() {
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
