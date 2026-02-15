use super::runtime_identity::TRUSTED_MANIFEST_KEYS;
use super::AdmissionError;
use citizen_crypto::{parse_verifying_key, verify_signature};
use ed25519_dalek::Signature;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManifestPayload {
    pub network_id: String,
    pub genesis_hash: String,
    pub boot_nodes: Vec<String>,
    pub validator_allowlist: Vec<ManifestValidator>,
    pub issued_at: i64,
    pub version: u64,
    pub manifest_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManifestValidator {
    pub validator_id: String,
    pub public_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManifestSignature {
    pub key_id: String,
    pub algorithm: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignedManifest {
    pub payload: ManifestPayload,
    pub signatures: Vec<ManifestSignature>,
}

impl SignedManifest {
    pub fn load(path: &Path) -> Result<Self, AdmissionError> {
        let bytes = std::fs::read(path).map_err(|source| AdmissionError::ManifestRead {
            path: path.to_path_buf(),
            source,
        })?;
        serde_json::from_slice(&bytes).map_err(AdmissionError::ManifestParse)
    }

    pub fn canonical_payload_bytes(&self) -> Result<Vec<u8>, AdmissionError> {
        serde_json::to_vec(&self.payload).map_err(AdmissionError::ManifestCanonicalization)
    }

    pub fn digest_hex(&self) -> Result<String, AdmissionError> {
        let payload = self.canonical_payload_bytes()?;
        Ok(blake3::hash(&payload).to_hex().to_string())
    }

    pub fn verify_freshness(
        &self,
        now_unix_secs: i64,
        max_age_secs: i64,
        max_future_skew_secs: i64,
    ) -> Result<(), AdmissionError> {
        if self.payload.issued_at > now_unix_secs + max_future_skew_secs {
            return Err(AdmissionError::ManifestIssuedInFuture {
                issued_at: self.payload.issued_at,
                now: now_unix_secs,
            });
        }

        if now_unix_secs - self.payload.issued_at > max_age_secs {
            return Err(AdmissionError::ManifestExpired {
                issued_at: self.payload.issued_at,
                now: now_unix_secs,
                max_age_secs,
            });
        }

        Ok(())
    }

    pub fn verify_signatures(&self) -> Result<(), AdmissionError> {
        if self.signatures.is_empty() {
            return Err(AdmissionError::InvalidManifestSignature(
                "manifest has no signatures".into(),
            ));
        }

        let trusted: HashSet<&str> = TRUSTED_MANIFEST_KEYS.iter().copied().collect();
        let payload = self.canonical_payload_bytes()?;
        let mut valid = 0usize;

        for signature in &self.signatures {
            if signature.algorithm != "ed25519" {
                return Err(AdmissionError::UnsupportedManifestAlgorithm(
                    signature.algorithm.clone(),
                ));
            }

            if !trusted.is_empty() && !trusted.contains(signature.key_id.as_str()) {
                return Err(AdmissionError::UntrustedManifestKey(
                    signature.key_id.clone(),
                ));
            }

            let verifying_key = parse_verifying_key(&signature.key_id)
                .map_err(|e| AdmissionError::InvalidManifestSignature(e.to_string()))?;
            let signature_bytes = hex::decode(&signature.signature)
                .map_err(|e| AdmissionError::InvalidManifestSignature(e.to_string()))?;
            let parsed_sig = Signature::from_slice(&signature_bytes)
                .map_err(|e| AdmissionError::InvalidManifestSignature(e.to_string()))?;

            if verify_signature(&verifying_key, &payload, &parsed_sig) {
                valid += 1;
            }
        }

        if valid == 0 {
            return Err(AdmissionError::InvalidManifestSignature(
                "no valid signatures over canonical payload".into(),
            ));
        }

        Ok(())
    }
}
