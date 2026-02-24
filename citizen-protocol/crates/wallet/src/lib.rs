use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce, XChaCha20Poly1305, XNonce,
};
use citizen_types::{
    ConsentReceipt, DidDocument, DidStatus, KdfParams, KeyWrap, LedgerEntry, PrivacyMode,
    ProtocolError, RevocationEvent, UnixTimestamp,
};
use ed25519_dalek::{
    Signature, Signer, SigningKey, VerifyingKey, PUBLIC_KEY_LENGTH, SECRET_KEY_LENGTH,
};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

pub type Result<T> = std::result::Result<T, ProtocolError>;

pub mod cli;
pub mod privacy;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntryDraft {
    pub namespace: String,
    pub action: String,
    pub object_id: String,
    pub payload: Value,
    #[serde(default)]
    pub privacy_flag: bool,
    #[serde(default)]
    pub privacy_mode: PrivacyMode,
    #[serde(skip_serializing, skip_deserializing)]
    pub encryption_passphrase: Option<String>,
    #[serde(default)]
    pub authorized_readers: Vec<String>,
    pub custodian_policy_id: Option<String>,
    #[serde(default)]
    pub key_wrapped_secrets: Vec<KeyWrap>,
    #[serde(default)]
    pub revocation_events: Vec<RevocationEvent>,
    #[serde(default)]
    pub field_reader_acls: BTreeMap<String, Vec<String>>,
    #[serde(skip_serializing, skip_deserializing)]
    pub reader_public_keys: BTreeMap<String, String>,
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
    privacy_mode: PrivacyMode,
    authorized_readers: Vec<String>,
    custodian_policy_id: Option<String>,
    key_wrapped_secrets: Vec<KeyWrap>,
    revocation_events: Vec<RevocationEvent>,
    field_reader_acls: BTreeMap<String, Vec<String>>,
    author: String,
    timestamp: UnixTimestamp,
}

