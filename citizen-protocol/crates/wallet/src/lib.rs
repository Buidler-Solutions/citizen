use argon2::{Algorithm, Argon2, Params, Version};
use bip39::{Language, Mnemonic};
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
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::TryRngCore;
use rand_core::OsRng as DalekOsRng;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::{Cursor, Read, Write};
use uuid::Uuid;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

pub type Result<T> = std::result::Result<T, ProtocolError>;

pub mod cli;
pub mod privacy;

fn fill_os_random(dest: &mut [u8]) {
    let mut rng = OsRng;
    rng.try_fill_bytes(dest)
        .expect("os randomness source unavailable");
}

const DEFAULT_HARDENED_DERIVATION_PATH: &str = "m/44'/930'/0'/0'/0'";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NamespaceFieldPolicy {
    pub namespace: String,
    pub policy_version: u32,
    #[serde(default)]
    pub public_fields: Vec<String>,
    #[serde(default)]
    pub committed_fields: Vec<String>,
    #[serde(default)]
    pub offchain_encrypted_fields: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PayloadFieldCommitment {
    pub field_path: String,
    pub canonical_value: String,
    pub commitment_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PolicyPartitionedPayload {
    pub namespace: String,
    pub policy_version: u32,
    pub public_fields: BTreeMap<String, Value>,
    pub committed_fields: BTreeMap<String, PayloadFieldCommitment>,
    pub offchain_encrypted_fields: BTreeMap<String, Value>,
}

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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WrcpMsigV1Proof {
    pub approver: String,
    pub public_key: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WrcpMsigV1Issue {
    pub reason_code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WrcpMsigV1DryRunReport {
    pub ok: bool,
    pub required_approvals: usize,
    pub unique_approvals: usize,
    pub errors: Vec<WrcpMsigV1Issue>,
    pub warnings: Vec<WrcpMsigV1Issue>,
}

impl WalletKeypair {
    pub fn generate() -> Self {
        let mut rng = DalekOsRng;
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

    pub fn from_mnemonic(
        key_id: Uuid,
        mnemonic_phrase: &str,
        passphrase: Option<&str>,
        derivation_path: Option<&str>,
    ) -> Result<Self> {
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, mnemonic_phrase)
            .map_err(|err| ProtocolError::crypto(format!("invalid mnemonic phrase: {err}")))?;
        let seed = mnemonic.to_seed_normalized(passphrase.unwrap_or_default());
        let secret = derive_ed25519_slip10_secret(
            &seed,
            derivation_path.unwrap_or(DEFAULT_HARDENED_DERIVATION_PATH),
        )?;
        Self::from_secret_bytes(key_id, &secret)
    }
}

pub fn generate_mnemonic_phrase(word_count: usize) -> Result<String> {
    let entropy_len = match word_count {
        12 => 16,
        15 => 20,
        18 => 24,
        21 => 28,
        24 => 32,
        _ => {
            return Err(ProtocolError::crypto(
                "mnemonic word count must be one of 12, 15, 18, 21, or 24".to_string(),
            ))
        }
    };
    let mut entropy = vec![0u8; entropy_len];
    fill_os_random(&mut entropy);
    let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
        .map_err(|err| ProtocolError::crypto(format!("failed to generate mnemonic: {err}")))?;
    Ok(mnemonic.to_string())
}

fn derive_ed25519_slip10_secret(seed: &[u8], derivation_path: &str) -> Result<[u8; 32]> {
    // SLIP-0010 for Ed25519 uses HMAC-SHA512.
    type HmacSha512Real = Hmac<sha2::Sha512>;

    let segments = parse_hardened_derivation_path(derivation_path)?;
    let mut mac = <HmacSha512Real as Mac>::new_from_slice(b"ed25519 seed")
        .map_err(|err| ProtocolError::crypto(format!("failed to init HMAC: {err}")))?;
    mac.update(seed);
    let master = mac.finalize().into_bytes();
    let mut secret = [0u8; 32];
    let mut chain_code = [0u8; 32];
    secret.copy_from_slice(&master[..32]);
    chain_code.copy_from_slice(&master[32..]);

    for index in segments {
        let mut data = Vec::with_capacity(1 + 32 + 4);
        data.push(0u8);
        data.extend_from_slice(&secret);
        data.extend_from_slice(&(index | 0x8000_0000).to_be_bytes());

        let mut step_mac = <HmacSha512Real as Mac>::new_from_slice(&chain_code)
            .map_err(|err| ProtocolError::crypto(format!("failed to init child HMAC: {err}")))?;
        step_mac.update(&data);
        let output = step_mac.finalize().into_bytes();
        secret.copy_from_slice(&output[..32]);
        chain_code.copy_from_slice(&output[32..]);
    }

    Ok(secret)
}

fn parse_hardened_derivation_path(path: &str) -> Result<Vec<u32>> {
    if !path.starts_with("m/") {
        return Err(ProtocolError::crypto(format!(
            "invalid derivation path `{path}`: expected `m/...`"
        )));
    }
    let mut out = Vec::new();
    for segment in path.split('/').skip(1) {
        if segment.is_empty() {
            return Err(ProtocolError::crypto(format!(
                "invalid derivation path `{path}`: empty segment"
            )));
        }
        if !segment.ends_with('\'') {
            return Err(ProtocolError::crypto(format!(
                "invalid derivation path `{path}`: only hardened segments are supported (append ')"
            )));
        }
        let raw = &segment[..segment.len() - 1];
        let value: u32 = raw.parse().map_err(|_| {
            ProtocolError::crypto(format!(
                "invalid derivation path `{path}`: non-numeric segment `{segment}`"
            ))
        })?;
        if value >= 0x8000_0000 {
            return Err(ProtocolError::crypto(format!(
                "invalid derivation path `{path}`: segment out of range `{segment}`"
            )));
        }
        out.push(value);
    }
    if out.is_empty() {
        return Err(ProtocolError::crypto(format!(
            "invalid derivation path `{path}`: at least one hardened segment is required"
        )));
    }
    Ok(out)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WrcpTxV1SigningPayload {
    pub entry_id: Uuid,
    pub namespace: String,
    pub action: String,
    pub object_id: String,
    pub payload: Value,
    pub privacy_flag: bool,
    pub payload_commitment: Option<String>,
    pub ciphertext_hex: Option<String>,
    pub nonce_hex: Option<String>,
    pub salt_hex: Option<String>,
    pub kdf_params: Option<KdfParams>,
    pub consent_receipt: Option<ConsentReceipt>,
    pub privacy_mode: PrivacyMode,
    pub authorized_readers: Vec<String>,
    pub custodian_policy_id: Option<String>,
    pub key_wrapped_secrets: Vec<KeyWrap>,
    pub revocation_events: Vec<RevocationEvent>,
    pub field_reader_acls: BTreeMap<String, Vec<String>>,
    pub author: String,
    pub timestamp: UnixTimestamp,
}

pub fn build_wrcp_tx_v1_signing_payload(entry: &LedgerEntry) -> WrcpTxV1SigningPayload {
    WrcpTxV1SigningPayload {
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
    }
}

pub fn wrcp_tx_v1_canonical_json(payload: &WrcpTxV1SigningPayload) -> Result<String> {
    Ok(canonical_json(&serde_json::to_value(payload).map_err(
        |err| {
            ProtocolError::crypto(format!(
                "failed to serialize WRCP-TX-V1 signing payload: {err}"
            ))
        },
    )?))
}

pub fn sign_entry(draft: EntryDraft, keypair: &WalletKeypair) -> Result<LedgerEntry> {
    let entry_id = Uuid::new_v4();
    let normalized_authorized_readers = normalize_authorized_readers(&draft.authorized_readers);
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
                authorized_readers: normalized_authorized_readers.clone(),
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
                &normalized_authorized_readers,
                &draft.field_reader_acls,
            )?;
            let dek = privacy::generate_dek();
            let encrypted = encrypt_payload_with_dek(&payload_to_encrypt, &dek)?;
            let author_secret = x25519_secret_from_wallet(keypair);

            let mut wrapped = Vec::new();
            for reader_id in &normalized_authorized_readers {
                let reader_key_hex = draft.reader_public_keys.get(reader_id).ok_or_else(|| {
                    ProtocolError::ValidationFailed(format!(
                        "missing reader public key for authorized reader `{reader_id}`"
                    ))
                })?;
                let reader_pubkey = parse_x25519_public_key(reader_key_hex)?;
                let wrapped_dek = privacy::wrap_dek_for_reader(
                    &dek,
                    &author_secret,
                    &reader_pubkey,
                    &format!("{entry_id}:{reader_id}"),
                )?;
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
                authorized_readers: normalized_authorized_readers.clone(),
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
        PrivacyMode::None => (
            draft.payload.clone(),
            None,
            None,
            None,
            None,
            None,
            Vec::new(),
            BTreeMap::new(),
        ),
    };
    let signing_payload = WrcpTxV1SigningPayload {
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
        authorized_readers: normalized_authorized_readers.clone(),
        custodian_policy_id: draft.custodian_policy_id.clone(),
        key_wrapped_secrets: key_wrapped_secrets.clone(),
        revocation_events: draft.revocation_events.clone(),
        field_reader_acls: field_reader_acls.clone(),
        author: draft.author.clone(),
        timestamp: draft.timestamp,
    };
    let canonical_payload = wrcp_tx_v1_canonical_json(&signing_payload)?;
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
        authorized_readers: normalized_authorized_readers,
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
    let private = selective.private_fields.as_object().ok_or_else(|| {
        ProtocolError::ValidationFailed("private_fields must be an object".into())
    })?;
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

fn normalize_authorized_readers(authorized_readers: &[String]) -> Vec<String> {
    let mut normalized = authorized_readers.to_vec();
    normalized.sort();
    normalized.dedup();
    normalized
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EncryptedFileMetadata {
    pub salt_hex: String,
    pub nonce_prefix_hex: String,
    pub kdf: String,
    pub kdf_params: KdfParams,
    pub chunk_size_bytes: u32,
    pub ciphertext_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HybridEncryptedFileMetadata {
    pub nonce_prefix_hex: String,
    pub chunk_size_bytes: u32,
    pub ciphertext_hash: String,
    pub author_public_key_hex: String,
    pub key_wrapped_secrets: Vec<KeyWrap>,
}

const OFFCHAIN_FILE_CHUNK_SIZE_BYTES: usize = 64 * 1024;

pub fn encrypt_offchain_file_reader_to_writer<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    passphrase: &str,
) -> Result<EncryptedFileMetadata> {
    let mut salt = [0u8; 16];
    fill_os_random(&mut salt);
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

    let mut nonce_prefix = [0u8; 4];
    fill_os_random(&mut nonce_prefix);
    let mut hasher = Sha256::new();
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&derived_key));
    let mut chunk = vec![0_u8; OFFCHAIN_FILE_CHUNK_SIZE_BYTES];
    let mut index: u64 = 0;

    loop {
        let read = reader.read(&mut chunk).map_err(|err| {
            ProtocolError::crypto(format!("failed to read plaintext file: {err}"))
        })?;
        if read == 0 {
            break;
        }

        let nonce = chunk_nonce(&nonce_prefix, index);
        let aad = index.to_be_bytes();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                chacha20poly1305::aead::Payload {
                    msg: &chunk[..read],
                    aad: &aad,
                },
            )
            .map_err(|err| ProtocolError::crypto(format!("failed to encrypt file chunk: {err}")))?;

        let frame_len = (ciphertext.len() as u32).to_be_bytes();
        writer
            .write_all(&frame_len)
            .and_then(|_| writer.write_all(&ciphertext))
            .map_err(|err| ProtocolError::crypto(format!("failed to write ciphertext: {err}")))?;
        hasher.update(frame_len);
        hasher.update(&ciphertext);
        index = index
            .checked_add(1)
            .ok_or_else(|| ProtocolError::crypto("file chunk counter overflow".to_string()))?;
    }

    Ok(EncryptedFileMetadata {
        salt_hex: hex::encode(salt),
        nonce_prefix_hex: hex::encode(nonce_prefix),
        kdf: "argon2id".to_string(),
        kdf_params,
        chunk_size_bytes: OFFCHAIN_FILE_CHUNK_SIZE_BYTES as u32,
        ciphertext_hash: format!("sha256:{}", hex::encode(hasher.finalize())),
    })
}

pub fn decrypt_offchain_file_reader_to_writer<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    metadata: &EncryptedFileMetadata,
    passphrase: &str,
) -> Result<()> {
    if metadata.kdf != "argon2id" {
        return Err(ProtocolError::crypto(format!(
            "unsupported kdf: {}",
            metadata.kdf
        )));
    }
    if metadata.chunk_size_bytes as usize != OFFCHAIN_FILE_CHUNK_SIZE_BYTES {
        return Err(ProtocolError::crypto(format!(
            "unsupported file chunk size: {}",
            metadata.chunk_size_bytes
        )));
    }
    let salt = hex::decode(&metadata.salt_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid salt hex: {err}")))?;
    let nonce_prefix: [u8; 4] = hex::decode(&metadata.nonce_prefix_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid nonce prefix hex: {err}")))?
        .try_into()
        .map_err(|_| ProtocolError::crypto("nonce prefix must be 4 bytes".to_string()))?;
    let params = Params::new(
        metadata.kdf_params.memory_kib,
        metadata.kdf_params.iterations,
        metadata.kdf_params.parallelism,
        Some(metadata.kdf_params.output_length),
    )
    .map_err(|err| ProtocolError::crypto(format!("invalid kdf params: {err}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut derived_key = [0u8; 32];
    argon2
        .hash_password_into(passphrase.as_bytes(), &salt, &mut derived_key)
        .map_err(|err| ProtocolError::crypto(format!("failed to derive key: {err}")))?;

    let cipher = ChaCha20Poly1305::new(Key::from_slice(&derived_key));
    let mut hasher = Sha256::new();
    let mut index = 0_u64;

    loop {
        let mut frame_len = [0_u8; 4];
        match reader.read_exact(&mut frame_len) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(err) => {
                return Err(ProtocolError::crypto(format!(
                    "failed to read ciphertext frame length: {err}"
                )))
            }
        }

        let len = u32::from_be_bytes(frame_len) as usize;
        let mut ciphertext = vec![0_u8; len];
        reader.read_exact(&mut ciphertext).map_err(|err| {
            ProtocolError::crypto(format!("failed to read ciphertext frame payload: {err}"))
        })?;

        hasher.update(frame_len);
        hasher.update(&ciphertext);
        let nonce = chunk_nonce(&nonce_prefix, index);
        let aad = index.to_be_bytes();
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                chacha20poly1305::aead::Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|err| ProtocolError::crypto(format!("failed to decrypt file chunk: {err}")))?;
        writer.write_all(&plaintext).map_err(|err| {
            ProtocolError::crypto(format!("failed to write plaintext file: {err}"))
        })?;
        index = index
            .checked_add(1)
            .ok_or_else(|| ProtocolError::crypto("file chunk counter overflow".to_string()))?;
    }

    let computed_hash = format!("sha256:{}", hex::encode(hasher.finalize()));
    if computed_hash != metadata.ciphertext_hash {
        return Err(ProtocolError::ValidationFailed(
            "off-chain ciphertext hash mismatch".into(),
        ));
    }

    Ok(())
}

pub fn encrypt_offchain_file_reader_to_writer_hybrid<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    author_keypair: &WalletKeypair,
    authorized_readers: &[String],
    reader_public_keys: &BTreeMap<String, String>,
    context_id: &str,
) -> Result<HybridEncryptedFileMetadata> {
    let mut nonce_prefix = [0u8; 4];
    fill_os_random(&mut nonce_prefix);
    let mut hasher = Sha256::new();
    let dek = privacy::generate_dek();
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&dek));
    let mut chunk = vec![0_u8; OFFCHAIN_FILE_CHUNK_SIZE_BYTES];
    let mut index: u64 = 0;

    loop {
        let read = reader.read(&mut chunk).map_err(|err| {
            ProtocolError::crypto(format!("failed to read plaintext file: {err}"))
        })?;
        if read == 0 {
            break;
        }

        let nonce = chunk_nonce(&nonce_prefix, index);
        let aad = index.to_be_bytes();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                chacha20poly1305::aead::Payload {
                    msg: &chunk[..read],
                    aad: &aad,
                },
            )
            .map_err(|err| ProtocolError::crypto(format!("failed to encrypt file chunk: {err}")))?;

        let frame_len = (ciphertext.len() as u32).to_be_bytes();
        writer
            .write_all(&frame_len)
            .and_then(|_| writer.write_all(&ciphertext))
            .map_err(|err| ProtocolError::crypto(format!("failed to write ciphertext: {err}")))?;
        hasher.update(frame_len);
        hasher.update(&ciphertext);
        index = index
            .checked_add(1)
            .ok_or_else(|| ProtocolError::crypto("file chunk counter overflow".to_string()))?;
    }

    let mut wrapped = Vec::new();
    let author_secret = x25519_secret_from_wallet(author_keypair);
    for reader_id in authorized_readers {
        let reader_key_hex = reader_public_keys.get(reader_id).ok_or_else(|| {
            ProtocolError::ValidationFailed(format!(
                "missing reader public key for authorized reader `{reader_id}`"
            ))
        })?;
        let reader_pubkey = parse_x25519_public_key(reader_key_hex)?;
        let wrapped_dek = privacy::wrap_dek_for_reader(
            &dek,
            &author_secret,
            &reader_pubkey,
            &format!("{context_id}:{reader_id}"),
        )?;
        wrapped.push(KeyWrap {
            reader_id: reader_id.clone(),
            wrapped_dek,
            wrap_algorithm: "x25519-xchacha20poly1305".to_string(),
        });
    }
    if wrapped.is_empty() {
        return Err(ProtocolError::ValidationFailed(
            "hybrid off-chain file mode requires at least one authorized reader".into(),
        ));
    }

    let author_public_key_hex =
        hex::encode(X25519PublicKey::from(&x25519_secret_from_wallet(author_keypair)).as_bytes());
    Ok(HybridEncryptedFileMetadata {
        nonce_prefix_hex: hex::encode(nonce_prefix),
        chunk_size_bytes: OFFCHAIN_FILE_CHUNK_SIZE_BYTES as u32,
        ciphertext_hash: format!("sha256:{}", hex::encode(hasher.finalize())),
        author_public_key_hex,
        key_wrapped_secrets: wrapped,
    })
}

pub fn decrypt_offchain_file_reader_to_writer_hybrid<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    metadata: &HybridEncryptedFileMetadata,
    caller_did: &str,
    caller_private_key_hex: &str,
) -> Result<()> {
    if metadata.chunk_size_bytes as usize != OFFCHAIN_FILE_CHUNK_SIZE_BYTES {
        return Err(ProtocolError::crypto(format!(
            "unsupported file chunk size: {}",
            metadata.chunk_size_bytes
        )));
    }
    let key_wrap = metadata
        .key_wrapped_secrets
        .iter()
        .find(|wrap| wrap.reader_id == caller_did)
        .ok_or_else(|| {
            ProtocolError::ValidationFailed("no DEK wrap found for caller DID".into())
        })?;
    if !is_supported_hybrid_wrap_algorithm(&key_wrap.wrap_algorithm) {
        return Err(ProtocolError::ValidationFailed(
            "unsupported DEK wrap algorithm".into(),
        ));
    }
    let caller_secret = parse_x25519_secret_key(caller_private_key_hex)?;
    assert_caller_key_matches_did(caller_did, &caller_secret)?;
    let author_pubkey = parse_x25519_public_key(&metadata.author_public_key_hex)?;
    let dek =
        privacy::unwrap_dek_for_reader(&key_wrap.wrapped_dek, &caller_secret, &author_pubkey)?;

    let cipher = ChaCha20Poly1305::new(Key::from_slice(&dek));
    let nonce_prefix: [u8; 4] = hex::decode(&metadata.nonce_prefix_hex)
        .map_err(|err| ProtocolError::crypto(format!("invalid nonce prefix hex: {err}")))?
        .try_into()
        .map_err(|_| ProtocolError::crypto("nonce prefix must be 4 bytes".to_string()))?;
    let mut hasher = Sha256::new();
    let mut index = 0_u64;

    loop {
        let mut frame_len = [0_u8; 4];
        match reader.read_exact(&mut frame_len) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(err) => {
                return Err(ProtocolError::crypto(format!(
                    "failed to read ciphertext frame length: {err}"
                )))
            }
        }
        let len = u32::from_be_bytes(frame_len) as usize;
        let mut ciphertext = vec![0_u8; len];
        reader.read_exact(&mut ciphertext).map_err(|err| {
            ProtocolError::crypto(format!("failed to read ciphertext frame payload: {err}"))
        })?;

        hasher.update(frame_len);
        hasher.update(&ciphertext);

        let nonce = chunk_nonce(&nonce_prefix, index);
        let aad = index.to_be_bytes();
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                chacha20poly1305::aead::Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|err| ProtocolError::crypto(format!("failed to decrypt file chunk: {err}")))?;
        writer.write_all(&plaintext).map_err(|err| {
            ProtocolError::crypto(format!("failed to write plaintext chunk: {err}"))
        })?;
        index = index
            .checked_add(1)
            .ok_or_else(|| ProtocolError::crypto("file chunk counter overflow".to_string()))?;
    }

    let observed_hash = format!("sha256:{}", hex::encode(hasher.finalize()));
    if observed_hash != metadata.ciphertext_hash {
        return Err(ProtocolError::ValidationFailed(
            "off-chain ciphertext hash mismatch".into(),
        ));
    }
    Ok(())
}

