use citizen_types::{BlockHeader, CommitProof, LedgerEntry, ProtocolError, ValidatorId};
use ed25519_dalek::{
    Signature, Signer, SigningKey, VerifyingKey, PUBLIC_KEY_LENGTH, SECRET_KEY_LENGTH,
};
use parking_lot::RwLock;
use rand::rngs::OsRng;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Arc;

pub type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Clone)]
pub struct ValidatorKeypair {
    pub validator_id: ValidatorId,
    signing_key: Arc<SigningKey>,
    verifying_key: VerifyingKey,
}

impl ValidatorKeypair {
    pub fn generate(validator_id: ValidatorId) -> Self {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng);
        let verifying_key = signing_key.verifying_key();
        Self {
            validator_id,
            signing_key: Arc::new(signing_key),
            verifying_key,
        }
    }

    pub fn from_secret_bytes(validator_id: ValidatorId, secret: &[u8]) -> Result<Self> {
        if secret.len() != SECRET_KEY_LENGTH {
            return Err(ProtocolError::crypto(format!(
                "invalid secret key length: expected {SECRET_KEY_LENGTH} bytes, got {}",
                secret.len()
            )));
        }
        let mut key_bytes = [0u8; SECRET_KEY_LENGTH];
        key_bytes.copy_from_slice(secret);
        let signing_key = SigningKey::from_bytes(&key_bytes);
        let verifying_key = signing_key.verifying_key();
        Ok(Self {
            validator_id,
            signing_key: Arc::new(signing_key),
            verifying_key,
        })
    }

    pub fn signing_key(&self) -> Arc<SigningKey> {
        self.signing_key.clone()
    }

    pub fn verifying_key(&self) -> &VerifyingKey {
        &self.verifying_key
    }
}

#[derive(Clone, Default)]
pub struct KeyRegistry {
    inner: Arc<RwLock<BTreeMap<ValidatorId, VerifyingKey>>>,
}

impl KeyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, validator_id: ValidatorId, key: VerifyingKey) {
        self.inner.write().insert(validator_id, key);
    }

    pub fn get(&self, validator_id: &ValidatorId) -> Option<VerifyingKey> {
        self.inner.read().get(validator_id).copied()
    }
}

pub fn sign_message(keypair: &ValidatorKeypair, message: &[u8]) -> Signature {
    keypair.signing_key.sign(message)
}

pub fn verify_signature(key: &VerifyingKey, message: &[u8], signature: &Signature) -> bool {
    key.verify_strict(message, signature).is_ok()
}

pub fn hash_block_header(header: &BlockHeader) -> String {
    // Serialize header minimally to hash-critical fields.
    // Commit proofs are excluded so the hash remains stable before and after aggregation.
    let mut hasher = Sha256::new();
    hasher.update(header.height.to_be_bytes());
    hasher.update(header.prev_hash.as_bytes());
    hasher.update(header.entry_root.as_bytes());
    hasher.update(header.proposer.as_bytes());
    hasher.update(header.timestamp.to_be_bytes());
    hex::encode(hasher.finalize())
}

pub fn hash_entry(entry: &LedgerEntry) -> String {
    let mut hasher = Sha256::new();
    hasher.update(entry.entry_id.as_bytes());
    hasher.update(entry.namespace.as_bytes());
    hasher.update(entry.action.as_bytes());
    hasher.update(entry.object_id.as_bytes());
    hasher.update(entry.author.as_bytes());
    hasher.update(entry.signature.as_bytes());
    hasher.update(entry.timestamp.to_be_bytes());
    hasher.update(entry.payload.to_string().as_bytes());
    hex::encode(hasher.finalize())
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let encoded_entries: Vec<String> = keys
                .iter()
                .map(|key| {
                    let encoded_key = serde_json::to_string(key)
                        .expect("canonical object key serialization");
                    let encoded_value = canonical_json(&map[*key]);
                    format!("{encoded_key}:{encoded_value}")
                })
                .collect();
            format!("{{{}}}", encoded_entries.join(","))
        }
        Value::Array(items) => {
            let encoded_items: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", encoded_items.join(","))
        }
        _ => serde_json::to_string(value).expect("canonical scalar serialization"),
    }
}

pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

pub fn aggregate_signatures(
    signatures: &BTreeMap<ValidatorId, Signature>,
    quorum: usize,
) -> Result<CommitProof> {
    if signatures.len() < quorum {
        return Err(ProtocolError::crypto("insufficient signatures for quorum"));
    }
    Ok(CommitProof {
        aggregated_signature: encode_signatures(signatures),
        participant_ids: signatures.keys().cloned().collect(),
    })
}