pub fn sign_entry(draft: EntryDraft, keypair: &WalletKeypair) -> Result<LedgerEntry> {
    let entry_id = Uuid::new_v4();
    let canonical_payload = canonical_json(&draft.payload);
    let payload_commitment = hex::encode(Sha256::digest(canonical_payload.as_bytes()));
    let resolved_privacy_mode = if draft.privacy_mode == PrivacyMode::None && draft.privacy_flag {
        PrivacyMode::Passphrase
    } else {
        draft.privacy_mode.clone()
    };

    let (
        entry_payload,
        ciphertext_hex,
        nonce_hex,
        salt_hex,
        kdf_params,
        consent_receipt,
        key_wrapped_secrets,
        field_reader_acls,
    ) = match resolved_privacy_mode {
        PrivacyMode::Passphrase => {
            let passphrase = draft.encryption_passphrase.as_deref().ok_or_else(|| {
                ProtocolError::crypto(
                    "privacy_flag=true requires a one-time encryption passphrase".to_string(),
                )
            })?;
            let (payload_to_encrypt, entry_payload) =
                build_privacy_payload(&draft.payload, &payload_commitment)?;
            let field_reader_acls = normalize_field_reader_acls(
                &draft.payload,
                &draft.authorized_readers,
                &draft.field_reader_acls,
            )?;
            let encrypted = encrypt_payload(&payload_to_encrypt, passphrase)?;
            let consent_receipt = ConsentReceipt {
                subject_did: draft.author.clone(),
                data_hash: payload_commitment.clone(),
                policy_ref: "wallet:encrypt-then-commit:v1".to_string(),
                granted_at: draft.timestamp,
                expires_at: draft.timestamp + 30 * 24 * 60 * 60,
                authorized_readers: draft.authorized_readers.clone(),
                custodian_policy_id: draft.custodian_policy_id.clone(),
                field_reader_acls: field_reader_acls.clone(),
            };
            (
                entry_payload,
                Some(encrypted.ciphertext_hex),
                Some(encrypted.nonce_hex),
                Some(encrypted.salt_hex),
                Some(encrypted.kdf_params),
                Some(consent_receipt),
                draft.key_wrapped_secrets.clone(),
                field_reader_acls,
            )
        }
        PrivacyMode::Hybrid => {
            let (payload_to_encrypt, entry_payload) =
                build_privacy_payload(&draft.payload, &payload_commitment)?;
            let field_reader_acls = normalize_field_reader_acls(
                &draft.payload,
                &draft.authorized_readers,
                &draft.field_reader_acls,
            )?;
            let dek = privacy::generate_dek();
            let encrypted = encrypt_payload_with_dek(&payload_to_encrypt, &dek)?;
            let author_secret = x25519_secret_from_wallet(keypair);

            let mut wrapped = Vec::new();
            for reader_id in &draft.authorized_readers {
                let reader_key_hex = draft.reader_public_keys.get(reader_id).ok_or_else(|| {
                    ProtocolError::ValidationFailed(format!(
                        "missing reader public key for authorized reader `{reader_id}`"
                    ))
                })?;
                let reader_pubkey = parse_x25519_public_key(reader_key_hex)?;
                let wrapped_dek = privacy::wrap_dek_for_reader(&dek, &author_secret, &reader_pubkey)?;
                wrapped.push(KeyWrap {
                    reader_id: reader_id.clone(),
                    wrapped_dek,
                    wrap_algorithm: "x25519-xchacha20poly1305".to_string(),
                });
            }

            if wrapped.is_empty() {
                return Err(ProtocolError::ValidationFailed(
                    "hybrid privacy mode requires at least one authorized reader".into(),
                ));
            }

            let consent_receipt = ConsentReceipt {
                subject_did: draft.author.clone(),
                data_hash: payload_commitment.clone(),
                policy_ref: "wallet:hybrid-encrypt-then-commit:v2".to_string(),
                granted_at: draft.timestamp,
                expires_at: draft.timestamp + 30 * 24 * 60 * 60,
                authorized_readers: draft.authorized_readers.clone(),
                custodian_policy_id: draft.custodian_policy_id.clone(),
                field_reader_acls: field_reader_acls.clone(),
            };

            (
                entry_payload,
                Some(encrypted.ciphertext_hex),
                Some(encrypted.nonce_hex),
                None,
                None,
                Some(consent_receipt),
                wrapped,
                field_reader_acls,
            )
        }
        PrivacyMode::None => (draft.payload.clone(), None, None, None, None, None, Vec::new(), BTreeMap::new()),
    };
    let signing_payload = EntrySigningPayload {
        entry_id,
        namespace: draft.namespace.clone(),
        action: draft.action.clone(),
        object_id: draft.object_id.clone(),
        payload: entry_payload.clone(),
        privacy_flag: resolved_privacy_mode != PrivacyMode::None,
        payload_commitment: Some(payload_commitment.clone()),
        ciphertext_hex: ciphertext_hex.clone(),
        nonce_hex: nonce_hex.clone(),
        salt_hex: salt_hex.clone(),
        kdf_params: kdf_params.clone(),
        consent_receipt: consent_receipt.clone(),
        privacy_mode: resolved_privacy_mode.clone(),
        authorized_readers: draft.authorized_readers.clone(),
        custodian_policy_id: draft.custodian_policy_id.clone(),
        key_wrapped_secrets: key_wrapped_secrets.clone(),
        revocation_events: draft.revocation_events.clone(),
        field_reader_acls: field_reader_acls.clone(),
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
        privacy_flag: resolved_privacy_mode != PrivacyMode::None,
        privacy_mode: resolved_privacy_mode,
        payload_commitment: Some(payload_commitment),
        ciphertext_hex,
        nonce_hex,
        salt_hex,
        kdf_params,
        consent_receipt,
        authorized_readers: draft.authorized_readers,
        custodian_policy_id: draft.custodian_policy_id,
        key_wrapped_secrets,
        revocation_events: draft.revocation_events,
        field_reader_acls,
        author: draft.author,
        signature: hex::encode(signature.to_bytes()),
        timestamp: draft.timestamp,
    })
}

fn build_privacy_payload(payload: &Value, payload_commitment: &str) -> Result<(Value, Value)> {
    if let Some(selective) = parse_selective_payload(payload)? {
        let public_fields_commitment = hex::encode(Sha256::digest(
            canonical_json(&selective.public_fields).as_bytes(),
        ));
        let encrypted_fields_commitment = hex::encode(Sha256::digest(
            canonical_json(&selective.private_fields).as_bytes(),
        ));
        let entry_payload = serde_json::json!({
            "privacy": "selective-encrypted",
            "privacy_mode": "field_selective_v1",
            "public_fields": selective.public_fields,
            "public_allowlist": selective.public_allowlist,
            "public_fields_commitment": public_fields_commitment,
            "encrypted_fields_commitment": encrypted_fields_commitment,
            "payload_commitment": payload_commitment,
        });
        return Ok((selective.private_fields, entry_payload));
    }

    Ok((
        payload.clone(),
        serde_json::json!({ "privacy": "encrypted", "payload_commitment": payload_commitment }),
    ))
}

