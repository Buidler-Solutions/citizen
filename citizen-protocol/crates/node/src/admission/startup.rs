use super::manifest::SignedManifest;
use super::runtime_identity::{RUNTIME_NETWORK_ID, RUNTIME_PSK_HASH};
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
}