fn chunk_nonce(prefix: &[u8; 4], chunk_index: u64) -> [u8; 12] {
    let mut nonce = [0_u8; 12];
    nonce[..4].copy_from_slice(prefix);
    nonce[4..].copy_from_slice(&chunk_index.to_be_bytes());
    nonce
}

pub const BACKUP_ARGON2ID_MEMORY_KIB: u32 = 19_456;
pub const BACKUP_ARGON2ID_ITERATIONS: u32 = 2;
pub const BACKUP_ARGON2ID_PARALLELISM: u32 = 1;
pub const BACKUP_ARGON2ID_OUTPUT_LENGTH: usize = 32;

pub fn encrypt_payload(payload: &Value, passphrase: &str) -> Result<EncryptedPayload> {
    encrypt_payload_with_kdf_params(
        payload,
        passphrase,
        BACKUP_ARGON2ID_MEMORY_KIB,
        BACKUP_ARGON2ID_ITERATIONS,
        BACKUP_ARGON2ID_PARALLELISM,
        BACKUP_ARGON2ID_OUTPUT_LENGTH,
    )
}

pub fn encrypt_payload_with_kdf_params(
    payload: &Value,
    passphrase: &str,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    output_length: usize,
) -> Result<EncryptedPayload> {
    let canonical_payload = canonical_json(payload);
    let plaintext = canonical_payload.as_bytes();
    let mut salt = [0u8; 16];
    fill_os_random(&mut salt);
    let mut nonce = [0u8; 12];
    fill_os_random(&mut nonce);
    let params = Params::new(memory_kib, iterations, parallelism, Some(output_length))
        .map_err(|err| ProtocolError::crypto(format!("invalid kdf params: {err}")))?;
    let mut derived_key = [0u8; 32];
    let kdf_params = KdfParams {
        memory_kib: params.m_cost(),
        iterations: params.t_cost(),
        parallelism: params.p_cost(),
        output_length,
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
    if nonce.len() != 12 {
        return Err(ProtocolError::crypto(
            "nonce must be 12 bytes for ChaCha20-Poly1305".to_string(),
        ));
    }
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
    now: UnixTimestamp,
) -> Result<Value> {
    ensure_active_reader_grant(entry, caller_did, now)?;
    let key_wrap = entry
        .key_wrapped_secrets
        .iter()
        .find(|wrap| wrap.reader_id == caller_did)
        .ok_or_else(|| {
            ProtocolError::ValidationFailed("no DEK wrap found for caller DID".into())
        })?;
    if !is_supported_hybrid_wrap_algorithm(&key_wrap.wrap_algorithm) {
        return Err(ProtocolError::ValidationFailed(
            "unsupported DEK wrap algorithm".into(),
        ));
    }
    let caller_secret = parse_x25519_secret_key(caller_private_key_hex)?;
    assert_caller_key_matches_did(caller_did, &caller_secret)?;
    let author_pubkey = parse_x25519_public_key(author_public_key_hex)?;
    let dek =
        privacy::unwrap_dek_for_reader(&key_wrap.wrapped_dek, &caller_secret, &author_pubkey)?;
    let encrypted = EncryptedPayload {
        ciphertext_hex: entry.ciphertext_hex.clone().ok_or_else(|| {
            ProtocolError::ValidationFailed("hybrid entry missing ciphertext".into())
        })?,
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

fn is_supported_hybrid_wrap_algorithm(algorithm: &str) -> bool {
    matches!(
        algorithm,
        // Canonical label used by current wallet encrypt/sign flow.
        "x25519-xchacha20poly1305"
            // Legacy label accepted for backward compatibility with older entries.
            | "x25519-chacha20poly1305"
    )
}

fn assert_caller_key_matches_did(caller_did: &str, caller_secret: &StaticSecret) -> Result<()> {
    const DID_PREFIX: &str = "did:key:x25519:";
    if let Some(public_hex) = caller_did.strip_prefix(DID_PREFIX) {
        let expected = parse_x25519_public_key(public_hex)?;
        let actual = X25519PublicKey::from(caller_secret);
        if actual.as_bytes() != expected.as_bytes() {
            return Err(ProtocolError::ValidationFailed(
                "caller DID does not match provided X25519 private key".into(),
            ));
        }
    }
    Ok(())
}

pub fn ensure_active_reader_grant(
    entry: &LedgerEntry,
    caller_did: &str,
    now: UnixTimestamp,
) -> Result<()> {
    if entry.privacy_mode != PrivacyMode::Hybrid {
        return Err(ProtocolError::ValidationFailed(
            "grant checks are only supported for hybrid encrypted entries".into(),
        ));
    }

    let consent = entry.consent_receipt.as_ref().ok_or_else(|| {
        ProtocolError::ValidationFailed("hybrid entry missing consent receipt".into())
    })?;

    if consent.expires_at <= now {
        return Err(ProtocolError::ValidationFailed(
            "consent grant is expired for caller DID".into(),
        ));
    }

    if !entry
        .authorized_readers
        .iter()
        .any(|reader| reader == caller_did)
    {
        return Err(ProtocolError::ValidationFailed(
            "caller DID is not present in entry authorized_readers".into(),
        ));
    }

    if !consent.authorized_readers.is_empty()
        && !consent
            .authorized_readers
            .iter()
            .any(|reader| reader == caller_did)
    {
        return Err(ProtocolError::ValidationFailed(
            "caller DID is not present in consent authorized_readers".into(),
        ));
    }

    if entry
        .revocation_events
        .iter()
        .any(|event| event.reader_id == caller_did && event.timestamp <= now)
    {
        return Err(ProtocolError::ValidationFailed(
            "caller DID grant has been revoked".into(),
        ));
    }

    Ok(())
}

fn encrypt_payload_with_dek(payload: &Value, dek: &[u8; 32]) -> Result<EncryptedPayload> {
    let canonical_payload = canonical_json(payload);
    let mut nonce = [0u8; 24];
    fill_os_random(&mut nonce);
    let cipher = XChaCha20Poly1305::new_from_slice(dek)
        .map_err(|err| ProtocolError::crypto(format!("invalid DEK: {err}")))?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), canonical_payload.as_bytes())
        .map_err(|err| {
            ProtocolError::crypto(format!("failed to encrypt payload with DEK: {err}"))
        })?;
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
    fill_os_random(&mut salt);
    let mut nonce = [0u8; 12];
    fill_os_random(&mut nonce);
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
    let signing_payload = build_wrcp_tx_v1_signing_payload(entry);
    let canonical_payload = wrcp_tx_v1_canonical_json(&signing_payload)?;
    let signature_bytes = hex::decode(&entry.signature)
        .map_err(|err| ProtocolError::crypto(format!("invalid signature hex: {err}")))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|err| ProtocolError::crypto(format!("invalid signature bytes: {err}")))?;
    verifying_key
        .verify_strict(canonical_payload.as_bytes(), &signature)
        .map_err(|err| ProtocolError::crypto(format!("signature verification failed: {err}")))
}

