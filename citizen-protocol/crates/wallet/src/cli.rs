use chrono::Utc;
use citizen_types::LedgerEntry;
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::{
    decrypt_secret_key, encrypt_secret_key, parse_verifying_key, sign_entry,
    verify_entry_signature, EncryptedSecretKey, EntryDraft, WalletKeypair,
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
    },
    VerifyEntry {
        #[arg(long)]
        entry_json: String,
        #[arg(long)]
        public_key: String,
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
    },
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
        } => {
            let mut store = Keystore::load_or_create(&path)?;
            let keypair = WalletKeypair::generate();
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
        } => {
            let store = Keystore::load_or_create(&path)?;
            let record = store
                .find_key(key_id)
                .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
            let payload: Value = serde_json::from_str(&payload_json)?;
            let secret_bytes = load_secret_key_bytes(record, password)?;
            let keypair = WalletKeypair::from_secret_bytes(record.key_id, &secret_bytes)?;
            let draft = EntryDraft {
                namespace,
                action,
                object_id,
                payload,
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
        Commands::SignIdentityRegister {
            path,
            key_id,
            subject,
            claims_hash,
            author,
            timestamp,
            password,
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
        } => {
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
) -> anyhow::Result<()> {
    let store = Keystore::load_or_create(path)?;
    let record = store
        .find_key(key_id)
        .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
    let secret_bytes = load_secret_key_bytes(record, password)?;
    let keypair = WalletKeypair::from_secret_bytes(record.key_id, &secret_bytes)?;
    let draft = EntryDraft {
        namespace: namespace.to_string(),
        action: action.to_string(),
        object_id,
        payload,
        author,
        timestamp: timestamp.unwrap_or_else(|| Utc::now().timestamp()),
    };
    let entry = sign_entry(draft, &keypair)?;
    let entry_json = serde_json::to_string_pretty(&entry)?;
    println!("{entry_json}");
    Ok(())
}

fn load_password(explicit: Option<String>) -> anyhow::Result<String> {
    if let Some(password) = explicit {
        return Ok(password);
    }
    std::env::var("CITIZEN_WALLET_PASSWORD").map_err(|_| {
        anyhow::anyhow!("password required (pass --password or set CITIZEN_WALLET_PASSWORD)")
    })
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
