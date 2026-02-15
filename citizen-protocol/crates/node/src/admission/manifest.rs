use super::runtime_identity::{
    ACTIVE_MANIFEST_KEYS, REQUIRE_DUAL_SIGNATURE_DURING_TRANSITION, REVOKED_MANIFEST_KEYS,
    TRANSITION_DUAL_SIGNATURE_UNTIL_UNIX_SECS, TRANSITION_MANIFEST_KEYS,
};
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

#[derive(Clone, Debug)]
struct ManifestKeyPolicy<'a> {
    active: HashSet<&'a str>,
    transition: HashSet<&'a str>,
    revoked: HashSet<&'a str>,
    require_dual_signature_during_transition: bool,
    dual_signature_until_unix_secs: Option<i64>,
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
        let now_unix_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default();
        self.verify_signatures_at(now_unix_secs)
    }

    pub fn verify_signatures_at(&self, now_unix_secs: i64) -> Result<(), AdmissionError> {
        let policy = ManifestKeyPolicy {
            active: ACTIVE_MANIFEST_KEYS.iter().copied().collect(),
            transition: TRANSITION_MANIFEST_KEYS.iter().copied().collect(),
            revoked: REVOKED_MANIFEST_KEYS.iter().copied().collect(),
            require_dual_signature_during_transition: REQUIRE_DUAL_SIGNATURE_DURING_TRANSITION,
            dual_signature_until_unix_secs: TRANSITION_DUAL_SIGNATURE_UNTIL_UNIX_SECS,
        };
        self.verify_signatures_with_policy(&policy, now_unix_secs)
    }

    fn verify_signatures_with_policy(
        &self,
        policy: &ManifestKeyPolicy<'_>,
        now_unix_secs: i64,
    ) -> Result<(), AdmissionError> {
        if self.signatures.is_empty() {
            return Err(AdmissionError::InvalidManifestSignature(
                "manifest has no signatures".into(),
            ));
        }

        let enforce_key_policy = !policy.active.is_empty()
            || !policy.transition.is_empty()
            || !policy.revoked.is_empty();
        let payload = self.canonical_payload_bytes()?;
        let mut valid = 0usize;
        let mut valid_active = 0usize;
        let mut valid_transition = 0usize;

        for signature in &self.signatures {
            if signature.algorithm != "ed25519" {
                return Err(AdmissionError::UnsupportedManifestAlgorithm(
                    signature.algorithm.clone(),
                ));
            }

            if policy.revoked.contains(signature.key_id.as_str()) {
                return Err(AdmissionError::UntrustedManifestKey(
                    signature.key_id.clone(),
                ));
            }

            if enforce_key_policy
                && !policy.active.contains(signature.key_id.as_str())
                && !policy.transition.contains(signature.key_id.as_str())
            {
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
                if policy.active.contains(signature.key_id.as_str()) {
                    valid_active += 1;
                }
                if policy.transition.contains(signature.key_id.as_str()) {
                    valid_transition += 1;
                }
            }
        }

        if valid == 0 {
            return Err(AdmissionError::InvalidManifestSignature(
                "no valid signatures over canonical payload".into(),
            ));
        }

        if enforce_key_policy && valid_active == 0 {
            if valid_transition > 0 && transition_window_closed(policy, now_unix_secs) {
                return Err(AdmissionError::ManifestOldSignatureAfterCutoff);
            }
            return Err(AdmissionError::InvalidManifestSignature(
                "manifest is missing a valid active-key signature".into(),
            ));
        }

        if requires_transition_signature(policy, now_unix_secs) && valid_transition == 0 {
            return Err(AdmissionError::ManifestTransitionSignatureRequired);
        }

        Ok(())
    }
}

fn transition_window_closed(policy: &ManifestKeyPolicy<'_>, now_unix_secs: i64) -> bool {
    policy
        .dual_signature_until_unix_secs
        .is_some_and(|cutoff| now_unix_secs > cutoff)
}