fn wrcp_msig_v1_allowed_approvers(
    namespace_policy: &Value,
) -> Result<(usize, BTreeMap<String, String>)> {
    let required_approvals = namespace_policy
        .get("required_grant_approvals")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ProtocolError::ValidationFailed(
                "builder credit policy requires required_grant_approvals".into(),
            )
        })? as usize;
    let grant_approvers = namespace_policy
        .get("grant_approvers")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ProtocolError::ValidationFailed(
                "builder credit policy requires grant_approvers for credit grant actions".into(),
            )
        })?;
    if grant_approvers.is_empty() {
        return Err(ProtocolError::ValidationFailed(
            "builder credit policy grant_approvers cannot be empty".into(),
        ));
    }
    let mut allowed_approvers = BTreeMap::new();
    for approver in grant_approvers {
        let obj = approver.as_object().ok_or_else(|| {
            ProtocolError::ValidationFailed(
                "grant_approvers entries must be objects containing id and public_key".into(),
            )
        })?;
        let approver_id = obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed("grant_approvers entries require string id".into())
            })?
            .to_string();
        let public_key = obj
            .get("public_key")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "grant_approvers entries require string public_key".into(),
                )
            })?
            .to_string();
        parse_verifying_key(&public_key).map_err(|err| {
            ProtocolError::ValidationFailed(format!(
                "invalid grant_approvers public_key for {approver_id}: {err}"
            ))
        })?;
        if allowed_approvers.insert(approver_id, public_key).is_some() {
            return Err(ProtocolError::ValidationFailed(
                "grant_approvers entries must be unique by id".into(),
            ));
        }
    }
    if required_approvals == 0 || required_approvals > allowed_approvers.len() {
        return Err(ProtocolError::ValidationFailed(
            "required_grant_approvals must be between 1 and grant_approvers length".into(),
        ));
    }
    Ok((required_approvals, allowed_approvers))
}

