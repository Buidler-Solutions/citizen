use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use citizen_types::{
    ConsentReceipt, DidDocument, DidStatus, KdfParams, LedgerEntry, ProtocolError, UnixTimestamp,
};
use ed25519_dalek::{
    Signature, Signer, SigningKey, VerifyingKey, PUBLIC_KEY_LENGTH, SECRET_KEY_LENGTH,
};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, ProtocolError>;

pub mod cli;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntryDraft {
    pub namespace: String,
    pub action: String,
    pub object_id: String,
    pub payload: Value,
    #[serde(default)]
    pub privacy_flag: bool,
    #[serde(skip_serializing, skip_deserializing)]
    pub encryption_passphrase: Option<String>,
    pub author: String,
    pub timestamp: UnixTimestamp,
}

#[derive(Clone, Debug)]
pub struct WalletKeypair {
    pub key_id: Uuid,
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
}

pub trait KeyProvider {
    fn provider_id(&self) -> &str;
    fn public_key_hex(&self) -> String;
    fn sign_bytes(&self, payload: &[u8]) -> Result<Vec<u8>>;
}

pub struct SoftwareKeyProvider {
    keypair: WalletKeypair,
}

impl SoftwareKeyProvider {
    pub fn new(keypair: WalletKeypair) -> Self {
        Self { keypair }
    }
}

impl KeyProvider for SoftwareKeyProvider {
    fn provider_id(&self) -> &str {
        "software-ed25519"
    }

    fn public_key_hex(&self) -> String {
        self.keypair.verifying_key_hex()
    }

    fn sign_bytes(&self, payload: &[u8]) -> Result<Vec<u8>> {
        Ok(self.keypair.sign_bytes(payload).to_bytes().to_vec())
    }
}

pub struct MockTpmKeyProvider {
    keypair: WalletKeypair,
    key_label: String,
}

impl MockTpmKeyProvider {
    pub fn new(keypair: WalletKeypair, key_label: impl Into<String>) -> Self {
        Self {
            keypair,
            key_label: key_label.into(),
        }
    }
}

impl KeyProvider for MockTpmKeyProvider {
    fn provider_id(&self) -> &str {
        "mock-tpm-ed25519"
    }

    fn public_key_hex(&self) -> String {
        self.keypair.verifying_key_hex()
    }

    fn sign_bytes(&self, payload: &[u8]) -> Result<Vec<u8>> {
        if self.key_label.trim().is_empty() {
            return Err(ProtocolError::crypto(
                "mock TPM key label must not be empty".to_string(),
            ));
        }
        Ok(self.keypair.sign_bytes(payload).to_bytes().to_vec())
    }
}

pub struct MockHsmKeyProvider {
    keypair: WalletKeypair,
    slot: u32,
}

impl MockHsmKeyProvider {
    pub fn new(keypair: WalletKeypair, slot: u32) -> Self {
        Self { keypair, slot }
    }
}

impl KeyProvider for MockHsmKeyProvider {
    fn provider_id(&self) -> &str {
        "mock-hsm-ed25519"
    }

    fn public_key_hex(&self) -> String {
        self.keypair.verifying_key_hex()
    }

