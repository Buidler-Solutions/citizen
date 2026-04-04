use chrono::Utc;
use citizen_types::PrivacyMode;
use citizen_types::{LedgerEntry, SignedEnvelope};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::{
    compute_file_manifest_commitment, decrypt_secret_key, encrypt_secret_key,
    generate_mnemonic_phrase, parse_verifying_key, sign_entry, verify_entry_signature,
    verify_offchain_file_reconciliation, ActionPolicy, EncryptedSecretKey, EntryDraft,
    WalletKeypair,
};

#[derive(Debug, Parser)]
#[command(name = "citizen-wallet", version, about = "CITIZEN wallet CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Init {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
    },
    Keygen {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        password: Option<String>,
        #[arg(long)]
        with_mnemonic: bool,
        #[arg(long, default_value_t = 12, value_parser = parse_mnemonic_word_count)]
        mnemonic_words: u8,
        #[arg(long)]
        mnemonic_passphrase: Option<String>,
        #[arg(long, default_value = "m/44'/930'/0'/0'/0'")]
        derivation_path: String,
    },
    ImportKey {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        key_id: Option<Uuid>,
        #[arg(long)]
        secret_key_hex: String,
        #[arg(long)]
        password: Option<String>,
    },
    ImportMnemonic {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        key_id: Option<Uuid>,
        #[arg(long)]
        mnemonic: Option<String>,
        #[arg(long)]
        mnemonic_passphrase: Option<String>,
        #[arg(long, default_value = "m/44'/930'/0'/0'/0'")]
        derivation_path: String,
        #[arg(long)]
        password: Option<String>,
    },
    PublicKey {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
    },
    ExportKey {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long)]
        include_secret: bool,
        #[arg(long)]
        password: Option<String>,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    ListKeys {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
    },
    SignEntry {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long)]
        namespace: String,
        #[arg(long)]
        action: String,
        #[arg(long)]
        object_id: String,
        #[arg(long)]
        author: String,
        #[arg(long)]
        payload_json: String,
        #[arg(long)]
        timestamp: Option<i64>,
        #[arg(long)]
        password: Option<String>,
        #[arg(long = "encrypt", alias = "private")]
        encrypt: bool,
        #[arg(long)]
        encryption_opt_in: bool,
        #[arg(long)]
        encryption_passphrase: Option<String>,
    },
    VerifyEntry {
        #[arg(long)]
        entry_json: String,
        #[arg(long)]
        public_key: String,
    },
    Submit {
        #[arg(long)]
        entry_json: String,
        #[arg(long, default_value = "http://127.0.0.1:8080")]
        api_url: String,
        #[arg(long, default_value = "/api/v1/envelopes/submit")]
        endpoint: String,
        #[arg(long, default_value = "wallet-receipts.json")]
        receipts_path: PathBuf,
    },
    ListReceipts {
        #[arg(long, default_value = "wallet-receipts.json")]
        receipts_path: PathBuf,
    },
    VerifyReceipt {
        #[arg(long)]
        receipt_json: String,
        #[arg(long)]
        entry_json: String,
    },
    VerifyOffchainFile {
        #[arg(long)]
        manifest_json: String,
        #[arg(long)]
        payload_commitment: String,
        #[arg(long)]
        ciphertext_path: PathBuf,
    },
    SignIdentityRegister {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long)]
        subject: String,
        #[arg(long)]
        claims_hash: String,
        #[arg(long)]
        author: String,
        #[arg(long)]
        timestamp: Option<i64>,
        #[arg(long)]
        password: Option<String>,
        #[arg(long = "encrypt", alias = "private")]
        encrypt: bool,
        #[arg(long)]
        encryption_opt_in: bool,
        #[arg(long)]
        encryption_passphrase: Option<String>,
    },
    SignGovernanceVote {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long)]
        proposal_id: String,
        #[arg(long)]
        vote: String,
        #[arg(long)]
        validator: String,
        #[arg(long)]
        author: String,
        #[arg(long)]
        timestamp: Option<i64>,
        #[arg(long)]
        password: Option<String>,
        #[arg(long = "encrypt", alias = "private")]
        encrypt: bool,
        #[arg(long)]
        encryption_opt_in: bool,
        #[arg(long)]
        encryption_passphrase: Option<String>,
        #[arg(long)]
        required_approvals: Option<usize>,
        #[arg(long = "policy-approver")]
        policy_approvers: Vec<String>,
        #[arg(long = "approval")]
        approvals: Vec<String>,
    },
    SignRegistryTransfer {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long)]
        parcel_id: String,
        #[arg(long)]
        from: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        author: String,
        #[arg(long)]
        timestamp: Option<i64>,
        #[arg(long)]
        password: Option<String>,
        #[arg(long = "encrypt", alias = "private")]
        encrypt: bool,
        #[arg(long)]
        encryption_opt_in: bool,
        #[arg(long)]
        encryption_passphrase: Option<String>,
    },
    SignAuditRecord {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long)]
        event: String,
        #[arg(long)]
        document_hash: String,
        #[arg(long)]
        audit_id: String,
        #[arg(long)]
        author: String,
        #[arg(long)]
        timestamp: Option<i64>,
        #[arg(long)]
        password: Option<String>,
        #[arg(long = "encrypt", alias = "private")]
        encrypt: bool,
        #[arg(long)]
        encryption_opt_in: bool,
        #[arg(long)]
        encryption_passphrase: Option<String>,
    },
    SignBuilderCreditProof {
        #[arg(long)]
        entry_json: String,
        #[arg(long)]
        approver: String,
        #[arg(long)]
        secret_key_hex: String,
        #[arg(long)]
        expected_public_key: Option<String>,
    },
    SignBuilderCreditGrant {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long)]
        grant_id: String,
        #[arg(long)]
        amount: u64,
        #[arg(long)]
        author: String,
        #[arg(long)]
        sponsor_builder_id: Option<String>,
        #[arg(long)]
        target_builder_id: Option<String>,
        #[arg(long)]
        multisig_proofs_json: Option<String>,
        #[arg(long)]
        timestamp: Option<i64>,
        #[arg(long)]
        password: Option<String>,
    },
    SignSponsorUsage {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long)]
        sponsorship_id: String,
        #[arg(long)]
        credit_grant_id: String,
        #[arg(long)]
        amount: u64,
        #[arg(long)]
        sponsored_did: String,
        #[arg(long)]
        author: String,
        #[arg(long)]
        sponsor_builder_id: Option<String>,
        #[arg(long)]
        timestamp: Option<i64>,
        #[arg(long)]
        password: Option<String>,
    },
}