struct SelectivePayload {
    public_fields: Value,
    private_fields: Value,
    public_allowlist: Vec<String>,
}

fn parse_selective_payload(payload: &Value) -> Result<Option<SelectivePayload>> {
    let Some(obj) = payload.as_object() else {
        return Ok(None);
    };
    let Some(public_fields) = obj.get("public_fields") else {
        return Ok(None);
    };
    let Some(private_fields) = obj.get("private_fields") else {
        return Ok(None);
    };
    if !public_fields.is_object() || !private_fields.is_object() {
        return Err(ProtocolError::ValidationFailed(
            "selective privacy payload requires object public_fields and private_fields".into(),
        ));
    }

    let allowlist = obj
        .get("public_allowlist")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ProtocolError::ValidationFailed(
                "selective privacy payload requires public_allowlist string array".into(),
            )
        })?;
    let mut normalized_allowlist: Vec<String> = allowlist
        .iter()
        .map(|field| {
            field.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "public_allowlist values must all be strings".into(),
                )
            })
        })
        .collect::<Result<Vec<_>>>()?;
    normalized_allowlist.sort();
    normalized_allowlist.dedup();

    let public_map = public_fields
        .as_object()
        .expect("public_fields object already verified");
    if normalized_allowlist.len() != public_map.len() {
        return Err(ProtocolError::ValidationFailed(
            "public_allowlist must exactly match public_fields keys".into(),
        ));
    }
    for field in &normalized_allowlist {
        if !public_map.contains_key(field) {
            return Err(ProtocolError::ValidationFailed(
                "public_allowlist must exactly match public_fields keys".into(),
            ));
        }
    }

    let mut normalized_public = Map::new();
    for field in &normalized_allowlist {
        if let Some(value) = public_map.get(field) {
            normalized_public.insert(field.clone(), value.clone());
        }
    }

    Ok(Some(SelectivePayload {
        public_fields: Value::Object(normalized_public),
        private_fields: private_fields.clone(),
        public_allowlist: normalized_allowlist,
    }))
}

fn normalize_field_reader_acls(
    payload: &Value,
    authorized_readers: &[String],
    provided_acls: &BTreeMap<String, Vec<String>>,
) -> Result<BTreeMap<String, Vec<String>>> {
    if provided_acls.is_empty() {
        return Ok(BTreeMap::new());
    }
    let selective = parse_selective_payload(payload)?.ok_or_else(|| {
        ProtocolError::ValidationFailed(
            "field_reader_acls requires selective payload with private_fields".into(),
        )
    })?;
    let private = selective
        .private_fields
        .as_object()
        .ok_or_else(|| ProtocolError::ValidationFailed("private_fields must be an object".into()))?;
    let authorized: std::collections::HashSet<&str> =
        authorized_readers.iter().map(String::as_str).collect();
    let mut normalized = BTreeMap::new();
    for (field, readers) in provided_acls {
        if !private.contains_key(field) {
            return Err(ProtocolError::ValidationFailed(format!(
                "field_reader_acls includes unknown private field `{field}`"
            )));
        }
        if readers.is_empty() {
            return Err(ProtocolError::ValidationFailed(format!(
                "field_reader_acls[{field}] must include at least one reader"
            )));
        }
        let mut list = readers.clone();
        list.sort();
        list.dedup();
        if !list.iter().all(|r| authorized.contains(r.as_str())) {
            return Err(ProtocolError::ValidationFailed(
                "field_reader_acls readers must be present in authorized_readers".into(),
            ));
        }
        normalized.insert(field.clone(), list);
    }
    Ok(normalized)
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

pub fn decrypt_payload_with_hybrid(
    entry: &LedgerEntry,
    caller_did: &str,
    caller_private_key_hex: &str,
    author_public_key_hex: &str,
) -> Result<Value> {
    let key_wrap = entry
        .key_wrapped_secrets
        .iter()
        .find(|wrap| wrap.reader_id == caller_did)
        .ok_or_else(|| ProtocolError::ValidationFailed("no DEK wrap found for caller DID".into()))?;
    if key_wrap.wrap_algorithm != "x25519-xchacha20poly1305" {
        return Err(ProtocolError::ValidationFailed(
            "unsupported DEK wrap algorithm".into(),
        ));
    }
    let caller_secret = parse_x25519_secret_key(caller_private_key_hex)?;
    let author_pubkey = parse_x25519_public_key(author_public_key_hex)?;
    let dek = privacy::unwrap_dek_for_reader(&key_wrap.wrapped_dek, &caller_secret, &author_pubkey)?;
    let encrypted = EncryptedPayload {
        ciphertext_hex: entry
            .ciphertext_hex
            .clone()
            .ok_or_else(|| ProtocolError::ValidationFailed("hybrid entry missing ciphertext".into()))?,
        salt_hex: String::new(),
        nonce_hex: entry
            .nonce_hex
            .clone()
            .ok_or_else(|| ProtocolError::ValidationFailed("hybrid entry missing nonce".into()))?,
        kdf: "hybrid-dek".to_string(),
        kdf_params: KdfParams {
            memory_kib: 0,
            iterations: 0,
            parallelism: 0,
            output_length: 32,
        },
    };
    decrypt_payload_with_dek(&encrypted, &dek)
}

fn encrypt_payload_with_dek(payload: &Value, dek: &[u8; 32]) -> Result<EncryptedPayload> {
    let canonical_payload = canonical_json(payload);
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new_from_slice(dek)
        .map_err(|err| ProtocolError::crypto(format!("invalid DEK: {err}")))?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), canonical_payload.as_bytes())
        .map_err(|err| ProtocolError::crypto(format!("failed to encrypt payload with DEK: {err}")))?;
    Ok(EncryptedPayload {
        ciphertext_hex: hex::encode(ciphertext),
        salt_hex: String::new(),
        nonce_hex: hex::encode(nonce),
        kdf: "hybrid-dek".to_string(),
        kdf_params: KdfParams {
            memory_kib: 0,
            iterations: 0,
            parallelism: 0,
            output_length: 32,
        },
    })
}

