use chrono::Utc;
use citizen_types::LedgerEntry;
use citizen_wallet::{
    parse_verifying_key, sign_entry, verify_entry_signature, EntryDraft, WalletKeypair,
};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

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
    },
    PublicKey {
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
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
    },
    VerifyEntry {
        #[arg(long)]
        entry_json: String,
        #[arg(long)]
        public_key: String,
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
    secret_key_hex: String,
    created_at: i64,
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
}

fn main() -> anyhow::Result<()> {
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
        Commands::Keygen { path, label } => {
            let mut store = Keystore::load_or_create(&path)?;
            let keypair = WalletKeypair::generate();
            let record = KeyRecord {
                key_id: keypair.key_id,
                label,
                public_key_hex: keypair.verifying_key_hex(),
                secret_key_hex: hex::encode(keypair.secret_key_bytes()),
                created_at: Utc::now().timestamp(),
            };
            store.add_key(record);
            store.save(&path)?;
            println!("Generated key {}", keypair.key_id);
        }
        Commands::PublicKey { path, key_id } => {
            let store = Keystore::load_or_create(&path)?;
            let record = store
                .find_key(key_id)
                .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
            println!("{}", record.public_key_hex);
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
        } => {
            let store = Keystore::load_or_create(&path)?;
            let record = store
                .find_key(key_id)
                .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
            let payload: Value = serde_json::from_str(&payload_json)?;
            let secret_bytes = hex::decode(&record.secret_key_hex)?;
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
    }

    Ok(())
}