fn requires_transition_signature(policy: &ManifestKeyPolicy<'_>, now_unix_secs: i64) -> bool {
    if policy.transition.is_empty() || !policy.require_dual_signature_during_transition {
        return false;
    }

    match policy.dual_signature_until_unix_secs {
        Some(cutoff) => now_unix_secs <= cutoff,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn canonical_payload_encoding_is_deterministic() {
        let (active_signer, active_key_id) = test_keypair("active");
        let manifest = signed_manifest(vec![(active_signer, active_key_id)]);

        let bytes_a = manifest
            .canonical_payload_bytes()
            .expect("canonical payload bytes should encode");
        let bytes_b = manifest
            .canonical_payload_bytes()
            .expect("canonical payload bytes should encode");

        assert_eq!(bytes_a, bytes_b);
        assert_eq!(
            blake3::hash(&bytes_a).to_hex().to_string(),
            manifest.digest_hex().expect("digest should compute")
        );
    }

    #[test]
    fn rejects_unsigned_manifest() {
        let manifest = SignedManifest {
            payload: ManifestPayload {
                network_id: "citizen-localnet".into(),
                genesis_hash: "genesis".into(),
                boot_nodes: vec![],
                validator_allowlist: vec![],
                issued_at: 100,
                version: 1,
                manifest_id: "manifest".into(),
            },
            signatures: vec![],
        };

        let result = manifest.verify_signatures_at(100);
        assert!(matches!(
            result,
            Err(AdmissionError::InvalidManifestSignature(message)) if message.contains("no signatures")
        ));
    }

    #[test]
    fn rejects_manifest_with_unsupported_signature_algorithm() {
        let (active_signer, active_key_id) = test_keypair("active");
        let mut manifest = signed_manifest(vec![(active_signer, active_key_id)]);
        manifest.signatures[0].algorithm = "rsa-pss".to_string();

        let result = manifest.verify_signatures_at(100);
        assert!(matches!(
            result,
            Err(AdmissionError::UnsupportedManifestAlgorithm(algorithm)) if algorithm == "rsa-pss"
        ));
    }

    #[test]
    fn transition_window_requires_transition_signature() {
        let (active_signer, active_key_id) = test_keypair("active");
        let (_, transition_key_id) = test_keypair("transition");
        let manifest = signed_manifest(vec![(active_signer, active_key_id.clone())]);
        let now = 200;
        let policy = policy(
            vec![active_key_id.as_str()],
            vec![transition_key_id.as_str()],
            now,
        );

        let result = manifest.verify_signatures_with_policy(&policy, now);
        assert!(matches!(
            result,
            Err(AdmissionError::ManifestTransitionSignatureRequired)
        ));
    }

    #[test]
    fn post_cutoff_rejects_old_only_transition_signatures() {
        let (_, active_key_id) = test_keypair("active");
        let (transition_signer, transition_key_id) = test_keypair("transition");
        let manifest = signed_manifest(vec![(transition_signer, transition_key_id.clone())]);
        let now = 500;
        let policy = policy(
            vec![active_key_id.as_str()],
            vec![transition_key_id.as_str()],
            100,
        );

        let result = manifest.verify_signatures_with_policy(&policy, now);
        assert!(matches!(
            result,
            Err(AdmissionError::ManifestOldSignatureAfterCutoff)
        ));
    }

    #[test]
    fn revoked_key_signature_rejected_even_during_transition_window() {
        let (_, active_key_id) = test_keypair("active");
        let (transition_signer, transition_key_id) = test_keypair("transition");
        let manifest = signed_manifest(vec![(transition_signer, transition_key_id.clone())]);
        let now = 150;
        let policy = ManifestKeyPolicy {
            active: vec![active_key_id.as_str()].into_iter().collect(),
            transition: vec![transition_key_id.as_str()].into_iter().collect(),
            revoked: vec![transition_key_id.as_str()].into_iter().collect(),
            require_dual_signature_during_transition: true,
            dual_signature_until_unix_secs: Some(200),
        };

        let result = manifest.verify_signatures_with_policy(&policy, now);
        assert!(matches!(
            result,
            Err(AdmissionError::UntrustedManifestKey(key_id)) if key_id == transition_key_id
        ));
    }

    fn policy<'a>(
        active: Vec<&'a str>,
        transition: Vec<&'a str>,
        cutoff: i64,
    ) -> ManifestKeyPolicy<'a> {
        ManifestKeyPolicy {
            active: active.into_iter().collect(),
            transition: transition.into_iter().collect(),
            revoked: HashSet::new(),
            require_dual_signature_during_transition: true,
            dual_signature_until_unix_secs: Some(cutoff),
        }
    }

    fn signed_manifest(signers: Vec<(SigningKey, String)>) -> SignedManifest {
        let payload = ManifestPayload {
            network_id: "citizen-localnet".into(),
            genesis_hash: "genesis".into(),
            boot_nodes: vec![],
            validator_allowlist: vec![],
            issued_at: 100,
            version: 1,
            manifest_id: "manifest".into(),
        };
        let payload_bytes = serde_json::to_vec(&payload).expect("payload");
        let signatures = signers
            .into_iter()
            .map(|(signer, key_id)| ManifestSignature {
                key_id,
                algorithm: "ed25519".into(),
                signature: hex::encode(signer.sign(&payload_bytes).to_bytes()),
            })
            .collect();

        SignedManifest {
            payload,
            signatures,
        }
    }

    fn test_keypair(seed: &str) -> (SigningKey, String) {
        let seed_hash = blake3::hash(seed.as_bytes());
        let signer = SigningKey::from_bytes(seed_hash.as_bytes());
        let key_id = hex::encode(signer.verifying_key().to_bytes());
        (signer, key_id)
    }
}