fn encode_signatures(signatures: &BTreeMap<ValidatorId, Signature>) -> String {
    signatures
        .iter()
        .map(|(id, sig)| format!("{id}:{:x}", sig))
        .collect::<Vec<_>>()
        .join("|")
}

pub fn verify_commit_proof(
    registry: &KeyRegistry,
    header: &BlockHeader,
    proof: &CommitProof,
) -> Result<()> {
    let message = hash_block_header(header);
    let signature_pairs = decode_signatures(&proof.aggregated_signature)?;
    if signature_pairs.len() != proof.participant_ids.len() {
        return Err(ProtocolError::crypto("signature participant set mismatch"));
    }
    for (validator_id, signature) in signature_pairs {
        let key = registry
            .get(&validator_id)
            .ok_or_else(|| ProtocolError::MissingValidator(validator_id.clone()))?;
        if !verify_signature(&key, message.as_bytes(), &signature) {
            return Err(ProtocolError::crypto(format!(
                "invalid signature from {validator_id}"
            )));
        }
    }
    Ok(())
}

fn decode_signatures(encoded: &str) -> Result<Vec<(ValidatorId, Signature)>> {
    encoded
        .split('|')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let (validator, sig_hex) = segment
                .split_once(':')
                .ok_or_else(|| ProtocolError::crypto("malformed signature encoding"))?;
            let bytes = hex::decode(sig_hex)
                .map_err(|err| ProtocolError::crypto(format!("invalid signature hex: {err}")))?;
            let signature = Signature::from_slice(&bytes)
                .map_err(|err| ProtocolError::crypto(format!("invalid signature bytes: {err}")))?;
            Ok((validator.to_string(), signature))
        })
        .collect()
}

pub fn quorum_threshold(total_validators: usize, quorum_bps: u32) -> usize {
    let numerator = total_validators * quorum_bps as usize;
    (numerator + 9_999) / 10_000
}

pub fn parse_verifying_key(encoded: &str) -> Result<VerifyingKey> {
    let bytes = hex::decode(encoded)
        .map_err(|err| ProtocolError::crypto(format!("invalid verifying key hex: {err}")))?;
    if bytes.len() != PUBLIC_KEY_LENGTH {
        return Err(ProtocolError::crypto(format!(
            "invalid verifying key length: expected {PUBLIC_KEY_LENGTH} bytes, got {}",
            bytes.len()
        )));
    }
    let mut key_bytes = [0u8; PUBLIC_KEY_LENGTH];
    key_bytes.copy_from_slice(&bytes);
    VerifyingKey::from_bytes(&key_bytes)
        .map_err(|err| ProtocolError::crypto(format!("invalid verifying key bytes: {err}")))
}

pub fn verifying_key_to_string(key: &VerifyingKey) -> String {
    hex::encode(key.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct VectorFile {
        vectors: Vec<TestVector>,
    }

    #[derive(Debug, Deserialize)]
    struct TestVector {
        manifest: Option<Value>,
        field_commitment_input: Option<Value>,
        expected_canonical_json: String,
        expected_sha256: String,
    }

    #[test]
    fn quorum_calculation_rounds_up() {
        assert_eq!(quorum_threshold(5, 8000), 4);
        assert_eq!(quorum_threshold(10, 8000), 8);
    }

    #[test]
    fn file_commitment_vectors_match_canonical_hashes() {
        let vectors: VectorFile = serde_json::from_str(include_str!(
            "../../../docs/test-vectors/file_commitment_test_vectors.json"
        ))
        .expect("valid file commitment vectors");

        for vector in vectors.vectors {
            let input = vector.manifest.expect("manifest vector input");
            let canonical = canonical_json(&input);
            assert_eq!(canonical, vector.expected_canonical_json);
            assert_eq!(sha256_hex(&canonical), vector.expected_sha256);
        }
    }

    #[test]
    fn payload_field_commitment_vectors_match_canonical_hashes() {
        let vectors: VectorFile = serde_json::from_str(include_str!(
            "../../../docs/test-vectors/payload_field_commitment_test_vectors.json"
        ))
        .expect("valid payload commitment vectors");

        for vector in vectors.vectors {
            let input = vector
                .field_commitment_input
                .expect("field commitment vector input");
            let canonical = canonical_json(&input);
            assert_eq!(canonical, vector.expected_canonical_json);
            assert_eq!(sha256_hex(&canonical), vector.expected_sha256);
        }
    }
}