fn decrypt_payload_with_dek(encrypted: &EncryptedPayload, dek: &[u8; 32]) -> Result<Value> {
    let nonce = hex::decode(&encrypted.nonce_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid nonce hex: {err}")))?;
    if nonce.len() != 24 {
        return Err(ProtocolError::crypto(
            "hybrid nonce must be 24 bytes for XChaCha20-Poly1305".to_string(),
        ));
    }
    let ciphertext = hex::decode(&encrypted.ciphertext_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid ciphertext hex: {err}")))?;
    let cipher = XChaCha20Poly1305::new_from_slice(dek)
        .map_err(|err| ProtocolError::crypto(format!("invalid DEK: {err}")))?;
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_slice())
        .map_err(|err| ProtocolError::crypto(format!("failed to decrypt hybrid payload: {err}")))?;
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
        privacy_mode: entry.privacy_mode.clone(),
        authorized_readers: entry.authorized_readers.clone(),
        custodian_policy_id: entry.custodian_policy_id.clone(),
        key_wrapped_secrets: entry.key_wrapped_secrets.clone(),
        revocation_events: entry.revocation_events.clone(),
        field_reader_acls: entry.field_reader_acls.clone(),
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

fn parse_x25519_public_key(encoded: &str) -> Result<X25519PublicKey> {
    let bytes = hex::decode(encoded)
        .map_err(|err| ProtocolError::crypto(format!("invalid x25519 public key hex: {err}")))?;
    let key_bytes: [u8; 32] = bytes.try_into().map_err(|_| {
        ProtocolError::crypto("x25519 public key must be 32 bytes".to_string())
    })?;
    Ok(X25519PublicKey::from(key_bytes))
}

fn parse_x25519_secret_key(encoded: &str) -> Result<StaticSecret> {
    let bytes = hex::decode(encoded)
        .map_err(|err| ProtocolError::crypto(format!("invalid x25519 secret key hex: {err}")))?;
    let key_bytes: [u8; 32] = bytes.try_into().map_err(|_| {
        ProtocolError::crypto("x25519 secret key must be 32 bytes".to_string())
    })?;
    Ok(StaticSecret::from(key_bytes))
}

fn x25519_secret_from_wallet(keypair: &WalletKeypair) -> StaticSecret {
    StaticSecret::from(keypair.secret_key_bytes())
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
            privacy_mode: PrivacyMode::None,
            encryption_passphrase: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys: BTreeMap::new(),
            author: "did:ledger:abc".to_string(),
            timestamp: 1_736_500_000,
        };
        let entry = sign_entry(draft, &keypair).expect("sign entry");
        verify_entry_signature(&entry, keypair.verifying_key()).expect("verify signature");
        println!(
            "SAMPLE_PUBLIC_ENTRY={}\n",
            serde_json::to_string_pretty(&entry).expect("serialize public entry sample")
        );
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
            privacy_mode: PrivacyMode::Passphrase,
            encryption_passphrase: Some("wallet-private-passphrase".to_string()),
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys: BTreeMap::new(),
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
    fn signs_selective_private_entry_with_public_allowlist() {
        let keypair = WalletKeypair::generate();
        let draft = EntryDraft {
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-2".to_string(),
            payload: json!({
                "public_fields": {"event": "BID_OPENED", "document_hash": "abc123"},
                "private_fields": {"bidder_email": "alice@example.org", "amount": 1200},
                "public_allowlist": ["document_hash", "event"]
            }),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Passphrase,
            encryption_passphrase: Some("wallet-private-passphrase".to_string()),
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys: BTreeMap::new(),
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_101,
        };
        let entry = sign_entry(draft, &keypair).expect("sign selective private entry");
        assert_eq!(
            entry.payload.get("privacy_mode").and_then(Value::as_str),
            Some("field_selective_v1")
        );
        assert!(entry.ciphertext_hex.is_some());
        verify_entry_signature(&entry, keypair.verifying_key()).expect("verify signature");
    }

    #[test]
    fn signs_and_decrypts_hybrid_private_entry() {
        let author = WalletKeypair::generate();
        let reader_secret = StaticSecret::from([7u8; 32]);
        let reader_public = X25519PublicKey::from(&reader_secret);

        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert("did:ledger:reader".to_string(), hex::encode(reader_public.as_bytes()));

        let draft = EntryDraft {
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-3".to_string(),
            payload: json!({"document_hash":"abc123","event":"BID_OPENED"}),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Hybrid,
            encryption_passphrase: None,
            authorized_readers: vec!["did:ledger:reader".to_string()],
            custodian_policy_id: Some("custodian.policy.v1".to_string()),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys,
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_111,
        };
        let entry = sign_entry(draft, &author).expect("sign hybrid private entry");
        assert_eq!(entry.privacy_mode, PrivacyMode::Hybrid);
        assert_eq!(entry.key_wrapped_secrets.len(), 1);

        let decrypted = decrypt_payload_with_hybrid(
            &entry,
            "did:ledger:reader",
            &hex::encode(reader_secret.to_bytes()),
            &hex::encode(X25519PublicKey::from(&x25519_secret_from_wallet(&author)).as_bytes()),
        )
        .expect("decrypt hybrid entry");
        assert_eq!(decrypted, json!({"document_hash":"abc123","event":"BID_OPENED"}));

        println!(
            "SAMPLE_WHOLE_PAYLOAD_ENTRY={}\n",
            serde_json::to_string_pretty(&entry).expect("serialize whole-payload entry sample")
        );
    }


    #[test]
    fn hybrid_selective_entry_supports_field_reader_acls() {
        let author = WalletKeypair::generate();
        let reader_secret = StaticSecret::from([9u8; 32]);
        let reader_public = X25519PublicKey::from(&reader_secret);

        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert("did:ledger:reader".to_string(), hex::encode(reader_public.as_bytes()));

        let mut field_reader_acls = BTreeMap::new();
        field_reader_acls.insert("bidder_email".to_string(), vec!["did:ledger:reader".to_string()]);

        let draft = EntryDraft {
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-4".to_string(),
            payload: json!({
                "public_fields": {"event": "BID_OPENED", "document_hash": "abc123"},
                "private_fields": {"bidder_email": "alice@example.org", "amount": 1200},
                "public_allowlist": ["document_hash", "event"]
            }),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Hybrid,
            encryption_passphrase: None,
            authorized_readers: vec!["did:ledger:reader".to_string()],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls,
            reader_public_keys,
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_112,
        };

        let entry = sign_entry(draft, &author).expect("sign selective hybrid entry");
        assert_eq!(entry.payload.get("privacy_mode").and_then(Value::as_str), Some("field_selective_v1"));
        assert_eq!(entry.field_reader_acls.get("bidder_email").map(Vec::len), Some(1));

        println!(
            "SAMPLE_PER_FIELD_ENTRY={}\n",
            serde_json::to_string_pretty(&entry).expect("serialize per-field entry sample")
        );
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
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: Default::default(),
        };
        verify_consent_receipt_offchain(&receipt, data, 1_736_500_100)
            .expect("consent receipt should verify");
    }
}
