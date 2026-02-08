use citizen_types::{LedgerEntry, ProtocolError, UnixTimestamp};
use ed25519_dalek::{
    Signature, Signer, SigningKey, VerifyingKey, PUBLIC_KEY_LENGTH, SECRET_KEY_LENGTH,
};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntryDraft {
    pub namespace: String,
    pub action: String,
    pub object_id: String,
    pub payload: Value,
    pub author: String,
    pub timestamp: UnixTimestamp,
}

#[derive(Clone, Debug)]
pub struct WalletKeypair {
    pub key_id: Uuid,
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
}

impl WalletKeypair {
    pub fn generate() -> Self {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng);
        let verifying_key = signing_key.verifying_key();
        Self {
            key_id: Uuid::new_v4(),
            signing_key,
            verifying_key,
        }
    }

    pub fn from_secret_bytes(key_id: Uuid, secret: &[u8]) -> Result<Self> {
        let secret_bytes = secret.try_into().map_err(|_| {
            ProtocolError::crypto(format!(
                "invalid secret key length: expected {} bytes, got {}",
                SECRET_KEY_LENGTH,
                secret.len()
            ))
        })?;
        let signing_key = SigningKey::from_bytes(secret_bytes);
        let verifying_key = signing_key.verifying_key();
        Ok(Self {
            key_id,
            signing_key,
            verifying_key,
        })
    }

    pub fn verifying_key(&self) -> &VerifyingKey {
        &self.verifying_key
    }

    pub fn verifying_key_hex(&self) -> String {
        hex::encode(self.verifying_key.to_bytes())
    }

    pub fn secret_key_bytes(&self) -> [u8; SECRET_KEY_LENGTH] {
        self.signing_key.to_bytes()
    }

    pub fn sign_bytes(&self, payload: &[u8]) -> Signature {
        self.signing_key.sign(payload)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct EntrySigningPayload {
    entry_id: Uuid,
    namespace: String,
    action: String,
    object_id: String,
    payload: Value,
    author: String,
    timestamp: UnixTimestamp,
}

pub fn sign_entry(draft: EntryDraft, keypair: &WalletKeypair) -> Result<LedgerEntry> {
    let entry_id = Uuid::new_v4();
    let payload = EntrySigningPayload {
        entry_id,
        namespace: draft.namespace.clone(),
        action: draft.action.clone(),
        object_id: draft.object_id.clone(),
        payload: draft.payload.clone(),
        author: draft.author.clone(),
        timestamp: draft.timestamp,
    };
    let canonical_payload = canonical_json(&serde_json::to_value(payload).map_err(|err| {
        ProtocolError::crypto(format!("failed to serialize signing payload: {err}"))
    })?);
    let signature = keypair.sign_bytes(canonical_payload.as_bytes());
    Ok(LedgerEntry {
        entry_id,
        namespace: draft.namespace,
        action: draft.action,
        object_id: draft.object_id,
        payload: draft.payload,
        author: draft.author,
        signature: hex::encode(signature.to_bytes()),
        timestamp: draft.timestamp,
    })
}

pub fn verify_entry_signature(
    entry: &LedgerEntry,
    verifying_key: &VerifyingKey,
) -> Result<()> {
    let payload = EntrySigningPayload {
        entry_id: entry.entry_id,
        namespace: entry.namespace.clone(),
        action: entry.action.clone(),
        object_id: entry.object_id.clone(),
        payload: entry.payload.clone(),
        author: entry.author.clone(),
        timestamp: entry.timestamp,
    };
    let canonical_payload = canonical_json(&serde_json::to_value(payload).map_err(|err| {
        ProtocolError::crypto(format!("failed to serialize signing payload: {err}"))
    })?);
    let signature_bytes = hex::decode(&entry.signature)
        .map_err(|err| ProtocolError::crypto(format!("invalid signature hex: {err}")))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|err| ProtocolError::crypto(format!("invalid signature bytes: {err}")))?;
    verifying_key
        .verify_strict(canonical_payload.as_bytes(), &signature)
        .map_err(|err| ProtocolError::crypto(format!("signature verification failed: {err}")))
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

fn canonical_json(value: &Value) -> String {
    let normalized = normalize_value(value);
    serde_json::to_string(&normalized).unwrap_or_else(|_| "null".to_string())
}

fn normalize_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let normalized = entries
                .into_iter()
                .map(|(k, v)| (k.clone(), normalize_value(v)))
                .collect();
            Value::Object(normalized)
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(normalize_value).collect::<Vec<_>>())
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_object_keys() {
        let value = json!({ "b": 1, "a": { "d": 2, "c": 3 } });
        let canonical = canonical_json(&value);
        assert_eq!(canonical, r#"{"a":{"c":3,"d":2},"b":1}"#);
    }

    #[test]
    fn signs_and_verifies_entry() {
        let keypair = WalletKeypair::generate();
        let draft = EntryDraft {
            namespace: "identity.citizen".to_string(),
            action: "REGISTER_IDENTITY".to_string(),
            object_id: "did:ledger:abc".to_string(),
            payload: json!({ "claims_hash": "abc123" }),
            author: "did:ledger:abc".to_string(),
            timestamp: 1_736_500_000,
        };
        let entry = sign_entry(draft, &keypair).expect("sign entry");
        verify_entry_signature(&entry, keypair.verifying_key()).expect("verify signature");
    }
}