pub fn build_wrcp_msig_v1_signing_payload(
    entry: &LedgerEntry,
    amount: u64,
    approver: &str,
) -> Result<String> {
    serde_json::to_string(&serde_json::json!({
        "entry_id": entry.entry_id,
        "namespace": entry.namespace,
        "action": entry.action,
        "object_id": entry.object_id,
        "author": entry.author,
        "amount": amount,
        "timestamp": entry.timestamp,
        "approver": approver
    }))
    .map_err(|err| {
        ProtocolError::ValidationFailed(format!(
            "failed to serialize MULTISIG_CREDIT_GRANT signing payload: {err}"
        ))
    })
}

pub fn build_wrcp_msig_v1_proof(
    entry: &LedgerEntry,
    approver: &str,
    approver_keypair: &WalletKeypair,
    namespace_policy: &Value,
) -> Result<WrcpMsigV1Proof> {
    if entry.namespace != "builder.credits" || entry.action != "MULTISIG_CREDIT_GRANT" {
        return Err(ProtocolError::ValidationFailed(
            "MULTISIG_CREDIT_GRANT proof builder requires builder.credits/MULTISIG_CREDIT_GRANT entry".into(),
        ));
    }
    let (_, allowed_approvers) = wrcp_msig_v1_allowed_approvers(namespace_policy)?;
    let configured_public_key = allowed_approvers.get(approver).ok_or_else(|| {
        ProtocolError::ValidationFailed(
            "MULTISIG_CREDIT_GRANT includes approver outside grant_approvers".into(),
        )
    })?;
    let derived_public_key = approver_keypair.verifying_key_hex();
    if &derived_public_key != configured_public_key {
        return Err(ProtocolError::ValidationFailed(format!(
            "MULTISIG_CREDIT_GRANT public_key does not match configured key for approver {approver}"
        )));
    }
    let amount = entry
        .payload
        .get("amount")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ProtocolError::ValidationFailed(
                "entry payload.amount must be a positive integer".to_string(),
            )
        })?;
    let signing_payload = build_wrcp_msig_v1_signing_payload(entry, amount, approver)?;
    let signature = approver_keypair.sign_bytes(signing_payload.as_bytes());
    Ok(WrcpMsigV1Proof {
        approver: approver.to_string(),
        public_key: derived_public_key,
        signature: hex::encode(signature.to_bytes()),
    })
}

pub fn dry_run_wrcp_msig_v1(
    entry: &LedgerEntry,
    namespace_policy: &Value,
) -> WrcpMsigV1DryRunReport {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let (required_approvals, allowed_approvers) =
        match wrcp_msig_v1_allowed_approvers(namespace_policy) {
            Ok(data) => data,
            Err(err) => {
                errors.push(WrcpMsigV1Issue {
                    reason_code: "MSIG_POLICY_INVALID".to_string(),
                    message: err.to_string(),
                });
                return WrcpMsigV1DryRunReport {
                    ok: false,
                    required_approvals: 0,
                    unique_approvals: 0,
                    errors,
                    warnings,
                };
            }
        };

    if entry.namespace != "builder.credits" || entry.action != "MULTISIG_CREDIT_GRANT" {
        errors.push(WrcpMsigV1Issue {
            reason_code: "MSIG_NOT_BUILDER_CREDITS_GRANT".to_string(),
            message: "Entry is not a builder credit multisig grant action.".to_string(),
        });
        return WrcpMsigV1DryRunReport {
            ok: false,
            required_approvals,
            unique_approvals: 0,
            errors,
            warnings,
        };
    }

    let amount = match entry.payload.get("amount").and_then(Value::as_u64) {
        Some(amount) => amount,
        None => {
            errors.push(WrcpMsigV1Issue {
                reason_code: "MSIG_SIGNATURE_INVALID".to_string(),
                message: "entry payload.amount must be a positive integer".to_string(),
            });
            return WrcpMsigV1DryRunReport {
                ok: false,
                required_approvals,
                unique_approvals: 0,
                errors,
                warnings,
            };
        }
    };

    let proofs = match entry
        .payload
        .get("multisig_proofs")
        .and_then(Value::as_array)
    {
        Some(proofs) if !proofs.is_empty() => proofs,
        _ => {
            errors.push(WrcpMsigV1Issue {
                reason_code: "MSIG_PROOFS_MISSING".to_string(),
                message: "payload.multisig_proofs is missing or empty.".to_string(),
            });
            return WrcpMsigV1DryRunReport {
                ok: false,
                required_approvals,
                unique_approvals: 0,
                errors,
                warnings,
            };
        }
    };

    let mut valid_unique_approvals = BTreeSet::new();
    let mut seen_approvers = BTreeSet::new();
    for proof in proofs {
        let approver = match proof.get("approver").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => value,
            _ => {
                errors.push(WrcpMsigV1Issue {
                    reason_code: "MSIG_APPROVER_NOT_AUTHORIZED".to_string(),
                    message: "proof requires non-empty approver".to_string(),
                });
                continue;
            }
        };
        if !seen_approvers.insert(approver.to_string()) {
            warnings.push(WrcpMsigV1Issue {
                reason_code: "MSIG_DUPLICATE_APPROVER".to_string(),
                message: "Duplicate approver proof detected; counted once.".to_string(),
            });
        }
        let configured_public_key = match allowed_approvers.get(approver) {
            Some(value) => value,
            None => {
                errors.push(WrcpMsigV1Issue {
                    reason_code: "MSIG_APPROVER_NOT_AUTHORIZED".to_string(),
                    message: "Approver is not in namespace grant approvers list.".to_string(),
                });
                continue;
            }
        };
        let provided_public_key = match proof.get("public_key").and_then(Value::as_str) {
            Some(value) => value,
            None => {
                errors.push(WrcpMsigV1Issue {
                    reason_code: "MSIG_PUBLIC_KEY_MISMATCH".to_string(),
                    message: "proof requires public_key".to_string(),
                });
                continue;
            }
        };
        if configured_public_key != provided_public_key {
            errors.push(WrcpMsigV1Issue {
                reason_code: "MSIG_PUBLIC_KEY_MISMATCH".to_string(),
                message: "Proof public key does not match approver key material.".to_string(),
            });
            continue;
        }
        let verifying_key = match parse_verifying_key(provided_public_key) {
            Ok(value) => value,
            Err(err) => {
                errors.push(WrcpMsigV1Issue {
                    reason_code: "MSIG_PUBLIC_KEY_MISMATCH".to_string(),
                    message: format!("invalid proof public_key: {err}"),
                });
                continue;
            }
        };
        let signature = match proof.get("signature").and_then(Value::as_str) {
            Some(value) => value,
            None => {
                errors.push(WrcpMsigV1Issue {
                    reason_code: "MSIG_SIGNATURE_INVALID".to_string(),
                    message: "proof requires signature".to_string(),
                });
                continue;
            }
        };
        let signature_bytes = match hex::decode(signature) {
            Ok(value) => value,
            Err(err) => {
                errors.push(WrcpMsigV1Issue {
                    reason_code: "MSIG_SIGNATURE_INVALID".to_string(),
                    message: format!("invalid signature hex: {err}"),
                });
                continue;
            }
        };
        let signature = match Signature::from_slice(&signature_bytes) {
            Ok(value) => value,
            Err(err) => {
                errors.push(WrcpMsigV1Issue {
                    reason_code: "MSIG_SIGNATURE_INVALID".to_string(),
                    message: format!("invalid signature bytes: {err}"),
                });
                continue;
            }
        };
        let signing_payload = match build_wrcp_msig_v1_signing_payload(entry, amount, approver) {
            Ok(value) => value,
            Err(err) => {
                errors.push(WrcpMsigV1Issue {
                    reason_code: "MSIG_SIGNATURE_INVALID".to_string(),
                    message: err.to_string(),
                });
                continue;
            }
        };
        if verifying_key
            .verify_strict(signing_payload.as_bytes(), &signature)
            .is_err()
        {
            errors.push(WrcpMsigV1Issue {
                reason_code: "MSIG_SIGNATURE_INVALID".to_string(),
                message: "Proof signature failed runtime-compatible verification.".to_string(),
            });
            continue;
        }
        valid_unique_approvals.insert(approver.to_string());
    }

    if valid_unique_approvals.len() < required_approvals {
        errors.push(WrcpMsigV1Issue {
            reason_code: "MSIG_APPROVALS_BELOW_THRESHOLD".to_string(),
            message: format!(
                "Unique authorized approvals {}/{}.",
                valid_unique_approvals.len(),
                required_approvals
            ),
        });
    }

    WrcpMsigV1DryRunReport {
        ok: errors.is_empty(),
        required_approvals,
        unique_approvals: valid_unique_approvals.len(),
        errors,
        warnings,
    }
}

fn parse_x25519_public_key(encoded: &str) -> Result<X25519PublicKey> {
    let bytes = hex::decode(encoded)
        .map_err(|err| ProtocolError::crypto(format!("invalid x25519 public key hex: {err}")))?;
    let key_bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ProtocolError::crypto("x25519 public key must be 32 bytes".to_string()))?;
    Ok(X25519PublicKey::from(key_bytes))
}

fn parse_x25519_secret_key(encoded: &str) -> Result<StaticSecret> {
    let bytes = hex::decode(encoded)
        .map_err(|err| ProtocolError::crypto(format!("invalid x25519 secret key hex: {err}")))?;
    let key_bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ProtocolError::crypto("x25519 secret key must be 32 bytes".to_string()))?;
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

pub fn compute_file_manifest_commitment(manifest: &Value) -> Result<String> {
    let mut normalized_manifest = manifest.clone();
    if let Some(object) = normalized_manifest.as_object_mut() {
        object.remove("payload_commitment");
    }
    let canonical_manifest = canonical_json(&normalized_manifest);
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(canonical_manifest.as_bytes()))
    ))
}