#[derive(Debug, Serialize)]
struct BuilderCreditProof {
    approver: String,
    public_key: String,
    signature: String,
    signing_payload: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Keystore {
    version: u32,
    keys: Vec<KeyRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
struct KeyRecord {
    key_id: Uuid,
    label: Option<String>,
    public_key_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_key_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_secret_key: Option<EncryptedSecretKey>,
    created_at: i64,
}

#[derive(Debug, Serialize)]
struct KeySummary {
    key_id: Uuid,
    label: Option<String>,
    public_key_hex: String,
    created_at: i64,
    has_encrypted_secret_key: bool,
}

#[derive(Debug, Serialize)]
struct KeyExport {
    key_id: Uuid,
    label: Option<String>,
    public_key_hex: String,
    created_at: i64,
    encrypted_secret_key: Option<EncryptedSecretKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_key_hex: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ReceiptStore {
    version: u32,
    receipts: Vec<SubmissionReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubmissionReceipt {
    entry_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    tx_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    block_height: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    merkle_proof: Option<MerkleProof>,
    status: String,
    submitted_at: i64,
    api_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MerkleProof {
    root_hash: String,
    siblings: Vec<MerkleProofSibling>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MerkleProofSibling {
    hash: String,
    position: MerkleSiblingPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MerkleSiblingPosition {
    Left,
    Right,
}

impl Keystore {
    fn load_or_create(path: &Path) -> anyhow::Result<Self> {
        if path.exists() {
            let contents = fs::read_to_string(path)?;
            Ok(serde_json::from_str(&contents)?)
        } else {
            Ok(Self {
                version: 1,
                keys: Vec::new(),
            })
        }
    }

    fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let contents = serde_json::to_string_pretty(self)?;
        fs::write(path, contents)?;
        Ok(())
    }

    fn add_key(&mut self, record: KeyRecord) {
        self.keys.push(record);
    }

    fn find_key(&self, key_id: Uuid) -> Option<&KeyRecord> {
        self.keys.iter().find(|record| record.key_id == key_id)
    }

    fn has_key(&self, key_id: Uuid) -> bool {
        self.find_key(key_id).is_some()
    }
}

impl ReceiptStore {
    fn load_or_create(path: &Path) -> anyhow::Result<Self> {
        if path.exists() {
            let contents = fs::read_to_string(path)?;
            Ok(serde_json::from_str(&contents)?)
        } else {
            Ok(Self {
                version: 1,
                receipts: Vec::new(),
            })
        }
    }

    fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let contents = serde_json::to_string_pretty(self)?;
        fs::write(path, contents)?;
        Ok(())
    }

    fn add_receipt(&mut self, receipt: SubmissionReceipt) {
        self.receipts.push(receipt);
    }
}

pub fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init { path } => {
            let store = Keystore {
                version: 1,
                keys: Vec::new(),
            };
            store.save(&path)?;
            println!("Initialized keystore at {}", path.display());
        }
        Commands::Keygen {
            path,
            label,
            password,
            with_mnemonic,
            mnemonic_words,
            mnemonic_passphrase,
            derivation_path,
        } => {
            let mut store = Keystore::load_or_create(&path)?;
            let keypair = if with_mnemonic {
                let mnemonic = generate_mnemonic_phrase(mnemonic_words as usize)?;
                let keypair = WalletKeypair::from_mnemonic(
                    Uuid::new_v4(),
                    &mnemonic,
                    mnemonic_passphrase.as_deref(),
                    Some(&derivation_path),
                )?;
                println!("Mnemonic phrase: {mnemonic}");
                println!("Derivation path: {derivation_path}");
                keypair
            } else {
                WalletKeypair::generate()
            };
            let password = load_password(password)?;
            let encrypted = encrypt_secret_key(keypair.secret_key_bytes(), &password)?;
            let record = KeyRecord {
                key_id: keypair.key_id,
                label,
                public_key_hex: keypair.verifying_key_hex(),
                secret_key_hex: None,
                encrypted_secret_key: Some(encrypted),
                created_at: Utc::now().timestamp(),
            };
            store.add_key(record);
            store.save(&path)?;
            println!("Generated key {}", keypair.key_id);
        }
        Commands::ImportKey {
            path,
            label,
            key_id,
            secret_key_hex,
            password,
        } => {
            let mut store = Keystore::load_or_create(&path)?;
            let password = load_password(password)?;
            let key_id = key_id.unwrap_or_else(Uuid::new_v4);
            if store.has_key(key_id) {
                return Err(anyhow::anyhow!("key_id {key_id} already exists"));
            }
            let secret_bytes = hex::decode(&secret_key_hex)?;
            let keypair = WalletKeypair::from_secret_bytes(key_id, &secret_bytes)?;
            let encrypted = encrypt_secret_key(keypair.secret_key_bytes(), &password)?;
            let record = KeyRecord {
                key_id: keypair.key_id,
                label,
                public_key_hex: keypair.verifying_key_hex(),
                secret_key_hex: None,
                encrypted_secret_key: Some(encrypted),
                created_at: Utc::now().timestamp(),
            };
            store.add_key(record);
            store.save(&path)?;
            println!("Imported key {}", keypair.key_id);
        }
        Commands::ImportMnemonic {
            path,
            label,
            key_id,
            mnemonic,
            mnemonic_passphrase,
            derivation_path,
            password,
        } => {
            let mut store = Keystore::load_or_create(&path)?;
            let password = load_password(password)?;
            let key_id = key_id.unwrap_or_else(Uuid::new_v4);
            if store.has_key(key_id) {
                return Err(anyhow::anyhow!("key_id {key_id} already exists"));
            }
            let mnemonic = load_mnemonic_phrase(mnemonic)?;
            let keypair = WalletKeypair::from_mnemonic(
                key_id,
                &mnemonic,
                mnemonic_passphrase.as_deref(),
                Some(&derivation_path),
            )?;
            let encrypted = encrypt_secret_key(keypair.secret_key_bytes(), &password)?;
            let record = KeyRecord {
                key_id: keypair.key_id,
                label,
                public_key_hex: keypair.verifying_key_hex(),
                secret_key_hex: None,
                encrypted_secret_key: Some(encrypted),
                created_at: Utc::now().timestamp(),
            };
            store.add_key(record);
            store.save(&path)?;
            println!("Imported mnemonic key {}", keypair.key_id);
            println!("Derivation path: {derivation_path}");
        }
        Commands::PublicKey { path, key_id } => {
            let store = Keystore::load_or_create(&path)?;
            let record = store
                .find_key(key_id)
                .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
            println!("{}", record.public_key_hex);
        }
        Commands::ExportKey {
            path,
            key_id,
            include_secret,
            password,
            output,
        } => {
            let store = Keystore::load_or_create(&path)?;
            let record = store
                .find_key(key_id)
                .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
            let secret_key_hex = if include_secret {
                let secret = load_secret_key_bytes(record, password)?;
                Some(hex::encode(secret))
            } else {
                None
            };
            let export = KeyExport {
                key_id: record.key_id,
                label: record.label.clone(),
                public_key_hex: record.public_key_hex.clone(),
                created_at: record.created_at,
                encrypted_secret_key: record.encrypted_secret_key.clone(),
                secret_key_hex,
            };
            let output_json = serde_json::to_string_pretty(&export)?;
            if let Some(output_path) = output {
                if let Some(parent) = output_path.parent() {
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent)?;
                    }
                }
                fs::write(&output_path, output_json)?;
                println!("Exported key {key_id} to {}", output_path.display());
            } else {
                println!("{output_json}");
            }
        }
        Commands::ListKeys { path } => {
            let store = Keystore::load_or_create(&path)?;
            let summaries: Vec<KeySummary> = store
                .keys
                .iter()
                .map(|record| KeySummary {
                    key_id: record.key_id,
                    label: record.label.clone(),
                    public_key_hex: record.public_key_hex.clone(),
                    created_at: record.created_at,
                    has_encrypted_secret_key: record.encrypted_secret_key.is_some(),
                })
                .collect();
            let output = serde_json::to_string_pretty(&summaries)?;
            println!("{output}");
        }
        Commands::SignEntry {
            path,
            key_id,
            namespace,
            action,
            object_id,
            author,
            payload_json,
            timestamp,
            password,
            encrypt,
            encryption_opt_in,
            encryption_passphrase,
        } => {
            let store = Keystore::load_or_create(&path)?;
            let record = store
                .find_key(key_id)
                .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
            let payload: Value = serde_json::from_str(&payload_json)?;
            let secret_bytes = load_secret_key_bytes(record, password)?;
            let keypair = WalletKeypair::from_secret_bytes(record.key_id, &secret_bytes)?;
            enforce_encryption_opt_in(encrypt, encryption_opt_in)?;
            let draft = EntryDraft {
                namespace,
                action,
                object_id,
                payload,
                privacy_flag: encrypt,
                privacy_mode: if encrypt {
                    PrivacyMode::Passphrase
                } else {
                    PrivacyMode::None
                },
                encryption_passphrase: load_encryption_passphrase(encrypt, encryption_passphrase)?,
                authorized_readers: vec![],
                custodian_policy_id: None,
                key_wrapped_secrets: vec![],
                revocation_events: vec![],
                field_reader_acls: Default::default(),
                reader_public_keys: BTreeMap::new(),
                author,
                timestamp: timestamp.unwrap_or_else(|| Utc::now().timestamp()),
            };
            let entry = sign_entry(draft, &keypair)?;
            let entry_json = serde_json::to_string_pretty(&entry)?;
            println!("{entry_json}");
        }
        Commands::VerifyEntry {
            entry_json,
            public_key,
        } => {
            let entry: LedgerEntry = serde_json::from_str(&entry_json)?;
            let verifying_key = parse_verifying_key(&public_key)?;
            verify_entry_signature(&entry, &verifying_key)?;
            println!("Signature verified.");
        }
        Commands::Submit {
            entry_json,
            api_url,
            endpoint,
            receipts_path,
        } => {
            let entry: LedgerEntry = serde_json::from_str(&entry_json)?;
            let receipt = submit_entry(&api_url, &endpoint, &entry)?;
            let mut store = ReceiptStore::load_or_create(&receipts_path)?;
            store.add_receipt(receipt.clone());
            store.save(&receipts_path)?;
            println!("{}", serde_json::to_string_pretty(&receipt)?);
        }
        Commands::ListReceipts { receipts_path } => {
            let store = ReceiptStore::load_or_create(&receipts_path)?;
            println!("{}", serde_json::to_string_pretty(&store.receipts)?);
        }
        Commands::VerifyReceipt {
            receipt_json,
            entry_json,
        } => {
            let receipt: SubmissionReceipt = serde_json::from_str(&receipt_json)?;
            let entry: LedgerEntry = serde_json::from_str(&entry_json)?;
            verify_receipt(&receipt, &entry)?;
            println!("Receipt verified.");
        }
        Commands::VerifyOffchainFile {
            manifest_json,
            payload_commitment,
            ciphertext_path,
        } => {
            let manifest: Value = serde_json::from_str(&manifest_json)?;
            let ciphertext_bytes = fs::read(&ciphertext_path)?;
            verify_offchain_file_reconciliation(&manifest, &payload_commitment, &ciphertext_bytes)
                .map_err(|err| anyhow::anyhow!(err.to_string()))?;
            let computed_commitment = compute_file_manifest_commitment(&manifest)
                .map_err(|err| anyhow::anyhow!(err.to_string()))?;
            println!(
                "Off-chain file verified (payload_commitment={}, ciphertext_path={})",
                computed_commitment,
                ciphertext_path.display()
            );
        }
        Commands::SignIdentityRegister {
            path,
            key_id,
            subject,
            claims_hash,
            author,
            timestamp,
            password,
            encrypt,
            encryption_opt_in,
            encryption_passphrase,
        } => {
            let payload = serde_json::json!({
                "subject": subject.clone(),
                "claims_hash": claims_hash,
            });
            sign_namespace_entry(
                &path,
                key_id,
                "identity.citizen",
                "REGISTER_IDENTITY",
                subject,
                author,
                payload,
                timestamp,
                password,
                encrypt,
                encryption_opt_in,
                encryption_passphrase,
            )?;
        }
        Commands::SignGovernanceVote {
            path,
            key_id,
            proposal_id,
            vote,
            validator,
            author,
            timestamp,
            password,
            required_approvals,
            policy_approvers,
            approvals,
            encrypt,
            encryption_opt_in,
            encryption_passphrase,
        } => {
            enforce_policy_for_action(
                "CAST_VOTE",
                required_approvals,
                policy_approvers,
                approvals,
            )?;
            let payload = serde_json::json!({
                "proposal_id": proposal_id.clone(),
                "vote": vote,
                "validator": validator,
            });
            sign_namespace_entry(
                &path,
                key_id,
                "governance.vote",
                "CAST_VOTE",
                proposal_id,
                author,
                payload,
                timestamp,
                password,
                encrypt,
                encryption_opt_in,
                encryption_passphrase,
            )?;
        }
        Commands::SignRegistryTransfer {
            path,
            key_id,
            parcel_id,
            from,
            to,
            author,
            timestamp,
            password,
            encrypt,
            encryption_opt_in,
            encryption_passphrase,
        } => {
            let payload = serde_json::json!({
                "parcel_id": parcel_id.clone(),
                "from": from,
                "to": to,
            });
            sign_namespace_entry(
                &path,
                key_id,
                "registry.land",
                "TRANSFER_OWNERSHIP",
                parcel_id,
                author,
                payload,
                timestamp,
                password,
                encrypt,
                encryption_opt_in,
                encryption_passphrase,
            )?;
        }
        Commands::SignAuditRecord {
            path,
            key_id,
            event,
            document_hash,
            audit_id,
            author,
            timestamp,
            password,
            encrypt,
            encryption_opt_in,
            encryption_passphrase,
        } => {
            let payload = serde_json::json!({
                "event": event,
                "document_hash": document_hash,
            });
            sign_namespace_entry(
                &path,
                key_id,
                "audit.procurement",
                "RECORD_EVENT",
                audit_id,
                author,
                payload,
                timestamp,
                password,
                encrypt,
                encryption_opt_in,
                encryption_passphrase,
            )?;
        }
        Commands::SignBuilderCreditProof {
            entry_json,
            approver,
            secret_key_hex,
            expected_public_key,
        } => {
            let entry: LedgerEntry = serde_json::from_str(&entry_json)?;
            let amount = entry
                .payload
                .get("amount")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    anyhow::anyhow!("entry payload.amount must be a positive integer")
                })?;
            let secret_bytes = hex::decode(secret_key_hex)?;
            let keypair = WalletKeypair::from_secret_bytes(Uuid::new_v4(), &secret_bytes)?;
            let public_key = keypair.verifying_key_hex();
            if let Some(expected) = expected_public_key {
                if expected != public_key {
                    return Err(anyhow::anyhow!(
                        "expected_public_key does not match derived key (expected={expected}, actual={public_key})"
                    ));
                }
            }
            let signing_payload = serde_json::to_string(&json!({
                "entry_id": entry.entry_id,
                "namespace": entry.namespace,
                "action": entry.action,
                "object_id": entry.object_id,
                "author": entry.author,
                "amount": amount,
                "timestamp": entry.timestamp,
                "approver": approver
            }))?;
            let signature = keypair.sign_bytes(signing_payload.as_bytes());
            let proof = BuilderCreditProof {
                approver,
                public_key,
                signature: hex::encode(signature.to_bytes()),
                signing_payload,
            };
            println!("{}", serde_json::to_string_pretty(&proof)?);
        }
        Commands::SignBuilderCreditGrant {
            path,
            key_id,
            grant_id,
            amount,
            author,
            sponsor_builder_id,
            target_builder_id,
            multisig_proofs_json,
            timestamp,
            password,
        } => {
            let mut payload = serde_json::json!({
                "amount": amount,
            });

            if let Some(sponsor_builder_id) = sponsor_builder_id {
                payload["sponsor_builder_id"] = json!(sponsor_builder_id);
            }

            if let Some(target_builder_id) = target_builder_id {
                payload["target_builder_id"] = json!(target_builder_id);
            }

            if let Some(multisig_proofs_json) = multisig_proofs_json {
                let proofs: Value = serde_json::from_str(&multisig_proofs_json)?;
                payload["multisig_proofs"] = proofs;
            }

            sign_namespace_entry(
                &path,
                key_id,
                "builder.credits",
                "MULTISIG_CREDIT_GRANT",
                grant_id,
                author,
                payload,
                timestamp,
                password,
                false,
                false,
                None,
            )?;
        }
        Commands::SignSponsorUsage {
            path,
            key_id,
            sponsorship_id,
            credit_grant_id,
            amount,
            sponsored_did,
            author,
            sponsor_builder_id,
            timestamp,
            password,
        } => {
            let mut payload = serde_json::json!({
                "sponsorship_id": sponsorship_id.clone(),
                "credit_grant_id": credit_grant_id,
                "amount": amount,
                "sponsored_did": sponsored_did,
            });

            if let Some(sponsor_builder_id) = sponsor_builder_id {
                payload["sponsor_builder_id"] = json!(sponsor_builder_id);
            }

            sign_namespace_entry(
                &path,
                key_id,
                "builder.credits",
                "SPONSOR_USAGE",
                format!("sponsorship:{sponsorship_id}"),
                author,
                payload,
                timestamp,
                password,
                false,
                false,
                None,
            )?;
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn sign_namespace_entry(
    path: &Path,
    key_id: Uuid,
    namespace: &str,
    action: &str,
    object_id: String,
    author: String,
    payload: Value,
    timestamp: Option<i64>,
    password: Option<String>,
    encrypt: bool,
    encryption_opt_in: bool,
    encryption_passphrase: Option<String>,
) -> anyhow::Result<()> {
    let store = Keystore::load_or_create(path)?;
    let record = store
        .find_key(key_id)
        .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
    let secret_bytes = load_secret_key_bytes(record, password)?;
    let keypair = WalletKeypair::from_secret_bytes(record.key_id, &secret_bytes)?;
    enforce_encryption_opt_in(encrypt, encryption_opt_in)?;
    let draft = EntryDraft {
        namespace: namespace.to_string(),
        action: action.to_string(),
        object_id,
        payload,
        privacy_flag: encrypt,
        privacy_mode: if encrypt {
            PrivacyMode::Passphrase
        } else {
            PrivacyMode::None
        },
        encryption_passphrase: load_encryption_passphrase(encrypt, encryption_passphrase)?,
        authorized_readers: vec![],
        custodian_policy_id: None,
        key_wrapped_secrets: vec![],
        revocation_events: vec![],
        field_reader_acls: Default::default(),
        reader_public_keys: BTreeMap::new(),
        author,
        timestamp: timestamp.unwrap_or_else(|| Utc::now().timestamp()),
    };
    let entry = sign_entry(draft, &keypair)?;
    let entry_json = serde_json::to_string_pretty(&entry)?;
    println!("{entry_json}");
    Ok(())
}

fn load_encryption_passphrase(
    encrypt: bool,
    explicit: Option<String>,
) -> anyhow::Result<Option<String>> {
    if !encrypt {
        return Ok(None);
    }
    eprintln!(
        "WARNING: --encrypt/--private stores only commitments on-chain; payload decryption requires this passphrase."
    );
    eprintln!(
        "MODE DISCLOSURE: privacy_mode=passphrase (single-holder decrypt unless shared grant/key-wrap mode is used)."
    );
    if let Some(passphrase) = explicit {
        return Ok(Some(passphrase));
    }
    std::env::var("CITIZEN_ENTRY_ENCRYPTION_PASSPHRASE")
        .map(Some)
        .map_err(|_| anyhow::anyhow!("encryption passphrase required (--encryption-passphrase or CITIZEN_ENTRY_ENCRYPTION_PASSPHRASE)"))
}

fn enforce_encryption_opt_in(encrypt: bool, encryption_opt_in: bool) -> anyhow::Result<()> {
    if encrypt && !encryption_opt_in {
        return Err(anyhow::anyhow!(
            "encryption opt-in acknowledgement required (--encryption-opt-in)"
        ));
    }
    Ok(())
}

fn enforce_policy_for_action(
    action: &str,
    required_approvals: Option<usize>,
    policy_approvers: Vec<String>,
    approvals: Vec<String>,
) -> anyhow::Result<()> {
    let Some(required_approvals) = required_approvals else {
        return Ok(());
    };
    if required_approvals == 0 {
        return Ok(());
    }
    if policy_approvers.is_empty() {
        return Err(anyhow::anyhow!(
            "policy approvers are required when --required-approvals is set"
        ));
    }
    let policy = ActionPolicy {
        action: action.to_string(),
        required_approvals,
        approvers: policy_approvers,
    };
    policy
        .evaluate(&approvals)
        .map_err(|err| anyhow::anyhow!("policy evaluation failed: {err}"))
}

fn load_password(explicit: Option<String>) -> anyhow::Result<String> {
    if let Some(password) = explicit {
        return Ok(password);
    }
    std::env::var("CITIZEN_WALLET_PASSWORD").map_err(|_| {
        anyhow::anyhow!("password required (pass --password or set CITIZEN_WALLET_PASSWORD)")
    })
}

fn load_mnemonic_phrase(explicit: Option<String>) -> anyhow::Result<String> {
    let mnemonic = if let Some(mnemonic) = explicit {
        mnemonic
    } else {
        std::env::var("CITIZEN_WALLET_MNEMONIC").map_err(|_| {
            anyhow::anyhow!("mnemonic required (pass --mnemonic or set CITIZEN_WALLET_MNEMONIC)")
        })?
    };
    validate_supported_mnemonic_phrase(&mnemonic)?;
    Ok(mnemonic)
}

fn parse_mnemonic_word_count(raw: &str) -> anyhow::Result<u8> {
    let value: u8 = raw
        .parse()
        .map_err(|_| anyhow::anyhow!("mnemonic words must be a number"))?;
    match value {
        12 | 24 => Ok(value),
        _ => Err(anyhow::anyhow!(
            "mnemonic word count must be 12 or 24 for wallet/browser extension compatibility"
        )),
    }
}

fn validate_supported_mnemonic_phrase(mnemonic: &str) -> anyhow::Result<()> {
    let words = mnemonic.split_whitespace().count();
    match words {
        12 | 24 => Ok(()),
        _ => Err(anyhow::anyhow!(
            "mnemonic phrase must contain exactly 12 or 24 words"
        )),
    }
}

fn load_secret_key_bytes(record: &KeyRecord, password: Option<String>) -> anyhow::Result<Vec<u8>> {
    if let Some(encrypted) = &record.encrypted_secret_key {
        let password = load_password(password)?;
        let secret = decrypt_secret_key(encrypted, &password)?;
        return Ok(secret.to_vec());
    }
    if let Some(secret_hex) = &record.secret_key_hex {
        let secret_bytes = hex::decode(secret_hex)?;
        return Ok(secret_bytes);
    }
    Err(anyhow::anyhow!(
        "no secret key found for key_id {}",
        record.key_id
    ))
}

fn submit_entry(
    api_url: &str,
    endpoint: &str,
    entry: &LedgerEntry,
) -> anyhow::Result<SubmissionReceipt> {
    let url = format!("{}{}", api_url.trim_end_matches('/'), endpoint);
    let envelope = SignedEnvelope {
        envelope_id: Uuid::new_v4(),
        signer: entry.author.clone(),
        signature: entry.signature.clone(),
        submitted_at: Utc::now(),
        payload: entry.clone(),
    };
    let response_json: Value = reqwest::blocking::Client::new()
        .post(url)
        .json(&envelope)
        .send()?
        .error_for_status()?
        .json()?;

    let canonical_receipt = response_json.get("receipt");
    let tx_hash = response_json
        .get("tx_hash")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let block_height = canonical_receipt
        .and_then(|receipt| receipt.get("finality"))
        .and_then(|finality| finality.get("block_height"))
        .and_then(Value::as_u64)
        .or_else(|| response_json.get("block_height").and_then(Value::as_u64));
    let status = canonical_receipt
        .and_then(|receipt| receipt.get("status"))
        .and_then(Value::as_str)
        .or_else(|| response_json.get("status").and_then(Value::as_str))
        .unwrap_or("submitted")
        .to_string();

    let receipt_entry_id = canonical_receipt
        .and_then(|receipt| receipt.get("entry_id"))
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .or_else(|| {
            response_json
                .get("entry_id")
                .and_then(Value::as_str)
                .and_then(|raw| Uuid::parse_str(raw).ok())
        })
        .unwrap_or(entry.entry_id);

    let merkle_proof = response_json
        .get("merkle_proof")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?;

    Ok(SubmissionReceipt {
        entry_id: receipt_entry_id,
        tx_hash,
        block_height,
        merkle_proof,
        status,
        submitted_at: Utc::now().timestamp(),
        api_url: api_url.to_string(),
    })
}

fn verify_receipt(receipt: &SubmissionReceipt, entry: &LedgerEntry) -> anyhow::Result<()> {
    if receipt.entry_id != entry.entry_id {
        return Err(anyhow::anyhow!(
            "receipt entry_id {} does not match entry {}",
            receipt.entry_id,
            entry.entry_id
        ));
    }

    if let Some(proof) = &receipt.merkle_proof {
        let computed_root = compute_merkle_root(entry, proof)?;
        if !computed_root.eq_ignore_ascii_case(&proof.root_hash) {
            return Err(anyhow::anyhow!(
                "merkle proof mismatch: computed {}, expected {}",
                computed_root,
                proof.root_hash
            ));
        }
    }

    Ok(())
}

fn compute_merkle_root(entry: &LedgerEntry, proof: &MerkleProof) -> anyhow::Result<String> {
    let leaf_payload = serde_json::to_string(entry)?;
    let mut current = hash_hex(leaf_payload.as_bytes());
    for sibling in &proof.siblings {
        let current_bytes = hex::decode(&current)?;
        let sibling_bytes = hex::decode(&sibling.hash)?;
        let mut hasher = Sha256::new();
        match sibling.position {
            MerkleSiblingPosition::Left => {
                hasher.update(sibling_bytes);
                hasher.update(current_bytes);
            }
            MerkleSiblingPosition::Right => {
                hasher.update(current_bytes);
                hasher.update(sibling_bytes);
            }
        }
        current = hex::encode(hasher.finalize());
    }
    Ok(current)
}

fn hash_hex(payload: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(payload);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn verifies_receipt_with_merkle_proof() {
        let keypair = WalletKeypair::generate();
        let entry = sign_entry(
            EntryDraft {
                namespace: "audit.procurement".to_string(),
                action: "RECORD_EVENT".to_string(),
                object_id: "AUD-1".to_string(),
                payload: json!({"event": "BID_OPENED"}),
                privacy_flag: false,
                privacy_mode: PrivacyMode::None,
                encryption_passphrase: None,
                authorized_readers: vec![],
                custodian_policy_id: None,
                key_wrapped_secrets: vec![],
                revocation_events: vec![],
                field_reader_acls: Default::default(),
                reader_public_keys: BTreeMap::new(),
                author: "did:ledger:test".to_string(),
                timestamp: 1_736_500_000,
            },
            &keypair,
        )
        .expect("entry signed");

        let sibling_hash = hash_hex(b"sibling");
        let leaf_hash = hash_hex(
            serde_json::to_string(&entry)
                .expect("serialize entry")
                .as_bytes(),
        );
        let mut hasher = Sha256::new();
        hasher.update(hex::decode(&leaf_hash).expect("leaf hash decode"));
        hasher.update(hex::decode(&sibling_hash).expect("sibling hash decode"));
        let root_hash = hex::encode(hasher.finalize());

        let receipt = SubmissionReceipt {
            entry_id: entry.entry_id,
            tx_hash: Some("tx-1".to_string()),
            block_height: Some(1),
            merkle_proof: Some(MerkleProof {
                root_hash,
                siblings: vec![MerkleProofSibling {
                    hash: sibling_hash,
                    position: MerkleSiblingPosition::Right,
                }],
            }),
            status: "finalized".to_string(),
            submitted_at: 1_736_500_000,
            api_url: "http://localhost:8080".to_string(),
        };

        verify_receipt(&receipt, &entry).expect("receipt verified");
    }
    #[test]
    fn policy_enforcement_accepts_sufficient_approvals() {
        enforce_policy_for_action(
            "CAST_VOTE",
            Some(2),
            vec!["validator-a".to_string(), "validator-b".to_string()],
            vec!["validator-b".to_string(), "validator-a".to_string()],
        )
        .expect("policy approved");
    }

    #[test]
    fn policy_enforcement_rejects_insufficient_approvals() {
        let err = enforce_policy_for_action(
            "CAST_VOTE",
            Some(2),
            vec!["validator-a".to_string(), "validator-b".to_string()],
            vec!["validator-a".to_string()],
        )
        .expect_err("policy should fail");
        assert!(err.to_string().contains("requires 2 approvals"));
    }

    #[test]
    fn verify_offchain_file_command_reports_hash_mismatch() {
        let manifest = json!({
            "ciphertext_hash": "sha256:00",
            "encryption_mode": "passphrase",
            "file_ref": "local://registry.land/object.bin"
        });
        let ciphertext = b"ciphertext";
        let err = verify_offchain_file_reconciliation(&manifest, "sha256:00", ciphertext)
            .expect_err("hash mismatch should fail");
        assert!(
            err.to_string()
                .contains("off-chain ciphertext hash mismatch"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn encryption_opt_in_required_when_encrypt_flag_enabled() {
        let err = enforce_encryption_opt_in(true, false).expect_err("missing opt-in should fail");
        assert!(
            err.to_string().contains("--encryption-opt-in"),
            "unexpected error: {err}"
        );
        enforce_encryption_opt_in(true, true).expect("explicit opt-in should pass");
        enforce_encryption_opt_in(false, false).expect("no encrypt should not require opt-in");
    }

    #[test]
    fn parses_supported_mnemonic_word_counts() {
        assert_eq!(parse_mnemonic_word_count("12").expect("12 words"), 12);
        assert_eq!(parse_mnemonic_word_count("24").expect("24 words"), 24);
        assert!(parse_mnemonic_word_count("15").is_err());
    }

    #[test]
    fn validates_mnemonic_phrase_word_count() {
        let twelve = "abandon ".repeat(11) + "about";
        validate_supported_mnemonic_phrase(&twelve).expect("12-word mnemonic");

        let twenty_four = format!("{}{}", "abandon ".repeat(23), "art");
        validate_supported_mnemonic_phrase(&twenty_four).expect("24-word mnemonic");

        let fifteen = format!("{}{}", "abandon ".repeat(14), "about");
        assert!(validate_supported_mnemonic_phrase(&fifteen).is_err());
    }
}