    fn sign_bytes(&self, payload: &[u8]) -> Result<Vec<u8>> {
        if self.slot == 0 {
            return Err(ProtocolError::crypto(
                "mock HSM slot must be greater than zero".to_string(),
            ));
        }
        Ok(self.keypair.sign_bytes(payload).to_bytes().to_vec())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActionPolicy {
    pub action: String,
    pub required_approvals: usize,
    pub approvers: Vec<String>,
}

impl ActionPolicy {
    pub fn evaluate(&self, signatures: &[String]) -> Result<()> {
        let approvers: HashSet<&str> = self.approvers.iter().map(String::as_str).collect();
        let approvals = signatures
            .iter()
            .map(String::as_str)
            .filter(|sig| approvers.contains(sig))
            .count();
        if approvals < self.required_approvals {
            return Err(ProtocolError::crypto(format!(
                "policy `{}` requires {} approvals; got {}",
                self.action, self.required_approvals, approvals
            )));
        }
        Ok(())
    }
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
    privacy_flag: bool,
    payload_commitment: Option<String>,
    ciphertext_hex: Option<String>,
    nonce_hex: Option<String>,
    salt_hex: Option<String>,
    kdf_params: Option<KdfParams>,
    consent_receipt: Option<ConsentReceipt>,
    author: String,
    timestamp: UnixTimestamp,
}

pub fn sign_entry(draft: EntryDraft, keypair: &WalletKeypair) -> Result<LedgerEntry> {
    let entry_id = Uuid::new_v4();
    let canonical_payload = canonical_json(&draft.payload);
    let payload_commitment = hex::encode(Sha256::digest(canonical_payload.as_bytes()));
    let (entry_payload, ciphertext_hex, nonce_hex, salt_hex, kdf_params, consent_receipt) = if draft
        .privacy_flag
    {
        let passphrase = draft.encryption_passphrase.as_deref().ok_or_else(|| {
            ProtocolError::crypto(
                "privacy_flag=true requires a one-time encryption passphrase".to_string(),
            )
        })?;
        let encrypted = encrypt_payload(&draft.payload, passphrase)?;
        let consent_receipt = ConsentReceipt {
            subject_did: draft.author.clone(),
            data_hash: payload_commitment.clone(),
            policy_ref: "wallet:encrypt-then-commit:v1".to_string(),
            granted_at: draft.timestamp,
            expires_at: draft.timestamp + 30 * 24 * 60 * 60,
        };
        (
            serde_json::json!({ "privacy": "encrypted", "payload_commitment": payload_commitment }),
            Some(encrypted.ciphertext_hex),
            Some(encrypted.nonce_hex),
            Some(encrypted.salt_hex),
            Some(encrypted.kdf_params),
            Some(consent_receipt),
        )
    } else {
        (draft.payload.clone(), None, None, None, None, None)
    };
    let signing_payload = EntrySigningPayload {
        entry_id,
        namespace: draft.namespace.clone(),
        action: draft.action.clone(),
        object_id: draft.object_id.clone(),
        payload: entry_payload.clone(),
        privacy_flag: draft.privacy_flag,
        payload_commitment: Some(payload_commitment.clone()),
        ciphertext_hex: ciphertext_hex.clone(),
        nonce_hex: nonce_hex.clone(),
        salt_hex: salt_hex.clone(),
        kdf_params: kdf_params.clone(),
        consent_receipt: consent_receipt.clone(),
        author: draft.author.clone(),
        timestamp: draft.timestamp,
    };
    let canonical_payload =
        canonical_json(&serde_json::to_value(signing_payload).map_err(|err| {
            ProtocolError::crypto(format!("failed to serialize signing payload: {err}"))
        })?);
    let signature = keypair.sign_bytes(canonical_payload.as_bytes());
    Ok(LedgerEntry {
        entry_id,
        namespace: draft.namespace,
        action: draft.action,
        object_id: draft.object_id,
        payload: entry_payload,
        privacy_flag: draft.privacy_flag,
        payload_commitment: Some(payload_commitment),
        ciphertext_hex,
        nonce_hex,
        salt_hex,
        kdf_params,
        consent_receipt,
        author: draft.author,
        signature: hex::encode(signature.to_bytes()),
        timestamp: draft.timestamp,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EncryptedSecretKey {
    pub ciphertext_hex: String,
    pub salt_hex: String,
    pub nonce_hex: String,
    pub kdf: String,
    pub kdf_params: KdfParams,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub ciphertext_hex: String,
    pub salt_hex: String,
    pub nonce_hex: String,
    pub kdf: String,
    pub kdf_params: KdfParams,
}

pub fn encrypt_payload(payload: &Value, passphrase: &str) -> Result<EncryptedPayload> {
    let canonical_payload = canonical_json(payload);
    let plaintext = canonical_payload.as_bytes();
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let params = Params::new(19456, 2, 1, Some(32))
        .map_err(|err| ProtocolError::crypto(format!("invalid kdf params: {err}")))?;
    let mut derived_key = [0u8; 32];
    let kdf_params = KdfParams {
        memory_kib: params.m_cost(),
        iterations: params.t_cost(),
        parallelism: params.p_cost(),
        output_length: 32,
    };
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    argon2
        .hash_password_into(passphrase.as_bytes(), &salt, &mut derived_key)
        .map_err(|err| ProtocolError::crypto(format!("failed to derive key: {err}")))?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&derived_key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|err| ProtocolError::crypto(format!("failed to encrypt payload: {err}")))?;
    Ok(EncryptedPayload {
        ciphertext_hex: hex::encode(ciphertext),
        salt_hex: hex::encode(salt),
        nonce_hex: hex::encode(nonce),
        kdf: "argon2id".to_string(),
        kdf_params,
    })
}

pub fn decrypt_payload(encrypted: &EncryptedPayload, passphrase: &str) -> Result<Value> {
    if encrypted.kdf != "argon2id" {
        return Err(ProtocolError::crypto(format!(
            "unsupported kdf: {}",
            encrypted.kdf
        )));
    }
    let salt = hex::decode(&encrypted.salt_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid salt hex: {err}")))?;
    let nonce = hex::decode(&encrypted.nonce_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid nonce hex: {err}")))?;
    let ciphertext = hex::decode(&encrypted.ciphertext_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid ciphertext hex: {err}")))?;
    let params = Params::new(
        encrypted.kdf_params.memory_kib,
        encrypted.kdf_params.iterations,
        encrypted.kdf_params.parallelism,
        Some(encrypted.kdf_params.output_length),
    )
    .map_err(|err| ProtocolError::crypto(format!("invalid kdf params: {err}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut derived_key = [0u8; 32];
    argon2
        .hash_password_into(passphrase.as_bytes(), &salt, &mut derived_key)
        .map_err(|err| ProtocolError::crypto(format!("failed to derive key: {err}")))?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&derived_key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
        .map_err(|err| ProtocolError::crypto(format!("failed to decrypt payload: {err}")))?;
    serde_json::from_slice(&plaintext)
        .map_err(|err| ProtocolError::crypto(format!("decrypted payload is invalid JSON: {err}")))
}

pub fn encrypt_secret_key(
    secret_key: [u8; SECRET_KEY_LENGTH],
    password: &str,
) -> Result<EncryptedSecretKey> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let params = Params::new(19456, 2, 1, Some(32))
        .map_err(|err| ProtocolError::crypto(format!("invalid kdf params: {err}")))?;
    let mut derived_key = [0u8; 32];
    let kdf_params = KdfParams {
        memory_kib: params.m_cost(),
        iterations: params.t_cost(),
        parallelism: params.p_cost(),
        output_length: 32,
    };
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    argon2
        .hash_password_into(password.as_bytes(), &salt, &mut derived_key)
        .map_err(|err| ProtocolError::crypto(format!("failed to derive key: {err}")))?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&derived_key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), secret_key.as_slice())
        .map_err(|err| ProtocolError::crypto(format!("failed to encrypt secret key: {err}")))?;
    Ok(EncryptedSecretKey {
        ciphertext_hex: hex::encode(ciphertext),
        salt_hex: hex::encode(salt),
        nonce_hex: hex::encode(nonce),
        kdf: "argon2id".to_string(),
        kdf_params,
    })
}

pub fn decrypt_secret_key(
    encrypted: &EncryptedSecretKey,
    password: &str,
) -> Result<[u8; SECRET_KEY_LENGTH]> {
    if encrypted.kdf != "argon2id" {
        return Err(ProtocolError::crypto(format!(
            "unsupported kdf: {}",
            encrypted.kdf
        )));
    }
    let salt = hex::decode(&encrypted.salt_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid salt hex: {err}")))?;
    let nonce = hex::decode(&encrypted.nonce_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid nonce hex: {err}")))?;
    let ciphertext = hex::decode(&encrypted.ciphertext_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid ciphertext hex: {err}")))?;
    let params = Params::new(
        encrypted.kdf_params.memory_kib,
        encrypted.kdf_params.iterations,
        encrypted.kdf_params.parallelism,
        Some(encrypted.kdf_params.output_length),
    )
    .map_err(|err| ProtocolError::crypto(format!("invalid kdf params: {err}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut derived_key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), &salt, &mut derived_key)
        .map_err(|err| ProtocolError::crypto(format!("failed to derive key: {err}")))?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&derived_key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
        .map_err(|err| ProtocolError::crypto(format!("failed to decrypt secret key: {err}")))?;
    let plaintext_len = plaintext.len();
    let key_bytes: [u8; SECRET_KEY_LENGTH] = plaintext.try_into().map_err(|_| {
        ProtocolError::crypto(format!(
            "invalid decrypted key length: expected {SECRET_KEY_LENGTH} bytes, got {}",
            plaintext_len
        ))
    })?;
    Ok(key_bytes)
}

pub fn verify_entry_signature(entry: &LedgerEntry, verifying_key: &VerifyingKey) -> Result<()> {
    let signing_payload = EntrySigningPayload {
        entry_id: entry.entry_id,
        namespace: entry.namespace.clone(),
        action: entry.action.clone(),
        object_id: entry.object_id.clone(),
        payload: entry.payload.clone(),
        privacy_flag: entry.privacy_flag,
        payload_commitment: entry.payload_commitment.clone(),
        ciphertext_hex: entry.ciphertext_hex.clone(),
        nonce_hex: entry.nonce_hex.clone(),
        salt_hex: entry.salt_hex.clone(),
        kdf_params: entry.kdf_params.clone(),
        consent_receipt: entry.consent_receipt.clone(),
        author: entry.author.clone(),
        timestamp: entry.timestamp,
    };
    let canonical_payload =
        canonical_json(&serde_json::to_value(signing_payload).map_err(|err| {
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

pub fn verify_did_document(document: &DidDocument, expected_did: &str) -> Result<()> {
    if document.did != expected_did {
        return Err(ProtocolError::ValidationFailed(
            "resolved DID does not match expected DID".into(),
        ));
    }
    if !document.did.starts_with("did:") {
        return Err(ProtocolError::ValidationFailed(
            "resolved DID must use did: prefix".into(),
        ));
    }
    if matches!(document.status, DidStatus::Revoked) {
        return Err(ProtocolError::ValidationFailed(
            "resolved DID is revoked".into(),
        ));
    }
    Ok(())
}

pub fn verify_claims_commitment(claims_bytes: &[u8], expected_hash_hex: &str) -> Result<()> {
    let digest = Sha256::digest(claims_bytes);
    let computed = hex::encode(digest);
    if computed == expected_hash_hex {
        Ok(())
    } else {
        Err(ProtocolError::ValidationFailed(
            "claims commitment mismatch".into(),
        ))
    }
}

pub fn verify_consent_receipt_offchain(
    receipt: &ConsentReceipt,
    plaintext_data: &[u8],
    now: UnixTimestamp,
) -> Result<()> {
    if receipt.expires_at <= now {
        return Err(ProtocolError::ValidationFailed(
            "consent receipt expired".into(),
        ));
    }
    verify_claims_commitment(plaintext_data, &receipt.data_hash)
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
            privacy_flag: false,
            encryption_passphrase: None,
            author: "did:ledger:abc".to_string(),
            timestamp: 1_736_500_000,
        };
        let entry = sign_entry(draft, &keypair).expect("sign entry");
        verify_entry_signature(&entry, keypair.verifying_key()).expect("verify signature");
    }

    #[test]
    fn encrypts_and_decrypts_secret_key() {
        let keypair = WalletKeypair::generate();
        let encrypted =
            encrypt_secret_key(keypair.secret_key_bytes(), "password").expect("encrypt secret key");
        let decrypted = decrypt_secret_key(&encrypted, "password").expect("decrypt secret key");
        assert_eq!(decrypted, keypair.secret_key_bytes());
    }

    #[test]
    fn encrypts_and_decrypts_payload() {
        let payload = json!({"email":"alice@example.org","tier":"restricted"});
        let encrypted = encrypt_payload(&payload, "p@ssphrase").expect("encrypt payload");
        let decrypted = decrypt_payload(&encrypted, "p@ssphrase").expect("decrypt payload");
        assert_eq!(decrypted, payload);
    }

    #[test]
    fn signs_and_verifies_private_entry() {
        let keypair = WalletKeypair::generate();
        let draft = EntryDraft {
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-1".to_string(),
            payload: json!({"document_hash":"abc123","event":"BID_OPENED"}),
            privacy_flag: true,
            encryption_passphrase: Some("wallet-private-passphrase".to_string()),
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_001,
        };
        let entry = sign_entry(draft, &keypair).expect("sign private entry");
        assert!(entry.privacy_flag);
        assert!(entry.ciphertext_hex.is_some());
        assert!(entry.payload_commitment.is_some());
        assert!(entry.consent_receipt.is_some());
        verify_entry_signature(&entry, keypair.verifying_key()).expect("verify signature");
    }

    #[test]
    fn software_provider_signs_payload() {
        let keypair = WalletKeypair::generate();
        let provider = SoftwareKeyProvider::new(keypair);
        let sig = provider.sign_bytes(b"citizen").expect("sign payload");
        assert_eq!(sig.len(), 64);
    }

    #[test]
    fn action_policy_checks_threshold() {
        let policy = ActionPolicy {
            action: "REMOVE_VALIDATOR".to_string(),
            required_approvals: 2,
            approvers: vec!["validator-a".to_string(), "validator-b".to_string()],
        };
        policy
            .evaluate(&["validator-a".to_string(), "validator-b".to_string()])
            .expect("policy approved");
        assert!(policy.evaluate(&["validator-a".to_string()]).is_err());
    }

    #[test]
    fn mock_tpm_provider_signs_payload() {
        let keypair = WalletKeypair::generate();
        let provider = MockTpmKeyProvider::new(keypair, "tpm-key-1");
        let sig = provider.sign_bytes(b"citizen").expect("sign payload");
        assert_eq!(sig.len(), 64);
    }

    #[test]
    fn mock_hsm_provider_signs_payload() {
        let keypair = WalletKeypair::generate();
        let provider = MockHsmKeyProvider::new(keypair, 7);
        let sig = provider.sign_bytes(b"citizen").expect("sign payload");
        assert_eq!(sig.len(), 64);
    }

    #[test]
    fn verifies_active_did_document() {
        let document = DidDocument {
            did: "did:ledger:alice".into(),
            controller: "did:ledger:alice".into(),
            status: DidStatus::Active,
            claims_hash: Some("abc".into()),
            updated_at: 1_736_500_000,
        };
        verify_did_document(&document, "did:ledger:alice").expect("active did should verify");
    }

    #[test]
    fn rejects_revoked_did_document() {
        let document = DidDocument {
            did: "did:ledger:alice".into(),
            controller: "did:ledger:alice".into(),
            status: DidStatus::Revoked,
            claims_hash: None,
            updated_at: 1_736_500_000,
        };
        assert!(verify_did_document(&document, "did:ledger:alice").is_err());
    }

    #[test]
    fn verifies_consent_receipt_commitment() {
        let data = br#"{"email":"alice@example.org"}"#;
        let digest = hex::encode(Sha256::digest(data));
        let receipt = ConsentReceipt {
            subject_did: "did:ledger:alice".into(),
            data_hash: digest,
            policy_ref: "policy:v1".into(),
            granted_at: 1_736_500_000,
            expires_at: 1_736_503_600,
        };
        verify_consent_receipt_offchain(&receipt, data, 1_736_500_100)
            .expect("consent receipt should verify");
    }
}