pub fn compute_payload_field_commitment(field_commitment_input: &Value) -> Result<String> {
    let canonical_input = canonical_json(field_commitment_input);
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(canonical_input.as_bytes()))
    ))
}

pub fn verify_payload_field_commitment(
    field_commitment_input: &Value,
    expected_commitment: &str,
) -> Result<()> {
    let computed = compute_payload_field_commitment(field_commitment_input)?;
    if computed == expected_commitment {
        return Ok(());
    }

    Err(ProtocolError::ValidationFailed(
        "off-chain payload field commitment mismatch".into(),
    ))
}

pub fn verify_offchain_file_object_hash(manifest: &Value, ciphertext_bytes: &[u8]) -> Result<()> {
    let mut cursor = Cursor::new(ciphertext_bytes);
    verify_offchain_file_object_hash_reader(manifest, &mut cursor)
}

pub fn verify_offchain_file_object_hash_reader<R: Read>(
    manifest: &Value,
    reader: &mut R,
) -> Result<()> {
    let expected_hash = manifest
        .get("ciphertext_hash")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProtocolError::ValidationFailed("manifest.ciphertext_hash is required".into())
        })?;

    let mut hasher = Sha256::new();
    let mut chunk = [0_u8; 1024 * 1024];
    loop {
        let read = reader.read(&mut chunk).map_err(|err| {
            ProtocolError::ValidationFailed(format!("ciphertext read failed: {err}"))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    let computed_hash = format!("sha256:{}", hex::encode(hasher.finalize()));
    if computed_hash != expected_hash {
        return Err(ProtocolError::ValidationFailed(
            "off-chain ciphertext hash mismatch".into(),
        ));
    }
    Ok(())
}

pub fn verify_offchain_file_reconciliation(
    manifest: &Value,
    expected_payload_commitment: &str,
    ciphertext_bytes: &[u8],
) -> Result<()> {
    verify_offchain_file_object_hash(manifest, ciphertext_bytes)?;

    let computed_manifest_commitment = compute_file_manifest_commitment(manifest)?;
    if computed_manifest_commitment != expected_payload_commitment {
        return Err(ProtocolError::ValidationFailed(
            "off-chain manifest commitment mismatch".into(),
        ));
    }

    Ok(())
}

pub fn partition_payload_by_field_policy(
    namespace: &str,
    payload: &Value,
    policy: &NamespaceFieldPolicy,
) -> Result<PolicyPartitionedPayload> {
    if namespace != policy.namespace {
        return Err(ProtocolError::ValidationFailed(format!(
            "namespace policy mismatch: expected `{}`, got `{namespace}`",
            policy.namespace
        )));
    }

    let public_fields = to_unique_paths(&policy.public_fields, "public_fields")?;
    let committed_fields = to_unique_paths(&policy.committed_fields, "committed_fields")?;
    let encrypted_fields = to_unique_paths(
        &policy.offchain_encrypted_fields,
        "offchain_encrypted_fields",
    )?;

    ensure_disjoint_sets(
        &public_fields,
        &committed_fields,
        "public_fields",
        "committed_fields",
    )?;
    ensure_disjoint_sets(
        &public_fields,
        &encrypted_fields,
        "public_fields",
        "offchain_encrypted_fields",
    )?;
    ensure_disjoint_sets(
        &committed_fields,
        &encrypted_fields,
        "committed_fields",
        "offchain_encrypted_fields",
    )?;

    let mut public_partition = BTreeMap::new();
    for path in public_fields {
        let value = value_at_field_path(payload, &path)?;
        public_partition.insert(path, value);
    }

    let mut committed_partition = BTreeMap::new();
    for path in committed_fields {
        let value = value_at_field_path(payload, &path)?;
        let canonical_value = canonical_json(&value);
        committed_partition.insert(
            path.clone(),
            PayloadFieldCommitment {
                field_path: path,
                commitment_sha256: hex::encode(Sha256::digest(canonical_value.as_bytes())),
                canonical_value,
            },
        );
    }

    let mut encrypted_partition = BTreeMap::new();
    for path in encrypted_fields {
        let value = value_at_field_path(payload, &path)?;
        encrypted_partition.insert(path, value);
    }

    Ok(PolicyPartitionedPayload {
        namespace: policy.namespace.clone(),
        policy_version: policy.policy_version,
        public_fields: public_partition,
        committed_fields: committed_partition,
        offchain_encrypted_fields: encrypted_partition,
    })
}

fn to_unique_paths(paths: &[String], label: &str) -> Result<BTreeSet<String>> {
    let mut unique = BTreeSet::new();
    for path in paths {
        if path.trim().is_empty() {
            return Err(ProtocolError::ValidationFailed(format!(
                "{label} cannot contain empty field paths"
            )));
        }
        unique.insert(path.clone());
    }
    Ok(unique)
}

fn ensure_disjoint_sets(
    left: &BTreeSet<String>,
    right: &BTreeSet<String>,
    left_name: &str,
    right_name: &str,
) -> Result<()> {
    if let Some(overlap) = left.intersection(right).next() {
        return Err(ProtocolError::ValidationFailed(format!(
            "field path `{overlap}` cannot be present in both {left_name} and {right_name}"
        )));
    }
    Ok(())
}

fn value_at_field_path(payload: &Value, field_path: &str) -> Result<Value> {
    let mut current = payload;
    for segment in field_path.split('.') {
        let object = current.as_object().ok_or_else(|| {
            ProtocolError::ValidationFailed(format!(
                "field path `{field_path}` traverses non-object segment `{segment}`"
            ))
        })?;
        current = object.get(segment).ok_or_else(|| {
            ProtocolError::ValidationFailed(format!(
                "field path `{field_path}` not found in payload"
            ))
        })?;
    }
    Ok(current.clone())
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
    use std::io::Read;

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
    fn wrcp_tx_v1_payload_builder_matches_signed_entry() {
        let keypair = WalletKeypair::generate();
        let draft = EntryDraft {
            namespace: "identity.citizen".to_string(),
            action: "REGISTER_IDENTITY".to_string(),
            object_id: "did:ledger:wrcp".to_string(),
            payload: json!({ "claims_hash": "wrpc-abc123", "country": "US" }),
            privacy_flag: false,
            privacy_mode: PrivacyMode::None,
            encryption_passphrase: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys: BTreeMap::new(),
            author: "did:ledger:wrcp".to_string(),
            timestamp: 1_736_500_010,
        };
        let entry = sign_entry(draft, &keypair).expect("sign entry");

        let payload = build_wrcp_tx_v1_signing_payload(&entry);
        let canonical = wrcp_tx_v1_canonical_json(&payload).expect("canonical WRCP payload");

        assert!(canonical.contains("\"namespace\":\"identity.citizen\""));
        assert!(canonical.contains("\"action\":\"REGISTER_IDENTITY\""));
        assert!(canonical.contains("\"author\":\"did:ledger:wrcp\""));
        verify_entry_signature(&entry, keypair.verifying_key()).expect("verify signature");
    }

    #[test]
    fn builds_wrcp_multisig_proof_with_policy_validation() {
        let approver = WalletKeypair::generate();
        let entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "builder.credits".into(),
            action: "MULTISIG_CREDIT_GRANT".into(),
            object_id: "builder:alpha".into(),
            payload: json!({"amount": 100}),
            privacy_flag: false,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            signature: String::new(),
            consent_receipt: None,
            privacy_mode: PrivacyMode::None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            author: "did:ledger:author".into(),
            timestamp: 1_736_500_201,
        };
        let policy = json!({
            "required_grant_approvals": 1,
            "grant_approvers": [
                {"id":"did:ledger:approver-1","public_key":approver.verifying_key_hex()}
            ]
        });

        let proof = build_wrcp_msig_v1_proof(&entry, "did:ledger:approver-1", &approver, &policy)
            .expect("build proof");
        assert_eq!(proof.approver, "did:ledger:approver-1");
        assert_eq!(proof.public_key, approver.verifying_key_hex());
        assert!(!proof.signature.is_empty());
    }

    #[test]
    fn dry_run_wrcp_multisig_reports_threshold_failure() {
        let approver = WalletKeypair::generate();
        let other = WalletKeypair::generate();
        let mut entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "builder.credits".into(),
            action: "MULTISIG_CREDIT_GRANT".into(),
            object_id: "builder:alpha".into(),
            payload: json!({"amount": 250}),
            privacy_flag: false,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            signature: String::new(),
            consent_receipt: None,
            privacy_mode: PrivacyMode::None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            author: "did:ledger:author".into(),
            timestamp: 1_736_500_211,
        };
        let policy = json!({
            "required_grant_approvals": 2,
            "grant_approvers": [
                {"id":"did:ledger:approver-1","public_key":approver.verifying_key_hex()},
                {"id":"did:ledger:approver-2","public_key":other.verifying_key_hex()}
            ]
        });
        let proof = build_wrcp_msig_v1_proof(&entry, "did:ledger:approver-1", &approver, &policy)
            .expect("build proof");
        entry.payload["multisig_proofs"] = json!([{
            "approver": proof.approver,
            "public_key": proof.public_key,
            "signature": proof.signature
        }]);

        let report = dry_run_wrcp_msig_v1(&entry, &policy);
        assert!(!report.ok);
        assert_eq!(report.required_approvals, 2);
        assert_eq!(report.unique_approvals, 1);
        assert!(report
            .errors
            .iter()
            .any(|issue| issue.reason_code == "MSIG_APPROVALS_BELOW_THRESHOLD"));
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
    fn encrypted_payload_uses_backup_argon2id_defaults() {
        let payload = json!({"scope":"wallet-backup"});
        let encrypted = encrypt_payload(&payload, "strong-test-passphrase").expect("encrypt payload");
        assert_eq!(encrypted.kdf, "argon2id");
        assert_eq!(encrypted.kdf_params.memory_kib, BACKUP_ARGON2ID_MEMORY_KIB);
        assert_eq!(encrypted.kdf_params.iterations, BACKUP_ARGON2ID_ITERATIONS);
        assert_eq!(encrypted.kdf_params.parallelism, BACKUP_ARGON2ID_PARALLELISM);
        assert_eq!(encrypted.kdf_params.output_length as usize, BACKUP_ARGON2ID_OUTPUT_LENGTH);
    }

    #[test]
    fn decrypt_payload_rejects_invalid_nonce_length() {
        let payload = json!({"scope":"wallet-backup"});
        let mut encrypted =
            encrypt_payload(&payload, "strong-test-passphrase").expect("encrypt payload");
        encrypted.nonce_hex = "0011".to_string();
        let err = decrypt_payload(&encrypted, "strong-test-passphrase")
            .expect_err("invalid nonce length must fail");
        assert!(err
            .to_string()
            .contains("nonce must be 12 bytes for ChaCha20-Poly1305"));
    }

    #[test]
    fn decrypt_payload_rejects_tampered_ciphertext() {
        let payload = json!({"scope":"wallet-backup","kind":"critical"});
        let mut encrypted = encrypt_payload(&payload, "tamper-test-passphrase").expect("encrypt");
        encrypted.ciphertext_hex.push('0');
        let err = decrypt_payload(&encrypted, "tamper-test-passphrase")
            .expect_err("tampered ciphertext should fail");
        assert!(err.to_string().contains("invalid ciphertext hex"));
    }

    #[test]
    fn backup_payload_test_vector_decrypt_and_tamper_failure() {
        let payload = json!({"scope":"wallet-backup","slot":"critical","version":1});
        let payload_bytes = serde_json::to_vec(&payload).expect("serialize payload");
        let passphrase = "vector-passphrase";
        let salt = [0x0f_u8, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a, 0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00];
        let nonce = [0x01_u8, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c];
        let params = Params::new(65536, 3, 1, Some(32)).expect("valid params");
        let mut derived_key = [0u8; 32];
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(passphrase.as_bytes(), &salt, &mut derived_key)
            .expect("derive key");
        let ciphertext = ChaCha20Poly1305::new(Key::from_slice(&derived_key))
            .encrypt(Nonce::from_slice(&nonce), payload_bytes.as_slice())
            .expect("encrypt test vector");
        let ciphertext_hex = hex::encode(ciphertext);
        assert_eq!(
            ciphertext_hex,
            "512dcf57133809dbc5db6b57a209a467b8ef635e3c14785adba7acc3cbc46b0b7f1ed193459148b1731eb4108f51df572641d6e2c741ad96202bef646a2d6fbc57a4b970f1a22c"
        );

        let vector = EncryptedPayload {
            ciphertext_hex,
            nonce_hex: hex::encode(nonce),
            salt_hex: hex::encode(salt),
            kdf: "argon2id".to_string(),
            kdf_params: KdfParams {
                memory_kib: 65536,
                iterations: 3,
                parallelism: 1,
                output_length: 32,
            },
        };
        let decrypted = decrypt_payload(&vector, "vector-passphrase").expect("decrypt vector payload");
        assert_eq!(
            decrypted,
            payload
        );

        let mut tampered = vector;
        tampered.ciphertext_hex.replace_range(0..2, "ff");
        let err = decrypt_payload(&tampered, "vector-passphrase")
            .expect_err("tampered vector ciphertext should fail");
        assert!(
            err.to_string().contains("failed to decrypt payload"),
            "unexpected tamper error: {err}"
        );
    }

    #[test]
    fn backup_encrypt_decrypt_meets_latency_envelope() {
        let payload = json!({
            "scope":"wallet-backup",
            "slot":"critical",
            "material":{"did":"did:citizen:wallet:123","key_alias":"identity-root"}
        });
        let mut encrypt_samples_ms = Vec::with_capacity(3);
        let mut decrypt_samples_ms = Vec::with_capacity(3);

        for _ in 0..3 {
            let started = std::time::Instant::now();
            let encrypted = encrypt_payload(&payload, "latency-envelope-passphrase")
                .expect("encrypt payload for latency envelope");
            let encrypt_elapsed_ms = started.elapsed().as_millis() as u64;

            let started = std::time::Instant::now();
            let decrypted = decrypt_payload(&encrypted, "latency-envelope-passphrase")
                .expect("decrypt payload for latency envelope");
            let decrypt_elapsed_ms = started.elapsed().as_millis() as u64;
            assert_eq!(decrypted, payload);

            encrypt_samples_ms.push(encrypt_elapsed_ms);
            decrypt_samples_ms.push(decrypt_elapsed_ms);
        }

        let best_encrypt_ms = *encrypt_samples_ms.iter().min().expect("encrypt sample");
        let best_decrypt_ms = *decrypt_samples_ms.iter().min().expect("decrypt sample");

        // Priority-gate parity target for CLI/runtime evidence. Use best-of-three to reduce
        // false positives from host scheduling jitter on shared CI/VM runners.
        assert!(
            best_encrypt_ms <= 2_500,
            "encrypt latency exceeded envelope: best={best_encrypt_ms}ms samples={encrypt_samples_ms:?}"
        );
        assert!(
            best_decrypt_ms <= 2_500,
            "decrypt latency exceeded envelope: best={best_decrypt_ms}ms samples={decrypt_samples_ms:?}"
        );
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
        reader_public_keys.insert(
            "did:ledger:reader".to_string(),
            hex::encode(reader_public.as_bytes()),
        );

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
            1_736_500_112,
        )
        .expect("decrypt hybrid entry");
        assert_eq!(
            decrypted,
            json!({"document_hash":"abc123","event":"BID_OPENED"})
        );

        println!(
            "SAMPLE_WHOLE_PAYLOAD_ENTRY={}\n",
            serde_json::to_string_pretty(&entry).expect("serialize whole-payload entry sample")
        );
    }

    #[test]
    fn hybrid_entry_all_authorized_readers_can_decrypt_with_individual_wraps() {
        let author = WalletKeypair::generate();
        let reader_a_secret = StaticSecret::from([21u8; 32]);
        let reader_b_secret = StaticSecret::from([22u8; 32]);
        let reader_a_public = X25519PublicKey::from(&reader_a_secret);
        let reader_b_public = X25519PublicKey::from(&reader_b_secret);

        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert(
            "did:ledger:reader-a".to_string(),
            hex::encode(reader_a_public.as_bytes()),
        );
        reader_public_keys.insert(
            "did:ledger:reader-b".to_string(),
            hex::encode(reader_b_public.as_bytes()),
        );

        let draft = EntryDraft {
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-3B".to_string(),
            payload: json!({"document_hash":"abc123","event":"BID_OPENED","round":"final"}),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Hybrid,
            encryption_passphrase: None,
            authorized_readers: vec![
                "did:ledger:reader-a".to_string(),
                "did:ledger:reader-b".to_string(),
            ],
            custodian_policy_id: Some("custodian.policy.v1".to_string()),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys,
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_113,
        };

        let entry = sign_entry(draft, &author).expect("sign hybrid private entry");
        assert_eq!(entry.key_wrapped_secrets.len(), 2);

        let author_public =
            hex::encode(X25519PublicKey::from(&x25519_secret_from_wallet(&author)).as_bytes());

        let decrypted_reader_a = decrypt_payload_with_hybrid(
            &entry,
            "did:ledger:reader-a",
            &hex::encode(reader_a_secret.to_bytes()),
            &author_public,
            1_736_500_114,
        )
        .expect("authorized reader a decrypt");

        let decrypted_reader_b = decrypt_payload_with_hybrid(
            &entry,
            "did:ledger:reader-b",
            &hex::encode(reader_b_secret.to_bytes()),
            &author_public,
            1_736_500_114,
        )
        .expect("authorized reader b decrypt");

        let expected = json!({"document_hash":"abc123","event":"BID_OPENED","round":"final"});
        assert_eq!(decrypted_reader_a, expected);
        assert_eq!(decrypted_reader_b, expected);
    }

    #[test]
    fn hybrid_selective_entry_supports_field_reader_acls() {
        let author = WalletKeypair::generate();
        let reader_secret = StaticSecret::from([9u8; 32]);
        let reader_public = X25519PublicKey::from(&reader_secret);

        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert(
            "did:ledger:reader".to_string(),
            hex::encode(reader_public.as_bytes()),
        );

        let mut field_reader_acls = BTreeMap::new();
        field_reader_acls.insert(
            "bidder_email".to_string(),
            vec!["did:ledger:reader".to_string()],
        );

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
        assert_eq!(
            entry.payload.get("privacy_mode").and_then(Value::as_str),
            Some("field_selective_v1")
        );
        assert_eq!(
            entry.field_reader_acls.get("bidder_email").map(Vec::len),
            Some(1)
        );

        println!(
            "SAMPLE_PER_FIELD_ENTRY={}\n",
            serde_json::to_string_pretty(&entry).expect("serialize per-field entry sample")
        );
    }

    #[test]
    fn hybrid_decrypt_rejects_non_granted_reader() {
        let author = WalletKeypair::generate();
        let allowed_secret = StaticSecret::from([11u8; 32]);
        let allowed_public = X25519PublicKey::from(&allowed_secret);

        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert(
            "did:ledger:allowed".to_string(),
            hex::encode(allowed_public.as_bytes()),
        );

        let draft = EntryDraft {
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-5".to_string(),
            payload: json!({"document_hash":"abc123","event":"BID_OPENED"}),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Hybrid,
            encryption_passphrase: None,
            authorized_readers: vec!["did:ledger:allowed".to_string()],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys,
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_120,
        };

        let entry = sign_entry(draft, &author).expect("sign hybrid entry with single grant");
        let denied = decrypt_payload_with_hybrid(
            &entry,
            "did:ledger:denied",
            &hex::encode(allowed_secret.to_bytes()),
            &hex::encode(X25519PublicKey::from(&x25519_secret_from_wallet(&author)).as_bytes()),
            1_736_500_121,
        )
        .expect_err("non-granted reader must be denied");
        assert!(denied
            .to_string()
            .contains("caller DID is not present in entry authorized_readers"));
    }

    #[test]
    fn ensure_active_reader_grant_accepts_active_grant() {
        let author = WalletKeypair::generate();
        let reader_secret = StaticSecret::from([17u8; 32]);
        let reader_public = X25519PublicKey::from(&reader_secret);

        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert(
            "did:ledger:reader".to_string(),
            hex::encode(reader_public.as_bytes()),
        );

        let draft = EntryDraft {
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-6A".to_string(),
            payload: json!({"document_hash":"abc123","event":"BID_OPENED"}),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Hybrid,
            encryption_passphrase: None,
            authorized_readers: vec!["did:ledger:reader".to_string()],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys,
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_130,
        };

        let entry = sign_entry(draft, &author).expect("sign hybrid entry");
        ensure_active_reader_grant(&entry, "did:ledger:reader", 1_736_500_131)
            .expect("active grant should verify");
    }

    #[test]
    fn hybrid_decrypt_rejects_expired_or_revoked_grant() {
        let author = WalletKeypair::generate();
        let reader_secret = StaticSecret::from([13u8; 32]);
        let reader_public = X25519PublicKey::from(&reader_secret);

        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert(
            "did:ledger:reader".to_string(),
            hex::encode(reader_public.as_bytes()),
        );

        let draft = EntryDraft {
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-6".to_string(),
            payload: json!({"document_hash":"abc123","event":"BID_OPENED"}),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Hybrid,
            encryption_passphrase: None,
            authorized_readers: vec!["did:ledger:reader".to_string()],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys,
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_130,
        };

        let entry = sign_entry(draft, &author).expect("sign hybrid entry");

        let expired = decrypt_payload_with_hybrid(
            &entry,
            "did:ledger:reader",
            &hex::encode(reader_secret.to_bytes()),
            &hex::encode(X25519PublicKey::from(&x25519_secret_from_wallet(&author)).as_bytes()),
            1_739_180_731,
        )
        .expect_err("expired grant must be denied");
        let expired_msg = expired.to_string();
        assert!(
            expired_msg.contains("consent receipt expired")
                || expired_msg.contains("consent grant is expired")
        );

        let mut revoked_entry = entry.clone();
        revoked_entry.revocation_events.push(RevocationEvent {
            event_id: "rev-1".to_string(),
            data_hash: "deadbeef".to_string(),
            reader_id: "did:ledger:reader".to_string(),
            timestamp: 1_736_500_131,
            threshold_signatures: vec![],
        });

        let revoked = decrypt_payload_with_hybrid(
            &revoked_entry,
            "did:ledger:reader",
            &hex::encode(reader_secret.to_bytes()),
            &hex::encode(X25519PublicKey::from(&x25519_secret_from_wallet(&author)).as_bytes()),
            1_736_500_132,
        )
        .expect_err("revoked grant must be denied");
        assert!(revoked.to_string().contains("grant has been revoked"));
    }

    #[test]
    fn hybrid_decrypt_accepts_legacy_wrap_algorithm_label() {
        let author = WalletKeypair::generate();
        let reader_secret = StaticSecret::from([21u8; 32]);
        let reader_public = X25519PublicKey::from(&reader_secret);

        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert(
            "did:ledger:reader".to_string(),
            hex::encode(reader_public.as_bytes()),
        );

        let draft = EntryDraft {
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "AUD-7".to_string(),
            payload: json!({"document_hash":"abc123","event":"BID_OPENED"}),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Hybrid,
            encryption_passphrase: None,
            authorized_readers: vec!["did:ledger:reader".to_string()],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys,
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_140,
        };

        let mut entry = sign_entry(draft, &author).expect("sign hybrid entry");
        entry.key_wrapped_secrets[0].wrap_algorithm = "x25519-chacha20poly1305".to_string();

        let decrypted = decrypt_payload_with_hybrid(
            &entry,
            "did:ledger:reader",
            &hex::encode(reader_secret.to_bytes()),
            &hex::encode(X25519PublicKey::from(&x25519_secret_from_wallet(&author)).as_bytes()),
            1_736_500_141,
        )
        .expect("legacy label should remain decryptable");

        assert_eq!(decrypted["event"], "BID_OPENED");
    }

    #[test]
    fn hybrid_decrypt_rejects_caller_key_mismatch_for_did_key_reader() {
        let author = WalletKeypair::generate();
        let authorized_secret = StaticSecret::from([31u8; 32]);
        let authorized_public = X25519PublicKey::from(&authorized_secret);
        let impostor_secret = StaticSecret::from([32u8; 32]);

        let authorized_did = format!(
            "did:key:x25519:{}",
            hex::encode(authorized_public.as_bytes())
        );

        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert(
            authorized_did.clone(),
            hex::encode(authorized_public.as_bytes()),
        );

        let draft = EntryDraft {
            namespace: "forms.commitment".to_string(),
            action: "SUBMIT_ONBOARDING_INTEREST".to_string(),
            object_id: "onboarding_submission:test".to_string(),
            payload: json!({"data_hash":"sha256:abc","encrypted_form_url":"interest_submissions://test"}),
            privacy_flag: true,
            privacy_mode: PrivacyMode::Hybrid,
            encryption_passphrase: None,
            authorized_readers: vec![authorized_did.clone()],
            custodian_policy_id: None,
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            field_reader_acls: Default::default(),
            reader_public_keys,
            author: "did:ledger:auditor".to_string(),
            timestamp: 1_736_500_150,
        };

        let entry = sign_entry(draft, &author).expect("sign hybrid entry");
        let err = decrypt_payload_with_hybrid(
            &entry,
            &authorized_did,
            &hex::encode(impostor_secret.to_bytes()),
            &hex::encode(X25519PublicKey::from(&x25519_secret_from_wallet(&author)).as_bytes()),
            1_736_500_151,
        )
        .expect_err("key mismatch must be rejected");

        assert!(err
            .to_string()
            .contains("caller DID does not match provided X25519 private key"));
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

    #[test]
    fn partitions_payload_by_namespace_policy_deterministically() {
        let payload = json!({
            "audit": {
                "event": "BID_OPENED",
                "meta": {"seq": 7, "region": "us-east"},
                "private": {
                    "bidder_email": "alice@example.org",
                    "sealed": {"amount": 1200, "currency": "USD"}
                }
            }
        });
        let policy = NamespaceFieldPolicy {
            namespace: "audit.procurement".to_string(),
            policy_version: 1,
            public_fields: vec!["audit.event".to_string(), "audit.meta.region".to_string()],
            committed_fields: vec!["audit.meta".to_string()],
            offchain_encrypted_fields: vec![
                "audit.private.bidder_email".to_string(),
                "audit.private.sealed".to_string(),
            ],
        };

        let partitioned = partition_payload_by_field_policy("audit.procurement", &payload, &policy)
            .expect("partition payload");

        assert_eq!(
            partitioned.public_fields.get("audit.event"),
            Some(&json!("BID_OPENED"))
        );
        assert_eq!(
            partitioned.public_fields.get("audit.meta.region"),
            Some(&json!("us-east"))
        );
        assert_eq!(
            partitioned
                .offchain_encrypted_fields
                .get("audit.private.bidder_email"),
            Some(&json!("alice@example.org"))
        );

        let committed_meta = partitioned
            .committed_fields
            .get("audit.meta")
            .expect("committed audit.meta field");
        assert_eq!(
            committed_meta.canonical_value,
            r#"{"region":"us-east","seq":7}"#
        );
        assert_eq!(
            committed_meta.commitment_sha256,
            "0b0289363ff2fdebb5cf8b38a8d6c7244baa099df4ab28d59b13c144261a972c"
        );
    }

    #[test]
    fn rejects_overlapping_field_policy_sets() {
        let payload = json!({"audit": {"event": "BID_OPENED"}});
        let policy = NamespaceFieldPolicy {
            namespace: "audit.procurement".to_string(),
            policy_version: 1,
            public_fields: vec!["audit.event".to_string()],
            committed_fields: vec![],
            offchain_encrypted_fields: vec!["audit.event".to_string()],
        };

        let err = partition_payload_by_field_policy("audit.procurement", &payload, &policy)
            .expect_err("overlapping field path must fail");
        assert!(err
            .to_string()
            .contains("cannot be present in both public_fields and offchain_encrypted_fields"));
    }

    #[test]
    fn computes_file_manifest_commitment_from_shared_vectors() {
        let fixture: Value = serde_json::from_slice(include_bytes!(
            "../../../docs/test-vectors/file_commitment_test_vectors.json"
        ))
        .expect("parse file commitment vectors");
        let vectors = fixture["vectors"]
            .as_array()
            .expect("vectors should be an array");

        for vector in vectors {
            let manifest = vector.get("manifest").expect("manifest fixture");
            let expected = vector["expected_sha256"]
                .as_str()
                .expect("expected hash fixture");
            let computed =
                compute_file_manifest_commitment(manifest).expect("compute manifest commitment");
            assert_eq!(computed, expected);
        }
    }

    #[test]
    fn computes_payload_field_commitments_from_shared_vectors() {
        let fixture: Value = serde_json::from_slice(include_bytes!(
            "../../../docs/test-vectors/payload_field_commitment_test_vectors.json"
        ))
        .expect("parse payload field commitment vectors");
        let vectors = fixture["vectors"]
            .as_array()
            .expect("vectors should be an array");

        for vector in vectors {
            let input = vector
                .get("field_commitment_input")
                .expect("field commitment fixture");
            let expected = vector["expected_sha256"]
                .as_str()
                .expect("expected hash fixture");
            let computed =
                compute_payload_field_commitment(input).expect("compute payload field commitment");
            assert_eq!(computed, expected);
            verify_payload_field_commitment(input, expected)
                .expect("verify payload field commitment");
        }
    }

    #[test]
    fn rejects_payload_field_commitment_mismatch() {
        let input = json!({
            "schema_version": "1.0.0",
            "namespace": "identity.citizen",
            "entry_id": "entry-2001",
            "policy_version": 1,
            "fields": [
                {
                    "field_path": "claims.address",
                    "ciphertext_hash": "sha256:3c8c1af6f9d6e2f6de53726d97cf3dc2e31de4d12888da265fa1f49f8f465f4f"
                }
            ]
        });

        let err = verify_payload_field_commitment(&input, "sha256:00")
            .expect_err("mismatched payload field commitment should fail");
        assert!(err
            .to_string()
            .contains("payload field commitment mismatch"));
    }

    #[test]
    fn verifies_offchain_file_object_hash_and_manifest_commitment() {
        let ciphertext = b"ciphertext bytes for deterministic hash";
        let ciphertext_hash = format!("sha256:{}", hex::encode(Sha256::digest(ciphertext)));
        let manifest = serde_json::json!({
            "schema_version": "1.0.0",
            "file_ref": "local://ciphertexts/example.bin",
            "ciphertext_hash": ciphertext_hash,
            "consent_receipt_ref": "receipt:abc-123",
            "encryption": { "mode": "passphrase_file" }
        });
        let commitment = compute_file_manifest_commitment(&manifest).expect("compute commitment");

        verify_offchain_file_reconciliation(&manifest, &commitment, ciphertext)
            .expect("reconciliation should succeed");

        let mismatch = verify_offchain_file_reconciliation(&manifest, "sha256:00", ciphertext)
            .expect_err("mismatched commitment should fail");
        assert!(mismatch
            .to_string()
            .contains("manifest commitment mismatch"));
    }

    #[test]
    fn encrypts_and_decrypts_offchain_file_stream_without_full_buffering() {
        let plaintext = vec![0x5a; OFFCHAIN_FILE_CHUNK_SIZE_BYTES * 2 + 17];
        let mut plaintext_reader = Cursor::new(plaintext.clone());
        let mut ciphertext = Vec::new();

        let metadata = encrypt_offchain_file_reader_to_writer(
            &mut plaintext_reader,
            &mut ciphertext,
            "stream-passphrase",
        )
        .expect("encrypt offchain file stream");

        assert_eq!(metadata.kdf, "argon2id");
        assert_eq!(
            metadata.chunk_size_bytes as usize,
            OFFCHAIN_FILE_CHUNK_SIZE_BYTES
        );

        let mut ciphertext_reader = Cursor::new(ciphertext);
        let mut decrypted = Vec::new();
        decrypt_offchain_file_reader_to_writer(
            &mut ciphertext_reader,
            &mut decrypted,
            &metadata,
            "stream-passphrase",
        )
        .expect("decrypt offchain file stream");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn rejects_offchain_file_stream_decrypt_with_wrong_passphrase() {
        let mut plaintext_reader = Cursor::new(b"deterministic offchain ciphertext".to_vec());
        let mut ciphertext = Vec::new();
        let metadata = encrypt_offchain_file_reader_to_writer(
            &mut plaintext_reader,
            &mut ciphertext,
            "correct-passphrase",
        )
        .expect("encrypt offchain file stream");

        let mut ciphertext_reader = Cursor::new(ciphertext);
        let mut decrypted = Vec::new();
        let err = decrypt_offchain_file_reader_to_writer(
            &mut ciphertext_reader,
            &mut decrypted,
            &metadata,
            "wrong-passphrase",
        )
        .expect_err("wrong passphrase must fail decrypt");
        assert!(err.to_string().contains("failed to decrypt file chunk"));
    }

    #[test]
    fn encrypts_and_decrypts_offchain_file_stream_with_hybrid_reader_keys() {
        let author = WalletKeypair::generate();
        let reader_secret = StaticSecret::from([42u8; 32]);
        let reader_public = X25519PublicKey::from(&reader_secret);
        let reader_did = format!("did:key:x25519:{}", hex::encode(reader_public.as_bytes()));
        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert(reader_did.clone(), hex::encode(reader_public.as_bytes()));

        let plaintext = b"hybrid offchain attachment ciphertext".to_vec();
        let mut plaintext_reader = Cursor::new(plaintext.clone());
        let mut ciphertext = Vec::new();
        let metadata = encrypt_offchain_file_reader_to_writer_hybrid(
            &mut plaintext_reader,
            &mut ciphertext,
            &author,
            std::slice::from_ref(&reader_did),
            &reader_public_keys,
            "offchain-file-1",
        )
        .expect("encrypt hybrid offchain file");
        assert_eq!(metadata.key_wrapped_secrets.len(), 1);

        let mut ciphertext_reader = Cursor::new(ciphertext);
        let mut decrypted = Vec::new();
        decrypt_offchain_file_reader_to_writer_hybrid(
            &mut ciphertext_reader,
            &mut decrypted,
            &metadata,
            &reader_did,
            &hex::encode(reader_secret.to_bytes()),
        )
        .expect("decrypt hybrid offchain file");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn hybrid_offchain_file_stream_rejects_non_granted_reader() {
        let author = WalletKeypair::generate();
        let granted_secret = StaticSecret::from([9u8; 32]);
        let granted_public = X25519PublicKey::from(&granted_secret);
        let granted_did = format!("did:key:x25519:{}", hex::encode(granted_public.as_bytes()));
        let mut reader_public_keys = BTreeMap::new();
        reader_public_keys.insert(granted_did.clone(), hex::encode(granted_public.as_bytes()));
        let mut plaintext_reader = Cursor::new(b"hybrid file".to_vec());
        let mut ciphertext = Vec::new();
        let metadata = encrypt_offchain_file_reader_to_writer_hybrid(
            &mut plaintext_reader,
            &mut ciphertext,
            &author,
            std::slice::from_ref(&granted_did),
            &reader_public_keys,
            "offchain-file-2",
        )
        .expect("encrypt hybrid offchain file");

        let denied_secret = StaticSecret::from([10u8; 32]);
        let denied_public = X25519PublicKey::from(&denied_secret);
        let denied_did = format!("did:key:x25519:{}", hex::encode(denied_public.as_bytes()));
        let mut ciphertext_reader = Cursor::new(ciphertext);
        let mut decrypted = Vec::new();
        let err = decrypt_offchain_file_reader_to_writer_hybrid(
            &mut ciphertext_reader,
            &mut decrypted,
            &metadata,
            &denied_did,
            &hex::encode(denied_secret.to_bytes()),
        )
        .expect_err("non-granted reader must fail");
        assert!(err.to_string().contains("no DEK wrap found for caller DID"));
    }

    struct PatternReader {
        remaining: usize,
        pattern: u8,
    }

    impl PatternReader {
        fn new(total_bytes: usize, pattern: u8) -> Self {
            Self {
                remaining: total_bytes,
                pattern,
            }
        }
    }

    impl Read for PatternReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.remaining == 0 {
                return Ok(0);
            }
            let to_fill = self.remaining.min(buf.len());
            buf[..to_fill].fill(self.pattern);
            self.remaining -= to_fill;
            Ok(to_fill)
        }
    }

    fn hash_pattern_bytes(total_bytes: usize, pattern: u8) -> String {
        let mut reader = PatternReader::new(total_bytes, pattern);
        let mut hasher = Sha256::new();
        let mut chunk = [0_u8; 1024 * 1024];
        loop {
            let read = reader.read(&mut chunk).expect("read pattern bytes");
            if read == 0 {
                break;
            }
            hasher.update(&chunk[..read]);
        }
        format!("sha256:{}", hex::encode(hasher.finalize()))
    }

    #[test]
    #[ignore = "performance validation for large off-chain blobs"]
    fn verifies_offchain_file_object_hash_for_large_ciphertext_streams() {
        for (label, size_bytes) in [
            ("10MB", 10 * 1024 * 1024usize),
            ("100MB", 100 * 1024 * 1024usize),
            ("1GB", 1024 * 1024 * 1024usize),
        ] {
            let expected_hash = hash_pattern_bytes(size_bytes, 0xAB);
            let manifest = json!({
                "ciphertext_hash": expected_hash,
                "file_ref": format!("perf://{label}")
            });
            let mut reader = PatternReader::new(size_bytes, 0xAB);
            verify_offchain_file_object_hash_reader(&manifest, &mut reader)
                .unwrap_or_else(|_| panic!("{label} stream hash verification should pass"));
        }
    }

    #[test]
    #[ignore = "performance validation for high-field-count payload partitioning"]
    fn partitions_high_field_count_payload_with_mixed_visibility_sets() {
        let field_count = 4_000;
        let mut record = serde_json::Map::new();
        let mut public_fields = Vec::new();
        let mut committed_fields = Vec::new();
        let mut encrypted_fields = Vec::new();

        for index in 0..field_count {
            let field_name = format!("field_{index}");
            record.insert(field_name.clone(), json!(index));
            let path = format!("record.{field_name}");
            match index % 3 {
                0 => public_fields.push(path),
                1 => committed_fields.push(path),
                _ => encrypted_fields.push(path),
            }
        }

        let payload = json!({ "record": Value::Object(record) });
        let policy = NamespaceFieldPolicy {
            namespace: "audit.procurement".to_string(),
            policy_version: 3,
            public_fields,
            committed_fields,
            offchain_encrypted_fields: encrypted_fields,
        };

        let partitioned = partition_payload_by_field_policy("audit.procurement", &payload, &policy)
            .expect("partition large mixed payload");
        assert_eq!(partitioned.public_fields.len(), 1_334);
        assert_eq!(partitioned.committed_fields.len(), 1_333);
        assert_eq!(partitioned.offchain_encrypted_fields.len(), 1_333);
    }

    #[test]
    fn derives_deterministic_keypair_from_mnemonic() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let key_a = WalletKeypair::from_mnemonic(
            Uuid::new_v4(),
            phrase,
            Some("wallet-passphrase"),
            Some("m/44'/930'/0'/0'/0'"),
        )
        .expect("derive key a");
        let key_b = WalletKeypair::from_mnemonic(
            Uuid::new_v4(),
            phrase,
            Some("wallet-passphrase"),
            Some("m/44'/930'/0'/0'/0'"),
        )
        .expect("derive key b");
        assert_eq!(key_a.verifying_key_hex(), key_b.verifying_key_hex());
    }

    #[test]
    fn rejects_non_hardened_derivation_paths_for_mnemonic_keys() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let err =
            WalletKeypair::from_mnemonic(Uuid::new_v4(), phrase, None, Some("m/44'/930'/0'/0/0"))
                .expect_err("non-hardened path must fail");
        assert!(err
            .to_string()
            .contains("only hardened segments are supported"));
    }
}
