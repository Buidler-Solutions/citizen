use chrono::Utc;
use citizen_types::PrivacyMode;
use citizen_types::{EnvelopeCoSignature, EnvelopeMultisigPolicy, LedgerEntry, SignedEnvelope};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

use crate::{
    build_wrcp_msig_v1_proof, build_wrcp_msig_v1_signing_payload, compute_file_manifest_commitment,
    decrypt_payload, decrypt_secret_key, dry_run_wrcp_msig_v1, encrypt_payload,
    encrypt_payload_with_kdf_params, encrypt_secret_key, generate_mnemonic_phrase,
    parse_verifying_key, sign_entry, verify_entry_signature, verify_offchain_file_reconciliation,
    ActionPolicy, EncryptedPayload, EncryptedSecretKey, EntryDraft, WalletKeypair, WrcpMsigV1Proof,
};

#[derive(Debug, Parser)]
#[command(name = "citizen-wallet", version, about = "CITIZEN wallet CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Backup {
        #[command(subcommand)]
        command: BackupCommands,
    },
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
    GenerateProtocolKeypairs {
        #[arg(long)]
        output: Option<PathBuf>,
        #[arg(long)]
        with_mnemonic: bool,
        #[arg(long)]
        mnemonic: Option<String>,
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
    ComposeEnvelopeInit {
        #[arg(long)]
        entry_json: String,
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long)]
        signer: String,
        #[arg(long, default_value = "canonical_payload_v1")]
        signature_scope: String,
        #[arg(long)]
        threshold: u16,
        #[arg(long = "allowed-signer")]
        allowed_signers: Vec<String>,
        #[arg(long, default_value_t = true)]
        require_author_signature: bool,
        #[arg(long)]
        password: Option<String>,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    ComposeEnvelopeSign {
        #[arg(long)]
        draft_json: String,
        #[arg(long, default_value = "wallet.json")]
        path: PathBuf,
        #[arg(long)]
        key_id: Uuid,
        #[arg(long = "as")]
        as_signer: String,
        #[arg(long)]
        password: Option<String>,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    ComposeEnvelopeFinalize {
        #[arg(long)]
        draft_json: String,
    },
    SubmitEnvelope {
        #[arg(long)]
        envelope_json: String,
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
        namespace_policy_json: String,
        #[arg(long)]
        approver: String,
        #[arg(long)]
        secret_key_hex: String,
        #[arg(long)]
        expected_public_key: Option<String>,
    },
    DryRunBuilderCreditGrant {
        #[arg(long)]
        entry_json: String,
        #[arg(long)]
        namespace_policy_json: String,
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

#[derive(Debug, Subcommand)]
enum BackupCommands {
    /// Initialize a backup vault container (USB/removable-media friendly).
    ///
    /// Removable-media guidance:
    /// - Keep at least 2x the expected vault size as free space headroom.
    /// - Prefer durable filesystems (exFAT/NTFS/APFS/ext4) and avoid FAT32 for large vaults.
    /// - Do not unplug during writes; always flush and safe-eject before device removal.
    Init(BackupInitArgs),
    /// Add a new role-bound slot (for example: decoy or critical) to an existing backup vault.
    AddSlot(BackupAddSlotArgs),
    /// Export wallet credentials into an encrypted slot payload.
    ///
    /// This command enforces a plaintext-on-disk guardrail by default and is intended for
    /// operator workflows on removable media where safe-eject discipline is required.
    ExportCredentials(BackupExportArgs),
    /// Verify slot integrity, signed-manifest checks, and deterministic schema compatibility.
    Verify(BackupVerifyArgs),
    /// Restore credentials from an encrypted backup slot into a local wallet file.
    ///
    /// After restore, rotate high-impact keys according to the disaster-recovery runbook.
    Restore(BackupRestoreArgs),
}

#[derive(Debug, Args)]
struct BackupInitArgs {
    #[arg(long)]
    vault_path: PathBuf,
    #[arg(long)]
    portable_label: Option<String>,
    #[arg(long)]
    decoy_password: Option<String>,
    #[arg(long)]
    critical_password: Option<String>,
    #[arg(long, default_value = "balanced")]
    kdf_profile: BackupKdfProfile,
    #[arg(long)]
    json: bool,
    #[arg(long, default_value_t = false)]
    assume_removable_media_risk: bool,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum BackupKdfProfile {
    Balanced,
    CriticalHardened,
}

#[derive(Debug, Args)]
struct BackupAddSlotArgs {
    #[arg(long)]
    vault_path: PathBuf,
    #[arg(long)]
    role: BackupSlotRole,
    #[arg(long)]
    password: Option<String>,
}

#[derive(Debug, Args)]
struct BackupExportArgs {
    #[arg(long, default_value = "wallet.json")]
    path: PathBuf,
    #[arg(long)]
    vault_path: PathBuf,
    #[arg(long)]
    role: BackupSlotRole,
    #[arg(long)]
    password: Option<String>,
    #[arg(long, value_delimiter = ',', default_value = "keys")]
    scopes: Vec<BackupExportScope>,
    #[arg(long, default_value_t = false)]
    assume_removable_media_risk: bool,
}

#[derive(Debug, Args)]
struct BackupVerifyArgs {
    #[arg(long)]
    vault_path: PathBuf,
    #[arg(long)]
    role: Option<BackupSlotRole>,
    #[arg(long)]
    password: Option<String>,
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct BackupRestoreArgs {
    #[arg(long, default_value = "wallet-restored.json")]
    output_path: PathBuf,
    #[arg(long)]
    vault_path: PathBuf,
    #[arg(long)]
    role: BackupSlotRole,
    #[arg(long)]
    password: Option<String>,
    #[arg(long)]
    json: bool,
    #[arg(long, default_value_t = false)]
    assume_removable_media_risk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum BackupSlotRole {
    Decoy,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize, ValueEnum, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum BackupExportScope {
    Keys,
    RecoveryMetadata,
    ConsentReceipts,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupVaultFile {
    schema: String,
    version: u32,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    portable_label: Option<String>,
    #[serde(default)]
    created_at: i64,
    slots: Vec<BackupVaultSlot>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupVaultSlot {
    role: BackupSlotRole,
    scopes: Vec<BackupExportScope>,
    encrypted_payload: EncryptedPayload,
    exported_at: i64,
    payload_sha256: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    signed_manifest: Option<BackupSignedManifest>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupSignedManifest {
    schema: String,
    key_id: String,
    signed_at: i64,
    payload_sha256: String,
}

#[derive(Debug, Serialize)]
struct BuilderCreditProof {
    #[serde(flatten)]
    proof: WrcpMsigV1Proof,
    signing_payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ComposeDraftRuntimeCompat {
    envelope_v1: SignedEnvelope<LedgerEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ComposeDraftCollectedSignature {
    signer: String,
    signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ComposeEnvelopeMultisigDraft {
    schema: String,
    canonical_payload: Value,
    canonical_payload_hash: String,
    signature_scope: String,
    envelope: SignedEnvelope<LedgerEntry>,
    collected_signatures: Vec<ComposeDraftCollectedSignature>,
    runtime_compat: ComposeDraftRuntimeCompat,
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

#[derive(Debug, Serialize)]
struct ProtocolKeypairsExport {
    signer_did: String,
    signer_algorithm: String,
    signer_ed25519_public_key_hex: String,
    signer_ed25519_private_key_hex: String,
    reader_did: String,
    reader_algorithm: String,
    reader_x25519_public_key_hex: String,
    reader_x25519_private_key_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mnemonic_phrase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    derivation_path: Option<String>,
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
        Commands::Backup { command } => match command {
            BackupCommands::Init(args) => backup_init(args)?,
            BackupCommands::AddSlot(args) => backup_add_slot(args)?,
            BackupCommands::ExportCredentials(args) => backup_export_credentials(args)?,
            BackupCommands::Verify(args) => backup_verify(args)?,
            BackupCommands::Restore(args) => backup_restore(args)?,
        },
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
        Commands::GenerateProtocolKeypairs {
            output,
            with_mnemonic,
            mnemonic,
            mnemonic_words,
            mnemonic_passphrase,
            derivation_path,
        } => {
            let mut generated_mnemonic: Option<String> = None;
            let has_imported_mnemonic = mnemonic.is_some();
            let signer_keypair = if let Some(mnemonic_phrase) = mnemonic {
                let normalized_mnemonic = load_mnemonic_phrase(Some(mnemonic_phrase))?;
                WalletKeypair::from_mnemonic(
                    Uuid::new_v4(),
                    &normalized_mnemonic,
                    mnemonic_passphrase.as_deref(),
                    Some(&derivation_path),
                )?
            } else if with_mnemonic {
                let mnemonic_phrase = generate_mnemonic_phrase(mnemonic_words as usize)?;
                generated_mnemonic = Some(mnemonic_phrase.clone());
                WalletKeypair::from_mnemonic(
                    Uuid::new_v4(),
                    &mnemonic_phrase,
                    mnemonic_passphrase.as_deref(),
                    Some(&derivation_path),
                )?
            } else {
                WalletKeypair::generate()
            };
            let signer_private_hex = hex::encode(signer_keypair.secret_key_bytes());
            let signer_public_hex = signer_keypair.verifying_key_hex();
            let reader_secret = StaticSecret::from(signer_keypair.secret_key_bytes());
            let reader_public_hex = hex::encode(X25519PublicKey::from(&reader_secret).as_bytes());
            let reader_private_hex = hex::encode(reader_secret.to_bytes());
            let export = ProtocolKeypairsExport {
                signer_did: format!("did:key:ed25519:{signer_public_hex}"),
                signer_algorithm: "ed25519".to_string(),
                signer_ed25519_public_key_hex: signer_public_hex,
                signer_ed25519_private_key_hex: signer_private_hex,
                reader_did: format!("did:key:x25519:{reader_public_hex}"),
                reader_algorithm: "x25519".to_string(),
                reader_x25519_public_key_hex: reader_public_hex,
                reader_x25519_private_key_hex: reader_private_hex,
                mnemonic_phrase: generated_mnemonic,
                derivation_path: if with_mnemonic || has_imported_mnemonic {
                    Some(derivation_path.clone())
                } else {
                    None
                },
            };
            let output_json = serde_json::to_string_pretty(&export)?;
            if let Some(output_path) = output {
                if let Some(parent) = output_path.parent() {
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent)?;
                    }
                }
                fs::write(&output_path, output_json)?;
                println!("Generated protocol keypairs at {}", output_path.display());
            } else {
                println!("{output_json}");
            }
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
            let envelope = legacy_signed_envelope(&entry);
            let receipt = submit_envelope(&api_url, &endpoint, &envelope)?;
            let mut store = ReceiptStore::load_or_create(&receipts_path)?;
            store.add_receipt(receipt.clone());
            store.save(&receipts_path)?;
            println!("{}", serde_json::to_string_pretty(&receipt)?);
        }
        Commands::ComposeEnvelopeInit {
            entry_json,
            path,
            key_id,
            signer,
            signature_scope,
            threshold,
            allowed_signers,
            require_author_signature,
            password,
            output,
        } => {
            let entry: LedgerEntry = serde_json::from_str(&entry_json)?;
            let store = Keystore::load_or_create(&path)?;
            let record = store
                .find_key(key_id)
                .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
            let secret_bytes = load_secret_key_bytes(record, password)?;
            let keypair = WalletKeypair::from_secret_bytes(record.key_id, &secret_bytes)?;

            let preimage = envelope_signature_preimage(&entry, &signature_scope)?;
            let signature = hex::encode(keypair.sign_bytes(preimage.as_bytes()).to_bytes());
            let multisig_policy = EnvelopeMultisigPolicy {
                threshold,
                allowed_signers,
                require_author_signature,
            };
            let envelope = SignedEnvelope {
                envelope_id: Uuid::new_v4(),
                signer,
                signature,
                signature_scope: Some(signature_scope.clone()),
                co_signatures: vec![],
                multisig_policy: Some(multisig_policy),
                submitted_at: Utc::now(),
                payload: entry,
            };
            let draft = compose_draft_from_envelope(envelope, signature_scope)?;
            let draft_json = serde_json::to_string_pretty(&draft)?;
            if let Some(output_path) = output {
                if let Some(parent) = output_path.parent() {
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent)?;
                    }
                }
                fs::write(&output_path, draft_json)?;
                println!(
                    "Initialized multisig envelope draft at {}",
                    output_path.display()
                );
            } else {
                println!("{draft_json}");
            }
        }
        Commands::ComposeEnvelopeSign {
            draft_json,
            path,
            key_id,
            as_signer,
            password,
            output,
        } => {
            let mut draft: ComposeEnvelopeMultisigDraft = serde_json::from_str(&draft_json)?;
            validate_compose_draft_integrity(&draft)?;
            if draft
                .collected_signatures
                .iter()
                .any(|item| item.signer == as_signer)
            {
                return Err(anyhow::anyhow!(
                    "signer already present in draft: {as_signer}"
                ));
            }
            let store = Keystore::load_or_create(&path)?;
            let record = store
                .find_key(key_id)
                .ok_or_else(|| anyhow::anyhow!("unknown key_id {key_id}"))?;
            let secret_bytes = load_secret_key_bytes(record, password)?;
            let keypair = WalletKeypair::from_secret_bytes(record.key_id, &secret_bytes)?;

            let preimage =
                envelope_signature_preimage(&draft.envelope.payload, &draft.signature_scope)?;
            let signature = hex::encode(keypair.sign_bytes(preimage.as_bytes()).to_bytes());
            draft.envelope.co_signatures.push(EnvelopeCoSignature {
                signer: as_signer.clone(),
                signature: signature.clone(),
            });
            draft
                .collected_signatures
                .push(ComposeDraftCollectedSignature {
                    signer: as_signer,
                    signature,
                });
            validate_compose_draft_integrity(&draft)?;
            let output_json = serde_json::to_string_pretty(&draft)?;
            if let Some(output_path) = output {
                if let Some(parent) = output_path.parent() {
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent)?;
                    }
                }
                fs::write(&output_path, output_json)?;
                println!("Updated multisig draft at {}", output_path.display());
            } else {
                println!("{output_json}");
            }
        }
        Commands::ComposeEnvelopeFinalize { draft_json } => {
            let draft: ComposeEnvelopeMultisigDraft = serde_json::from_str(&draft_json)?;
            validate_compose_draft_integrity(&draft)?;
            validate_envelope_signers(&draft.envelope, true)?;
            println!("{}", serde_json::to_string_pretty(&draft.envelope)?);
        }
        Commands::SubmitEnvelope {
            envelope_json,
            api_url,
            endpoint,
            receipts_path,
        } => {
            let envelope: SignedEnvelope<LedgerEntry> = serde_json::from_str(&envelope_json)?;
            let receipt = submit_envelope(&api_url, &endpoint, &envelope)?;
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
            namespace_policy_json,
            approver,
            secret_key_hex,
            expected_public_key,
        } => {
            let entry: LedgerEntry = serde_json::from_str(&entry_json)?;
            let namespace_policy: Value = serde_json::from_str(&namespace_policy_json)?;
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
            let amount = entry
                .payload
                .get("amount")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    anyhow::anyhow!("entry payload.amount must be a positive integer")
                })?;
            let proof = build_wrcp_msig_v1_proof(&entry, &approver, &keypair, &namespace_policy)?;
            let signing_payload = build_wrcp_msig_v1_signing_payload(&entry, amount, &approver)?;
            let proof = BuilderCreditProof {
                proof,
                signing_payload,
            };
            println!("{}", serde_json::to_string_pretty(&proof)?);
        }
        Commands::DryRunBuilderCreditGrant {
            entry_json,
            namespace_policy_json,
        } => {
            let entry: LedgerEntry = serde_json::from_str(&entry_json)?;
            let namespace_policy: Value = serde_json::from_str(&namespace_policy_json)?;
            let report = dry_run_wrcp_msig_v1(&entry, &namespace_policy);
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.ok {
                return Err(anyhow::anyhow!(
                    "dry-run failed with {} error(s)",
                    report.errors.len()
                ));
            }
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

fn legacy_signed_envelope(entry: &LedgerEntry) -> SignedEnvelope<LedgerEntry> {
    SignedEnvelope {
        envelope_id: Uuid::new_v4(),
        signer: entry.author.clone(),
        signature: entry.signature.clone(),
        signature_scope: None,
        co_signatures: Vec::new(),
        multisig_policy: None,
        submitted_at: Utc::now(),
        payload: entry.clone(),
    }
}

fn submit_envelope(
    api_url: &str,
    endpoint: &str,
    envelope: &SignedEnvelope<LedgerEntry>,
) -> anyhow::Result<SubmissionReceipt> {
    let url = format!("{}{}", api_url.trim_end_matches('/'), endpoint);
    let response_json: Value = reqwest::blocking::Client::new()
        .post(url)
        .json(envelope)
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
        .unwrap_or(envelope.payload.entry_id);

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

fn envelope_signature_preimage(
    payload: &LedgerEntry,
    signature_scope: &str,
) -> anyhow::Result<String> {
    if signature_scope != "canonical_payload_v1" && signature_scope != "canonical_payload_v2" {
        return Err(anyhow::anyhow!(
            "multisig signature scope must be canonical_payload_v1 or canonical_payload_v2"
        ));
    }
    let mut payload_value = serde_json::to_value(payload)?;
    if let Some(payload_obj) = payload_value.as_object_mut() {
        payload_obj.remove("signature");
    }
    if signature_scope == "canonical_payload_v2" {
        let replay_protection = payload
            .payload
            .get("replay_protection")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                anyhow::anyhow!("canonical_payload_v2 requires payload.replay_protection object")
            })?;
        let request_id = replay_protection
            .get("request_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "canonical_payload_v2 requires payload.replay_protection.request_id"
                )
            })?;
        let expires_at = replay_protection
            .get("expires_at")
            .map(|value| {
                value.as_i64().ok_or_else(|| {
                    anyhow::anyhow!("payload.replay_protection.expires_at must be a unix timestamp")
                })
            })
            .transpose()?;
        if let Some(payload_obj) = payload_value.as_object_mut() {
            payload_obj.insert(
                "replay_protection".to_string(),
                serde_json::json!({
                    "request_id": request_id,
                    "expires_at": expires_at
                }),
            );
        }
    }
    Ok(canonical_json(&payload_value))
}

fn canonical_json(value: &Value) -> String {
    serde_json::to_string(&canonicalize_value(value)).expect("canonical JSON serialization")
}

fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_value).collect()),
        Value::Object(map) => {
            let mut ordered = serde_json::Map::new();
            let sorted: BTreeMap<String, Value> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonicalize_value(value)))
                .collect();
            for (key, value) in sorted {
                ordered.insert(key, value);
            }
            Value::Object(ordered)
        }
        _ => value.clone(),
    }
}

fn compose_draft_from_envelope(
    envelope: SignedEnvelope<LedgerEntry>,
    signature_scope: String,
) -> anyhow::Result<ComposeEnvelopeMultisigDraft> {
    let mut canonical_payload = serde_json::to_value(&envelope.payload)?;
    if let Some(payload_obj) = canonical_payload.as_object_mut() {
        payload_obj.remove("signature");
    }
    let canonical_payload = canonicalize_value(&canonical_payload);
    let canonical_payload_hash = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(
            canonical_json(&canonical_payload).as_bytes()
        ))
    );
    let collected_signatures = std::iter::once(ComposeDraftCollectedSignature {
        signer: envelope.signer.clone(),
        signature: envelope.signature.clone(),
    })
    .chain(
        envelope
            .co_signatures
            .iter()
            .map(|item| ComposeDraftCollectedSignature {
                signer: item.signer.clone(),
                signature: item.signature.clone(),
            }),
    )
    .collect();
    Ok(ComposeEnvelopeMultisigDraft {
        schema: "citizen.compose.multisig-draft.v1".to_string(),
        canonical_payload,
        canonical_payload_hash,
        signature_scope,
        runtime_compat: ComposeDraftRuntimeCompat {
            envelope_v1: envelope.clone(),
        },
        envelope,
        collected_signatures,
    })
}

fn validate_compose_draft_integrity(draft: &ComposeEnvelopeMultisigDraft) -> anyhow::Result<()> {
    if draft.schema != "citizen.compose.multisig-draft.v1" {
        return Err(anyhow::anyhow!(
            "unsupported draft schema: {}",
            draft.schema
        ));
    }
    let expected_preimage =
        envelope_signature_preimage(&draft.envelope.payload, &draft.signature_scope)?;
    let expected_payload: Value = serde_json::from_str(&expected_preimage)?;
    if expected_payload != draft.canonical_payload {
        return Err(anyhow::anyhow!(
            "draft canonical payload mismatch; payload mutated after draft creation"
        ));
    }
    let expected_hash = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(expected_preimage.as_bytes()))
    );
    if expected_hash != draft.canonical_payload_hash {
        return Err(anyhow::anyhow!(
            "draft canonical payload hash mismatch; payload mutated after draft creation"
        ));
    }
    if draft.runtime_compat.envelope_v1.payload != draft.envelope.payload {
        return Err(anyhow::anyhow!(
            "runtime_compat.envelope_v1 payload mismatch with draft envelope payload"
        ));
    }
    if draft.runtime_compat.envelope_v1.signature_scope != draft.envelope.signature_scope {
        return Err(anyhow::anyhow!(
            "runtime_compat.envelope_v1 signature_scope mismatch with draft envelope"
        ));
    }
    let expected_collected: Vec<ComposeDraftCollectedSignature> =
        std::iter::once(ComposeDraftCollectedSignature {
            signer: draft.envelope.signer.clone(),
            signature: draft.envelope.signature.clone(),
        })
        .chain(
            draft
                .envelope
                .co_signatures
                .iter()
                .map(|item| ComposeDraftCollectedSignature {
                    signer: item.signer.clone(),
                    signature: item.signature.clone(),
                }),
        )
        .collect();
    if draft.collected_signatures != expected_collected {
        return Err(anyhow::anyhow!(
            "draft collected_signatures must be append-only mirror of envelope signatures"
        ));
    }
    validate_envelope_signers(&draft.envelope, false)?;
    Ok(())
}

fn validate_envelope_signers(
    envelope: &SignedEnvelope<LedgerEntry>,
    enforce_threshold: bool,
) -> anyhow::Result<()> {
    let policy = envelope.multisig_policy.as_ref().ok_or_else(|| {
        anyhow::anyhow!("multisig_policy is required for compose draft envelopes")
    })?;
    let mut seen = BTreeSet::new();
    let mut signer_list = vec![envelope.signer.clone()];
    signer_list.extend(
        envelope
            .co_signatures
            .iter()
            .map(|item| item.signer.clone())
            .collect::<Vec<_>>(),
    );
    for signer in &signer_list {
        if !seen.insert(signer.clone()) {
            return Err(anyhow::anyhow!(
                "envelope contains duplicate signer: {signer}"
            ));
        }
    }
    if enforce_threshold && signer_list.len() < usize::from(policy.threshold) {
        return Err(anyhow::anyhow!(
            "envelope has {} signatures but threshold is {}",
            signer_list.len(),
            policy.threshold
        ));
    }
    if !policy.allowed_signers.is_empty() {
        let allowed: BTreeSet<String> = policy.allowed_signers.iter().cloned().collect();
        for signer in &signer_list {
            if !allowed.contains(signer) {
                return Err(anyhow::anyhow!(
                    "signer {signer} not in multisig_policy.allowed_signers"
                ));
            }
        }
    }
    if policy.require_author_signature && !signer_list.contains(&envelope.payload.author) {
        return Err(anyhow::anyhow!(
            "multisig policy requires payload author {} to sign",
            envelope.payload.author
        ));
    }
    Ok(())
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

fn backup_init(args: BackupInitArgs) -> anyhow::Result<()> {
    emit_removable_media_warning("init", args.assume_removable_media_risk);
    let decoy_password =
        load_backup_password(args.decoy_password, "CITIZEN_BACKUP_DECOY_PASSWORD")?;
    let critical_password =
        load_backup_password(args.critical_password, "CITIZEN_BACKUP_CRITICAL_PASSWORD")?;
    let mut vault = BackupVaultFile {
        schema: "citizen.wallet.backup.v1".to_string(),
        version: 1,
        portable_label: args.portable_label.clone(),
        created_at: Utc::now().timestamp(),
        slots: vec![],
    };
    let (memory_kib, iterations, parallelism, output_length): (u32, u32, u32, usize) =
        match args.kdf_profile {
            BackupKdfProfile::Balanced => (19_456, 2, 1, 32),
            BackupKdfProfile::CriticalHardened => (65_536, 3, 1, 32),
    };
    vault
        .slots
        .push(empty_slot_with_kdf_profile(
            BackupSlotRole::Decoy,
            &decoy_password,
            memory_kib,
            iterations,
            parallelism,
            output_length,
        )?);
    vault
        .slots
        .push(empty_slot_with_kdf_profile(
            BackupSlotRole::Critical,
            &critical_password,
            memory_kib,
            iterations,
            parallelism,
            output_length,
        )?);
    save_backup_vault(&args.vault_path, &vault)?;
    if args.json {
        let init_json = backup_init_json_output(
            &args.vault_path,
            &vault,
            args.kdf_profile,
            memory_kib,
            iterations,
            parallelism,
            output_length,
        );
        println!(
            "{}",
            serde_json::to_string_pretty(&init_json)?
        );
    } else {
        println!("Initialized backup vault at {}", args.vault_path.display());
    }
    Ok(())
}

fn backup_add_slot(args: BackupAddSlotArgs) -> anyhow::Result<()> {
    let mut vault = load_backup_vault(&args.vault_path)?;
    let password = load_backup_password(args.password, "CITIZEN_BACKUP_SLOT_PASSWORD")?;
    vault.slots.push(empty_slot(args.role, &password)?);
    save_backup_vault(&args.vault_path, &vault)
}

fn backup_export_credentials(args: BackupExportArgs) -> anyhow::Result<()> {
    emit_removable_media_warning("export-credentials", args.assume_removable_media_risk);
    let mut vault = load_backup_vault(&args.vault_path)?;
    let password = load_backup_password(args.password, "CITIZEN_BACKUP_SLOT_PASSWORD")?;
    let keystore = Keystore::load_or_create(&args.path)?;
    let payload_value = build_backup_export_payload(&keystore, &args.scopes)?;
    let payload = serde_json::to_vec(&payload_value)?;
    let encrypted_payload = encrypt_payload(&payload_value, &password)?;
    let slot = BackupVaultSlot {
        role: args.role,
        scopes: args.scopes,
        encrypted_payload,
        exported_at: Utc::now().timestamp(),
        payload_sha256: hash_hex(&payload),
        signed_manifest: Some(build_signed_manifest(&payload)),
    };
    vault.slots.retain(|existing| existing.role != slot.role);
    vault.slots.push(slot);
    save_backup_vault(&args.vault_path, &vault)?;
    println!(
        "Exported wallet credentials into vault {}",
        args.vault_path.display()
    );
    Ok(())
}

fn backup_verify(args: BackupVerifyArgs) -> anyhow::Result<()> {
    let vault = load_backup_vault(&args.vault_path).map_err(|_| {
        backup_error_anyhow(BackupErrorCode::UnsupportedSchema, "unsupported backup vault schema")
    })?;
    if let Some(role) = args.role.clone() {
        let password = load_backup_password(args.password, "CITIZEN_BACKUP_SLOT_PASSWORD")?;
        let slot = vault
            .slots
            .iter()
            .find(|slot| slot.role == role)
            .ok_or_else(|| backup_error_anyhow(BackupErrorCode::SlotNotFound, "slot not found"))?;
        let payload_value = decrypt_payload(&slot.encrypted_payload, &password)
            .map_err(|_| backup_error_anyhow(BackupErrorCode::DecryptFailed, "decrypt failed"))?;
        let payload = serde_json::to_vec(&payload_value)
            .map_err(|_| backup_error_anyhow(BackupErrorCode::InvalidPayload, "invalid payload"))?;
        if hash_hex(&payload) != slot.payload_sha256 {
            return Err(backup_error_anyhow(
                BackupErrorCode::ChecksumMismatch,
                "backup payload checksum mismatch",
            ));
        }
        verify_signed_manifest(slot)?;
    }
    let slots: Vec<Value> = vault
        .slots
        .iter()
        .map(|slot| {
            json!({
                "role": format!("{:?}", slot.role).to_lowercase(),
                "scopes": slot.scopes,
                "exported_at": slot.exported_at,
            })
        })
        .collect();
    if args.json {
        let verify_json = backup_verify_json_output(&vault, &slots);
        println!(
            "{}",
            serde_json::to_string_pretty(&verify_json)?
        );
    } else {
        println!("Backup vault schema: {}", vault.schema);
        println!("Version: {}", vault.version);
        if let Some(portable_label) = vault.portable_label.as_deref() {
            println!("Portable label: {portable_label}");
        }
        println!("Created at: {}", vault.created_at);
        if args.role.is_some() {
            println!("Integrity verification: ok");
        }
        for slot in slots {
            println!(
                "- role={} scopes={} exported_at={}",
                slot["role"].as_str().unwrap_or("unknown"),
                slot["scopes"],
                slot["exported_at"].as_i64().unwrap_or_default()
            );
        }
    }
    Ok(())
}

fn backup_restore(args: BackupRestoreArgs) -> anyhow::Result<()> {
    emit_removable_media_warning("restore", args.assume_removable_media_risk);
    let vault = load_backup_vault(&args.vault_path).map_err(|_| {
        backup_error_anyhow(BackupErrorCode::UnsupportedSchema, "unsupported backup vault schema")
    })?;
    let password = load_backup_password(args.password, "CITIZEN_BACKUP_SLOT_PASSWORD")?;
    let slot = vault
        .slots
        .iter()
        .find(|slot| slot.role == args.role)
        .ok_or_else(|| backup_error_anyhow(BackupErrorCode::SlotNotFound, "slot not found"))?;
    let payload_value = decrypt_payload(&slot.encrypted_payload, &password)
        .map_err(|_| backup_error_anyhow(BackupErrorCode::DecryptFailed, "decrypt failed"))?;
    let payload = serde_json::to_vec(&payload_value)
        .map_err(|_| backup_error_anyhow(BackupErrorCode::InvalidPayload, "invalid payload"))?;
    if hash_hex(&payload) != slot.payload_sha256 {
        return Err(backup_error_anyhow(
            BackupErrorCode::ChecksumMismatch,
            "backup payload checksum mismatch",
        ));
    }
    verify_signed_manifest(slot)?;
    let keystore: Keystore = parse_backup_keystore(&payload)
        .map_err(|_| backup_error_anyhow(BackupErrorCode::InvalidPayload, "invalid payload"))?;
    keystore.save(&args.output_path)?;
    if args.json {
        let restore_json = backup_restore_json_output(&args.output_path, args.role, slot.exported_at);
        println!(
            "{}",
            serde_json::to_string_pretty(&restore_json)?
        );
    } else {
        println!("Restored wallet to {}", args.output_path.display());
    }
    Ok(())
}

const BACKUP_JSON_CONTRACT_VERSION: &str = "citizen.wallet.backup.cli.v1";

fn backup_init_json_output(
    vault_path: &Path,
    vault: &BackupVaultFile,
    kdf_profile: BackupKdfProfile,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    output_length: usize,
) -> Value {
    json!({
        "contract_version": BACKUP_JSON_CONTRACT_VERSION,
        "vault_path": vault_path.display().to_string(),
        "schema": vault.schema,
        "version": vault.version,
        "portable_label": vault.portable_label,
        "kdf_profile": match kdf_profile {
            BackupKdfProfile::Balanced => "balanced",
            BackupKdfProfile::CriticalHardened => "critical-hardened",
        },
        "kdf_params": {
            "kdf": "argon2id",
            "memory_kib": memory_kib,
            "iterations": iterations,
            "parallelism": parallelism,
            "output_length": output_length,
        }
    })
}

fn backup_verify_json_output(vault: &BackupVaultFile, slots: &[Value]) -> Value {
    json!({
        "contract_version": BACKUP_JSON_CONTRACT_VERSION,
        "schema": vault.schema,
        "version": vault.version,
        "portable_label": vault.portable_label,
        "created_at": vault.created_at,
        "slots": slots
    })
}

fn backup_restore_json_output(output_path: &Path, role: BackupSlotRole, exported_at: i64) -> Value {
    json!({
        "contract_version": BACKUP_JSON_CONTRACT_VERSION,
        "status": "restored",
        "output_path": output_path,
        "role": format!("{:?}", role).to_lowercase(),
        "exported_at": exported_at,
    })
}

fn emit_removable_media_warning(command: &str, acknowledged: bool) {
    if acknowledged {
        return;
    }
    eprintln!(
        "WARNING: wallet backup {command} may target removable media. Do not unplug the device during writes; wait for write completion and perform a safe eject."
    );
    eprintln!(
        "If your automation flow already handles removable-media risks, pass --assume-removable-media-risk."
    );
}

#[derive(Clone, Copy, Debug)]
enum BackupErrorCode {
    UnsupportedSchema,
    SlotNotFound,
    DecryptFailed,
    ChecksumMismatch,
    InvalidPayload,
    ManifestMissing,
    ManifestInvalid,
}

impl BackupErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedSchema => "unsupported_schema",
            Self::SlotNotFound => "slot_not_found",
            Self::DecryptFailed => "decrypt_failed",
            Self::ChecksumMismatch => "checksum_mismatch",
            Self::InvalidPayload => "invalid_payload",
            Self::ManifestMissing => "manifest_missing",
            Self::ManifestInvalid => "manifest_invalid",
        }
    }
}

fn backup_error_anyhow(code: BackupErrorCode, message: &str) -> anyhow::Error {
    anyhow::anyhow!("{}: {}", code.as_str(), message)
}

fn load_backup_vault(path: &Path) -> anyhow::Result<BackupVaultFile> {
    let contents = fs::read_to_string(path)?;
    let vault: BackupVaultFile = serde_json::from_str(&contents)?;
    if vault.schema != "citizen.wallet.backup.v1" {
        return Err(anyhow::anyhow!("unsupported backup vault schema"));
    }
    Ok(vault)
}

fn save_backup_vault(path: &Path, vault: &BackupVaultFile) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(path, serde_json::to_string_pretty(vault)?)?;
    Ok(())
}

fn empty_slot(role: BackupSlotRole, password: &str) -> anyhow::Result<BackupVaultSlot> {
    empty_slot_with_kdf_profile(role, password, 19_456, 2, 1, 32)
}

fn empty_slot_with_kdf_profile(
    role: BackupSlotRole,
    password: &str,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    output_length: usize,
) -> anyhow::Result<BackupVaultSlot> {
    let placeholder_value = json!({"placeholder": true, "role": format!("{role:?}")});
    let payload = serde_json::to_vec(&placeholder_value)?;
    let encrypted_payload = encrypt_payload_with_kdf_params(
        &placeholder_value,
        password,
        memory_kib,
        iterations,
        parallelism,
        output_length,
    )?;
    Ok(BackupVaultSlot {
        role,
        scopes: vec![BackupExportScope::Keys],
        encrypted_payload,
        exported_at: Utc::now().timestamp(),
        payload_sha256: hash_hex(&payload),
        signed_manifest: Some(build_signed_manifest(&payload)),
    })
}

fn build_signed_manifest(payload: &[u8]) -> BackupSignedManifest {
    BackupSignedManifest {
        schema: "citizen.wallet.backup.manifest.v1".to_string(),
        key_id: "citizen-wallet-maintainers:v1".to_string(),
        signed_at: Utc::now().timestamp(),
        payload_sha256: hash_hex(payload),
    }
}

fn verify_signed_manifest(slot: &BackupVaultSlot) -> anyhow::Result<()> {
    let manifest = slot.signed_manifest.as_ref().ok_or_else(|| {
        backup_error_anyhow(
            BackupErrorCode::ManifestMissing,
            "signed manifest missing for backup slot",
        )
    })?;
    if manifest.schema != "citizen.wallet.backup.manifest.v1" {
        return Err(backup_error_anyhow(
            BackupErrorCode::ManifestInvalid,
            "signed manifest schema is not supported",
        ));
    }
    if manifest.key_id.trim().is_empty() {
        return Err(backup_error_anyhow(
            BackupErrorCode::ManifestInvalid,
            "signed manifest key id is empty",
        ));
    }
    if manifest.payload_sha256 != slot.payload_sha256 {
        return Err(backup_error_anyhow(
            BackupErrorCode::ManifestInvalid,
            "signed manifest payload hash does not match slot payload hash",
        ));
    }
    Ok(())
}

fn build_backup_export_payload(
    keystore: &Keystore,
    scopes: &[BackupExportScope],
) -> anyhow::Result<Value> {
    let mut payload = serde_json::Map::new();
    payload.insert(
        "schema".to_string(),
        json!("citizen.wallet.backup.export.v1"),
    );
    payload.insert("version".to_string(), json!(1));
    payload.insert("scopes".to_string(), serde_json::to_value(scopes)?);
    if scopes.contains(&BackupExportScope::Keys) {
        payload.insert("keystore".to_string(), serde_json::to_value(keystore)?);
    }
    if scopes.contains(&BackupExportScope::RecoveryMetadata) {
        payload.insert(
            "recovery_metadata".to_string(),
            json!({"exported_via": "wallet-cli"}),
        );
    }
    if scopes.contains(&BackupExportScope::ConsentReceipts) {
        payload.insert("consent_receipts".to_string(), json!([]));
    }
    Ok(Value::Object(payload))
}

fn parse_backup_keystore(payload: &[u8]) -> anyhow::Result<Keystore> {
    let value: Value = serde_json::from_slice(payload)?;
    if let Some(keystore) = value.get("keystore") {
        return Ok(serde_json::from_value(keystore.clone())?);
    }
    Ok(serde_json::from_value(value)?)
}

fn load_backup_password(explicit: Option<String>, env_var: &str) -> anyhow::Result<String> {
    if let Some(password) = explicit {
        return Ok(password);
    }
    std::env::var(env_var)
        .map_err(|_| anyhow::anyhow!("password required (--password or {env_var})"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::json;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    fn unique_test_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("citizen-wallet-{name}-{nanos}"))
    }

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

    #[test]
    fn compose_draft_detects_payload_mutation() {
        let keypair = WalletKeypair::generate();
        let entry = sign_entry(
            EntryDraft {
                namespace: "audit.procurement".to_string(),
                action: "RECORD_EVENT".to_string(),
                object_id: "AUD-2".to_string(),
                payload: json!({"event": "OPEN"}),
                privacy_flag: false,
                privacy_mode: PrivacyMode::None,
                encryption_passphrase: None,
                authorized_readers: vec![],
                custodian_policy_id: None,
                key_wrapped_secrets: vec![],
                revocation_events: vec![],
                field_reader_acls: Default::default(),
                reader_public_keys: BTreeMap::new(),
                author: "did:ledger:author-1".to_string(),
                timestamp: 1_736_500_000,
            },
            &keypair,
        )
        .expect("entry");
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:key:alice".to_string(),
            signature: "sig-a".to_string(),
            signature_scope: Some("canonical_payload_v1".to_string()),
            co_signatures: vec![],
            multisig_policy: Some(EnvelopeMultisigPolicy {
                threshold: 2,
                allowed_signers: vec!["did:key:alice".to_string(), "did:key:bob".to_string()],
                require_author_signature: false,
            }),
            submitted_at: Utc::now(),
            payload: entry,
        };
        let mut draft = compose_draft_from_envelope(envelope, "canonical_payload_v1".to_string())
            .expect("draft");
        draft.envelope.payload.object_id = "AUD-3".to_string();
        let err = validate_compose_draft_integrity(&draft).expect_err("mutation should fail");
        assert!(err.to_string().contains("payload mutated"));
    }

    #[test]
    fn finalize_requires_threshold() {
        let entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "identity.citizen".to_string(),
            action: "REGISTER_IDENTITY".to_string(),
            object_id: "did:citizen:a".to_string(),
            payload: json!({"subject":"did:citizen:a"}),
            privacy_flag: false,
            privacy_mode: PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:key:alice".to_string(),
            signature: "sig-a".to_string(),
            timestamp: 1_736_500_000,
        };
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:key:alice".to_string(),
            signature: "sig-a".to_string(),
            signature_scope: Some("canonical_payload_v1".to_string()),
            co_signatures: vec![],
            multisig_policy: Some(EnvelopeMultisigPolicy {
                threshold: 2,
                allowed_signers: vec!["did:key:alice".to_string(), "did:key:bob".to_string()],
                require_author_signature: true,
            }),
            submitted_at: Utc::now(),
            payload: entry,
        };
        let err = validate_envelope_signers(&envelope, true).expect_err("threshold");
        assert!(err.to_string().contains("threshold"));
    }

    #[test]
    fn backup_vault_roundtrip_restore_recovers_keystore() {
        let base = unique_test_path("backup-roundtrip");
        let keystore_path = base.join("wallet.json");
        let vault_path = base.join("vault.json");
        let restored_path = base.join("wallet-restored.json");
        fs::create_dir_all(&base).expect("create test directory");

        let keypair = WalletKeypair::generate();
        let mut keystore = Keystore {
            version: 1,
            keys: vec![],
        };
        keystore.add_key(KeyRecord {
            key_id: keypair.key_id,
            label: Some("primary".to_string()),
            public_key_hex: hex::encode(keypair.signing_key.verifying_key().to_bytes()),
            secret_key_hex: Some(hex::encode(keypair.signing_key.to_bytes())),
            encrypted_secret_key: None,
            created_at: Utc::now().timestamp(),
        });
        keystore.save(&keystore_path).expect("save keystore");

        backup_init(BackupInitArgs {
            vault_path: vault_path.clone(),
            portable_label: Some("usb-a".to_string()),
            decoy_password: Some("decoy-pass".to_string()),
            critical_password: Some("critical-pass".to_string()),
            kdf_profile: BackupKdfProfile::Balanced,
            json: false,
            assume_removable_media_risk: true,
        })
        .expect("init vault");
        backup_export_credentials(BackupExportArgs {
            path: keystore_path,
            vault_path: vault_path.clone(),
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            scopes: vec![BackupExportScope::Keys, BackupExportScope::RecoveryMetadata],
            assume_removable_media_risk: true,
        })
        .expect("export credentials");
        backup_verify(BackupVerifyArgs {
            vault_path: vault_path.clone(),
            role: Some(BackupSlotRole::Critical),
            password: Some("critical-pass".to_string()),
            json: true,
        })
        .expect("verify");
        backup_restore(BackupRestoreArgs {
            output_path: restored_path.clone(),
            vault_path,
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            json: true,
            assume_removable_media_risk: true,
        })
        .expect("restore");

        let restored = Keystore::load_or_create(&restored_path).expect("load restored keystore");
        assert!(restored.has_key(keypair.key_id));
    }

    #[test]
    fn backup_verify_detects_payload_checksum_tamper() {
        let base = unique_test_path("backup-tamper");
        let keystore_path = base.join("wallet.json");
        let vault_path = base.join("vault.json");
        fs::create_dir_all(&base).expect("create test directory");

        let mut keystore = Keystore {
            version: 1,
            keys: vec![],
        };
        keystore.add_key(KeyRecord {
            key_id: Uuid::new_v4(),
            label: Some("tamper-check".to_string()),
            public_key_hex: "aa".repeat(32),
            secret_key_hex: Some("bb".repeat(32)),
            encrypted_secret_key: None,
            created_at: Utc::now().timestamp(),
        });
        keystore.save(&keystore_path).expect("save keystore");

        backup_init(BackupInitArgs {
            vault_path: vault_path.clone(),
            portable_label: None,
            decoy_password: Some("decoy-pass".to_string()),
            critical_password: Some("critical-pass".to_string()),
            kdf_profile: BackupKdfProfile::Balanced,
            json: false,
            assume_removable_media_risk: true,
        })
        .expect("init vault");
        backup_export_credentials(BackupExportArgs {
            path: keystore_path,
            vault_path: vault_path.clone(),
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            scopes: vec![BackupExportScope::Keys],
            assume_removable_media_risk: true,
        })
        .expect("export credentials");

        let mut vault = load_backup_vault(&vault_path).expect("load vault");
        let slot = vault
            .slots
            .iter_mut()
            .find(|slot| slot.role == BackupSlotRole::Critical)
            .expect("critical slot exists");
        slot.payload_sha256 = "deadbeef".to_string();
        save_backup_vault(&vault_path, &vault).expect("save tampered vault");

        let err = backup_verify(BackupVerifyArgs {
            vault_path,
            role: Some(BackupSlotRole::Critical),
            password: Some("critical-pass".to_string()),
            json: false,
        })
        .expect_err("tampered backup should fail");
        assert!(err.to_string().contains("checksum_mismatch"));
    }

    #[test]
    fn backup_verify_requires_signed_manifest() {
        let base = unique_test_path("backup-manifest-required");
        let keystore_path = base.join("wallet.json");
        let vault_path = base.join("vault.json");
        fs::create_dir_all(&base).expect("create test directory");

        let mut keystore = Keystore {
            version: 1,
            keys: vec![],
        };
        keystore.add_key(KeyRecord {
            key_id: Uuid::new_v4(),
            label: Some("manifest-check".to_string()),
            public_key_hex: "aa".repeat(32),
            secret_key_hex: Some("bb".repeat(32)),
            encrypted_secret_key: None,
            created_at: Utc::now().timestamp(),
        });
        keystore.save(&keystore_path).expect("save keystore");

        backup_init(BackupInitArgs {
            vault_path: vault_path.clone(),
            portable_label: None,
            decoy_password: Some("decoy-pass".to_string()),
            critical_password: Some("critical-pass".to_string()),
            kdf_profile: BackupKdfProfile::Balanced,
            json: false,
            assume_removable_media_risk: true,
        })
        .expect("init vault");
        backup_export_credentials(BackupExportArgs {
            path: keystore_path,
            vault_path: vault_path.clone(),
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            scopes: vec![BackupExportScope::Keys],
            assume_removable_media_risk: true,
        })
        .expect("export credentials");

        let mut vault = load_backup_vault(&vault_path).expect("load vault");
        let slot = vault
            .slots
            .iter_mut()
            .find(|slot| slot.role == BackupSlotRole::Critical)
            .expect("critical slot exists");
        slot.signed_manifest = None;
        save_backup_vault(&vault_path, &vault).expect("save tampered vault");

        let err = backup_verify(BackupVerifyArgs {
            vault_path,
            role: Some(BackupSlotRole::Critical),
            password: Some("critical-pass".to_string()),
            json: false,
        })
        .expect_err("backup without signed manifest should fail");
        assert!(err.to_string().contains("manifest_missing"));
    }

    #[test]
    fn backup_restore_returns_slot_not_found_error_identifier() {
        let base = unique_test_path("backup-slot-not-found");
        let vault_path = base.join("vault.json");
        let output_path = base.join("wallet-restored.json");
        fs::create_dir_all(&base).expect("create test directory");

        backup_init(BackupInitArgs {
            vault_path: vault_path.clone(),
            portable_label: None,
            decoy_password: Some("decoy-pass".to_string()),
            critical_password: Some("critical-pass".to_string()),
            kdf_profile: BackupKdfProfile::Balanced,
            json: false,
            assume_removable_media_risk: true,
        })
        .expect("init vault");
        let mut vault = load_backup_vault(&vault_path).expect("load vault");
        vault.slots.retain(|slot| slot.role != BackupSlotRole::Decoy);
        save_backup_vault(&vault_path, &vault).expect("save vault");

        let err = backup_restore(BackupRestoreArgs {
            output_path,
            vault_path,
            role: BackupSlotRole::Decoy,
            password: Some("decoy-pass".to_string()),
            json: true,
            assume_removable_media_risk: true,
        })
        .expect_err("missing slot should fail");

        assert!(err.to_string().contains("slot_not_found"));
    }

    #[test]
    fn backup_verify_rejects_missing_schema_with_deterministic_error() {
        let base = unique_test_path("backup-missing-schema");
        let vault_path = base.join("vault.json");
        fs::create_dir_all(&base).expect("create test directory");
        fs::write(&vault_path, r#"{"version":1,"slots":[]}"#).expect("write malformed vault");

        let err = backup_verify(BackupVerifyArgs {
            vault_path,
            role: None,
            password: None,
            json: true,
        })
        .expect_err("missing schema should fail");
        assert!(err.to_string().contains("unsupported_schema"));
    }

    #[test]
    fn backup_verify_rejects_truncated_ciphertext_with_decrypt_failed() {
        let base = unique_test_path("backup-truncated-ciphertext");
        let keystore_path = base.join("wallet.json");
        let vault_path = base.join("vault.json");
        fs::create_dir_all(&base).expect("create test directory");

        let mut keystore = Keystore {
            version: 1,
            keys: vec![],
        };
        keystore.add_key(KeyRecord {
            key_id: Uuid::new_v4(),
            label: Some("truncate-check".to_string()),
            public_key_hex: "aa".repeat(32),
            secret_key_hex: Some("bb".repeat(32)),
            encrypted_secret_key: None,
            created_at: Utc::now().timestamp(),
        });
        keystore.save(&keystore_path).expect("save keystore");

        backup_init(BackupInitArgs {
            vault_path: vault_path.clone(),
            portable_label: None,
            decoy_password: Some("decoy-pass".to_string()),
            critical_password: Some("critical-pass".to_string()),
            kdf_profile: BackupKdfProfile::Balanced,
            json: false,
            assume_removable_media_risk: true,
        })
        .expect("init vault");
        backup_export_credentials(BackupExportArgs {
            path: keystore_path,
            vault_path: vault_path.clone(),
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            scopes: vec![BackupExportScope::Keys],
            assume_removable_media_risk: true,
        })
        .expect("export credentials");

        let mut vault = load_backup_vault(&vault_path).expect("load vault");
        let slot = vault
            .slots
            .iter_mut()
            .find(|slot| slot.role == BackupSlotRole::Critical)
            .expect("critical slot exists");
        slot.encrypted_payload.ciphertext_hex = "00".to_string();
        save_backup_vault(&vault_path, &vault).expect("save tampered vault");

        let err = backup_verify(BackupVerifyArgs {
            vault_path,
            role: Some(BackupSlotRole::Critical),
            password: Some("critical-pass".to_string()),
            json: true,
        })
        .expect_err("truncated ciphertext should fail");
        assert!(err.to_string().contains("decrypt_failed"));
    }

    #[test]
    fn backup_verify_rejects_random_bit_flip_tamper_with_deterministic_error() {
        let base = unique_test_path("backup-bitflip-tamper");
        let keystore_path = base.join("wallet.json");
        let vault_path = base.join("vault.json");
        fs::create_dir_all(&base).expect("create test directory");

        let mut keystore = Keystore {
            version: 1,
            keys: vec![],
        };
        keystore.add_key(KeyRecord {
            key_id: Uuid::new_v4(),
            label: Some("bitflip-check".to_string()),
            public_key_hex: "cc".repeat(32),
            secret_key_hex: Some("dd".repeat(32)),
            encrypted_secret_key: None,
            created_at: Utc::now().timestamp(),
        });
        keystore.save(&keystore_path).expect("save keystore");

        backup_init(BackupInitArgs {
            vault_path: vault_path.clone(),
            portable_label: None,
            decoy_password: Some("decoy-pass".to_string()),
            critical_password: Some("critical-pass".to_string()),
            kdf_profile: BackupKdfProfile::Balanced,
            json: false,
            assume_removable_media_risk: true,
        })
        .expect("init vault");
        backup_export_credentials(BackupExportArgs {
            path: keystore_path,
            vault_path: vault_path.clone(),
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            scopes: vec![BackupExportScope::Keys],
            assume_removable_media_risk: true,
        })
        .expect("export credentials");

        let mut vault = load_backup_vault(&vault_path).expect("load vault");
        let slot = vault
            .slots
            .iter_mut()
            .find(|slot| slot.role == BackupSlotRole::Critical)
            .expect("critical slot exists");
        let mut ciphertext = slot.encrypted_payload.ciphertext_hex.clone().into_bytes();
        assert!(!ciphertext.is_empty(), "ciphertext should not be empty");
        let tamper_index = ciphertext.len() / 2;
        ciphertext[tamper_index] = if ciphertext[tamper_index] == b'0' { b'1' } else { b'0' };
        slot.encrypted_payload.ciphertext_hex =
            String::from_utf8(ciphertext).expect("tampered ciphertext remains utf8");
        save_backup_vault(&vault_path, &vault).expect("save tampered vault");

        let err = backup_verify(BackupVerifyArgs {
            vault_path,
            role: Some(BackupSlotRole::Critical),
            password: Some("critical-pass".to_string()),
            json: true,
        })
        .expect_err("bit-flipped ciphertext should fail");
        let rendered = err.to_string();
        assert!(
            rendered.contains("decrypt_failed") || rendered.contains("checksum_mismatch"),
            "unexpected deterministic error: {rendered}"
        );
    }

    #[test]
    fn backup_verify_rejects_multiple_bit_flip_positions_with_deterministic_errors() {
        let base = unique_test_path("backup-multi-bitflip-tamper");
        let keystore_path = base.join("wallet.json");
        let vault_path = base.join("vault.json");
        fs::create_dir_all(&base).expect("create test directory");

        let mut keystore = Keystore {
            version: 1,
            keys: vec![],
        };
        keystore.add_key(KeyRecord {
            key_id: Uuid::new_v4(),
            label: Some("multi-bitflip-check".to_string()),
            public_key_hex: "ee".repeat(32),
            secret_key_hex: Some("ff".repeat(32)),
            encrypted_secret_key: None,
            created_at: Utc::now().timestamp(),
        });
        keystore.save(&keystore_path).expect("save keystore");

        backup_init(BackupInitArgs {
            vault_path: vault_path.clone(),
            portable_label: None,
            decoy_password: Some("decoy-pass".to_string()),
            critical_password: Some("critical-pass".to_string()),
            kdf_profile: BackupKdfProfile::Balanced,
            json: false,
            assume_removable_media_risk: true,
        })
        .expect("init vault");
        backup_export_credentials(BackupExportArgs {
            path: keystore_path,
            vault_path: vault_path.clone(),
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            scopes: vec![BackupExportScope::Keys],
            assume_removable_media_risk: true,
        })
        .expect("export credentials");

        let original_vault = load_backup_vault(&vault_path).expect("load vault");
        let original_ciphertext_hex = original_vault
            .slots
            .iter()
            .find(|slot| slot.role == BackupSlotRole::Critical)
            .expect("critical slot exists")
            .encrypted_payload
            .ciphertext_hex
            .clone();

        let candidate_indexes = [
            0usize,
            original_ciphertext_hex.len() / 3,
            original_ciphertext_hex.len() / 2,
            (original_ciphertext_hex.len() * 2) / 3,
            original_ciphertext_hex.len().saturating_sub(1),
        ];

        for (case_idx, tamper_index) in candidate_indexes.into_iter().enumerate() {
            let mut vault_case = load_backup_vault(&vault_path).expect("reload vault");
            let slot = vault_case
                .slots
                .iter_mut()
                .find(|slot| slot.role == BackupSlotRole::Critical)
                .expect("critical slot exists");
            let mut ciphertext = slot.encrypted_payload.ciphertext_hex.clone().into_bytes();
            assert!(!ciphertext.is_empty(), "ciphertext should not be empty");

            let bounded_index = tamper_index.min(ciphertext.len() - 1);
            ciphertext[bounded_index] = if ciphertext[bounded_index] == b'0' {
                b'1'
            } else {
                b'0'
            };
            slot.encrypted_payload.ciphertext_hex =
                String::from_utf8(ciphertext).expect("tampered ciphertext remains utf8");
            save_backup_vault(&vault_path, &vault_case).expect("save tampered vault");

            let err = backup_verify(BackupVerifyArgs {
                vault_path: vault_path.clone(),
                role: Some(BackupSlotRole::Critical),
                password: Some("critical-pass".to_string()),
                json: true,
            })
            .expect_err("bit-flipped ciphertext should fail");
            let rendered = err.to_string();
            assert!(
                rendered.contains("decrypt_failed") || rendered.contains("checksum_mismatch"),
                "case {case_idx} produced unexpected deterministic error: {rendered}"
            );
        }

        let mut restored_vault = load_backup_vault(&vault_path).expect("reload vault");
        if let Some(slot) = restored_vault
            .slots
            .iter_mut()
            .find(|slot| slot.role == BackupSlotRole::Critical)
        {
            slot.encrypted_payload.ciphertext_hex = original_ciphertext_hex;
            save_backup_vault(&vault_path, &restored_vault).expect("restore original vault");
        }
    }



    #[test]
    fn backup_verify_rejects_malformed_vault_structure_matrix() {
        let base = unique_test_path("backup-malformed-structure-matrix");
        fs::create_dir_all(&base).expect("create test directory");

        let fixture = include_str!("../tests/fixtures/backup_vault_schema_v1_fixture.json");
        let base_value: Value = serde_json::from_str(fixture).expect("parse fixture");

        let mut cases: Vec<(&str, Value)> = Vec::new();

        let mut missing_schema = base_value.clone();
        missing_schema
            .as_object_mut()
            .expect("object")
            .remove("schema");
        cases.push(("missing-schema", missing_schema));

        let mut wrong_version_type = base_value.clone();
        wrong_version_type
            .as_object_mut()
            .expect("object")
            .insert("version".to_string(), Value::String("one".to_string()));
        cases.push(("wrong-version-type", wrong_version_type));

        let mut empty_slots = base_value.clone();
        empty_slots
            .as_object_mut()
            .expect("object")
            .insert("slots".to_string(), Value::Array(vec![]));
        cases.push(("empty-slots", empty_slots));

        let mut bad_ciphertext = base_value.clone();
        let slots = bad_ciphertext["slots"].as_array_mut().expect("slots array");
        slots[0]["encrypted_payload"]["ciphertext_hex"] = Value::String("zz-not-hex".to_string());
        cases.push(("invalid-ciphertext-envelope", bad_ciphertext));

        for (label, case_value) in cases {
            let path = base.join(format!("{label}.json"));
            fs::write(&path, serde_json::to_vec_pretty(&case_value).expect("serialize case"))
                .expect("write case vault");

            let err = backup_verify(BackupVerifyArgs {
                vault_path: path,
                role: Some(BackupSlotRole::Critical),
                password: Some("critical-pass".to_string()),
                json: true,
            })
            .expect_err("malformed vault should fail");

            let rendered = err.to_string();
            assert!(
                rendered.contains("unsupported_schema")
                    || rendered.contains("slot_not_found")
                    || rendered.contains("decrypt_failed"),
                "{label} should map to deterministic malformed-vault failure, got: {rendered}"
            );
        }
    }

    proptest! {
        #[test]
        fn backup_verify_rejects_randomized_metadata_mutations(
            remove_schema in any::<bool>(),
            corrupt_version in any::<bool>(),
            empty_slots in any::<bool>(),
            slot_index_seed in 0usize..8usize,
            mutate_key_id in any::<bool>(),
            mutate_manifest_schema in any::<bool>(),
            bad_hash in any::<bool>(),
        ) {
            let base = unique_test_path("backup-random-metadata-mutation");
            fs::create_dir_all(&base).expect("create test directory");

            let fixture = include_str!("../tests/fixtures/backup_vault_schema_v1_fixture.json");
            let mut case_value: Value = serde_json::from_str(fixture).expect("parse fixture");

            if remove_schema {
                case_value.as_object_mut().expect("object").remove("schema");
            }
            if corrupt_version {
                case_value
                    .as_object_mut()
                    .expect("object")
                    .insert("version".to_string(), Value::String("broken".to_string()));
            }
            if empty_slots {
                case_value
                    .as_object_mut()
                    .expect("object")
                    .insert("slots".to_string(), Value::Array(vec![]));
            } else if let Some(slots) = case_value.get_mut("slots").and_then(Value::as_array_mut) {
                if !slots.is_empty() {
                    let slot_index = slot_index_seed % slots.len();
                    if mutate_key_id {
                        slots[slot_index]["signed_manifest"]["key_id"] = Value::String(String::new());
                    }
                    if mutate_manifest_schema {
                        slots[slot_index]["signed_manifest"]["schema"] =
                            Value::String("citizen.wallet.backup.manifest.v999".to_string());
                    }
                    if bad_hash {
                        slots[slot_index]["payload_sha256"] = Value::String("00".repeat(32));
                    }
                }
            }

            let path = base.join("metadata-mutation.json");
            fs::write(&path, serde_json::to_vec_pretty(&case_value).expect("serialize case"))
                .expect("write case vault");

            let err = backup_verify(BackupVerifyArgs {
                vault_path: path,
                role: Some(BackupSlotRole::Critical),
                password: Some("critical-pass".to_string()),
                json: true,
            })
            .expect_err("mutated vault should fail verification");

            let rendered = err.to_string();
            prop_assert!(
                rendered.contains("unsupported_schema")
                    || rendered.contains("slot_not_found")
                    || rendered.contains("invalid_payload")
                    || rendered.contains("decrypt_failed")
                    || rendered.contains("checksum_mismatch"),
                "unexpected deterministic mutation error: {rendered}"
            );
        }
    }

    #[test]
    fn backup_vault_schema_fixture_remains_compatible() {
        let fixture = include_str!("../tests/fixtures/backup_vault_schema_v1_fixture.json");
        let value: Value = serde_json::from_str(fixture).expect("parse fixture json");
        let object = value.as_object().expect("fixture should be a json object");

        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["created_at", "portable_label", "schema", "slots", "version"],
            "fixture top-level keys changed; review compatibility impact"
        );

        assert_eq!(
            object
                .get("schema")
                .and_then(Value::as_str)
                .expect("schema string"),
            "citizen.wallet.backup.v1"
        );
        assert_eq!(
            object
                .get("version")
                .and_then(Value::as_u64)
                .expect("version number"),
            1
        );

        let vault: BackupVaultFile = serde_json::from_value(value).expect("deserialize vault fixture");
        assert_eq!(vault.schema, "citizen.wallet.backup.v1");
        assert_eq!(vault.version, 1);
        assert_eq!(vault.slots.len(), 2, "fixture should include decoy+critical slots");
        assert!(
            vault
                .slots
                .iter()
                .all(|slot| slot.signed_manifest.is_some()),
            "fixture slots must include signed manifests"
        );
    }

    #[test]
    #[ignore = "manual performance evidence harness for wallet backup command path"]
    fn backup_command_path_performance_evidence_harness() {
        let iterations = std::env::var("CITIZEN_WALLET_BACKUP_PERF_ITERATIONS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(5);

        let mut samples = Vec::with_capacity(iterations);
        for iteration in 0..iterations {
            let base = unique_test_path(&format!("backup-command-perf-evidence-{iteration}"));
            let keystore_path = base.join("wallet.json");
            let vault_path = base.join("vault.json");
            let restored_path = base.join("wallet-restored.json");
            fs::create_dir_all(&base).expect("create test directory");

            let mut keystore = Keystore { version: 1, keys: vec![] };
            keystore.add_key(KeyRecord {
                key_id: Uuid::new_v4(),
                label: Some(format!("perf-evidence-{iteration}")),
                public_key_hex: "ab".repeat(32),
                secret_key_hex: Some("cd".repeat(32)),
                encrypted_secret_key: None,
                created_at: Utc::now().timestamp(),
            });
            keystore.save(&keystore_path).expect("save keystore");

            let init_started = Instant::now();
            backup_init(BackupInitArgs {
                vault_path: vault_path.clone(),
                portable_label: Some("perf-usb".to_string()),
                decoy_password: Some("decoy-pass".to_string()),
                critical_password: Some("critical-pass".to_string()),
                kdf_profile: BackupKdfProfile::Balanced,
                json: true,
                assume_removable_media_risk: true,
            }).expect("init vault");
            let init_ms = init_started.elapsed().as_millis();

            let export_started = Instant::now();
            backup_export_credentials(BackupExportArgs {
                path: keystore_path,
                vault_path: vault_path.clone(),
                role: BackupSlotRole::Critical,
                password: Some("critical-pass".to_string()),
                scopes: vec![BackupExportScope::Keys, BackupExportScope::RecoveryMetadata],
                assume_removable_media_risk: true,
            }).expect("export credentials");
            let export_ms = export_started.elapsed().as_millis();

            let verify_started = Instant::now();
            backup_verify(BackupVerifyArgs {
                vault_path: vault_path.clone(),
                role: Some(BackupSlotRole::Critical),
                password: Some("critical-pass".to_string()),
                json: true,
            }).expect("verify");
            let verify_ms = verify_started.elapsed().as_millis();

            let restore_started = Instant::now();
            backup_restore(BackupRestoreArgs {
                output_path: restored_path,
                vault_path,
                role: BackupSlotRole::Critical,
                password: Some("critical-pass".to_string()),
                json: true,
                assume_removable_media_risk: true,
            }).expect("restore");
            let restore_ms = restore_started.elapsed().as_millis();

            samples.push(serde_json::json!({
                "iteration": iteration,
                "init_ms": init_ms,
                "export_ms": export_ms,
                "verify_ms": verify_ms,
                "restore_ms": restore_ms,
            }));
        }

        eprintln!("wallet backup performance evidence: {}", serde_json::to_string_pretty(&samples).expect("serialize performance samples"));
    }
    #[test]
    fn backup_command_path_latency_envelope_stays_within_thresholds() {
        let base = unique_test_path("backup-command-latency-envelope");
        let keystore_path = base.join("wallet.json");
        let vault_path = base.join("vault.json");
        let restored_path = base.join("wallet-restored.json");
        fs::create_dir_all(&base).expect("create test directory");

        let mut keystore = Keystore {
            version: 1,
            keys: vec![],
        };
        keystore.add_key(KeyRecord {
            key_id: Uuid::new_v4(),
            label: Some("latency-envelope".to_string()),
            public_key_hex: "11".repeat(32),
            secret_key_hex: Some("22".repeat(32)),
            encrypted_secret_key: None,
            created_at: Utc::now().timestamp(),
        });
        keystore.save(&keystore_path).expect("save keystore");

        let init_start = Instant::now();
        backup_init(BackupInitArgs {
            vault_path: vault_path.clone(),
            portable_label: Some("usb-latency".to_string()),
            decoy_password: Some("decoy-pass".to_string()),
            critical_password: Some("critical-pass".to_string()),
            kdf_profile: BackupKdfProfile::Balanced,
            json: true,
            assume_removable_media_risk: true,
        })
        .expect("init vault");
        let init_elapsed = init_start.elapsed();

        let export_start = Instant::now();
        backup_export_credentials(BackupExportArgs {
            path: keystore_path,
            vault_path: vault_path.clone(),
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            scopes: vec![BackupExportScope::Keys, BackupExportScope::RecoveryMetadata],
            assume_removable_media_risk: true,
        })
        .expect("export credentials");
        let export_elapsed = export_start.elapsed();

        let verify_start = Instant::now();
        backup_verify(BackupVerifyArgs {
            vault_path: vault_path.clone(),
            role: Some(BackupSlotRole::Critical),
            password: Some("critical-pass".to_string()),
            json: true,
        })
        .expect("verify");
        let verify_elapsed = verify_start.elapsed();

        let restore_start = Instant::now();
        backup_restore(BackupRestoreArgs {
            output_path: restored_path.clone(),
            vault_path: vault_path.clone(),
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            json: true,
            assume_removable_media_risk: true,
        })
        .expect("restore");
        let restore_elapsed = restore_start.elapsed();

        let restored = Keystore::load_or_create(&restored_path).expect("load restored keystore");
        assert_eq!(restored.keys.len(), 1, "restore should preserve key count");

        let init_max = Duration::from_millis(5_000);
        let export_max = Duration::from_millis(8_000);
        let verify_max = Duration::from_millis(8_000);
        let restore_max = Duration::from_millis(8_000);
        assert!(
            init_elapsed <= init_max,
            "init latency {:?} exceeded threshold {:?}",
            init_elapsed,
            init_max
        );
        assert!(
            export_elapsed <= export_max,
            "export latency {:?} exceeded threshold {:?}",
            export_elapsed,
            export_max
        );
        assert!(
            verify_elapsed <= verify_max,
            "verify latency {:?} exceeded threshold {:?}",
            verify_elapsed,
            verify_max
        );
        assert!(
            restore_elapsed <= restore_max,
            "restore latency {:?} exceeded threshold {:?}",
            restore_elapsed,
            restore_max
        );
    }

    #[test]
    fn backup_verify_rejects_byte_level_mutation_corpus_without_panics() {
        let base = unique_test_path("backup-byte-level-mutation-corpus");
        let keystore_path = base.join("wallet.json");
        let vault_path = base.join("vault.json");
        fs::create_dir_all(&base).expect("create test directory");

        let mut keystore = Keystore {
            version: 1,
            keys: vec![],
        };
        keystore.add_key(KeyRecord {
            key_id: Uuid::new_v4(),
            label: Some("byte-fuzz".to_string()),
            public_key_hex: "33".repeat(32),
            secret_key_hex: Some("44".repeat(32)),
            encrypted_secret_key: None,
            created_at: Utc::now().timestamp(),
        });
        keystore.save(&keystore_path).expect("save keystore");

        backup_init(BackupInitArgs {
            vault_path: vault_path.clone(),
            portable_label: Some("usb-byte-fuzz".to_string()),
            decoy_password: Some("decoy-pass".to_string()),
            critical_password: Some("critical-pass".to_string()),
            kdf_profile: BackupKdfProfile::Balanced,
            json: true,
            assume_removable_media_risk: true,
        })
        .expect("init vault");
        backup_export_credentials(BackupExportArgs {
            path: keystore_path,
            vault_path: vault_path.clone(),
            role: BackupSlotRole::Critical,
            password: Some("critical-pass".to_string()),
            scopes: vec![BackupExportScope::Keys],
            assume_removable_media_risk: true,
        })
        .expect("export credentials");

        let original_bytes = fs::read(&vault_path).expect("read baseline vault bytes");
        let mutation_positions = [0usize, 1, 7, 15, 31, 63, 127, 255];
        let mut covered_cases = 0usize;
        let mut failure_cases = 0usize;

        for position in mutation_positions {
            if position >= original_bytes.len() {
                continue;
            }
            covered_cases += 1;
            let mut mutated = original_bytes.clone();
            mutated[position] ^= 0b0101_1010;

            let case_path = base.join(format!("mutated-byte-{position}.json"));
            fs::write(&case_path, &mutated).expect("write mutated vault");

            let result = backup_verify(BackupVerifyArgs {
                vault_path: case_path,
                role: Some(BackupSlotRole::Critical),
                password: Some("critical-pass".to_string()),
                json: true,
            });
            if let Err(err) = result {
                failure_cases += 1;
                let rendered = err.to_string();
                assert!(
                    rendered.contains("unsupported_schema")
                        || rendered.contains("decrypt_failed")
                        || rendered.contains("invalid_payload")
                        || rendered.contains("checksum_mismatch"),
                    "byte mutation should map to deterministic failure codes, got: {rendered}"
                );
            }
        }

        assert!(covered_cases > 0, "expected at least one mutation case");
        assert!(
            failure_cases > 0,
            "expected at least one byte mutation case to fail deterministically"
        );
    }

    #[test]
    fn backup_json_contract_examples_match_v1_schema() {
        let vault = BackupVaultFile {
            schema: "citizen.wallet.backup.v1".to_string(),
            version: 1,
            portable_label: Some("usb-primary".to_string()),
            created_at: 1_736_500_000,
            slots: vec![],
        };
        let init = backup_init_json_output(
            Path::new("/tmp/vault.json"),
            &vault,
            BackupKdfProfile::Balanced,
            19_456,
            2,
            1,
            32,
        );
        let verify = backup_verify_json_output(&vault, &[]);
        let restore = backup_restore_json_output(
            Path::new("/tmp/wallet-restored.json"),
            BackupSlotRole::Critical,
            1_736_500_100,
        );

        for output in [&init, &verify, &restore] {
            assert_eq!(
                output["contract_version"].as_str(),
                Some(BACKUP_JSON_CONTRACT_VERSION)
            );
        }
        assert_eq!(init["kdf_params"]["kdf"].as_str(), Some("argon2id"));
        assert_eq!(verify["schema"].as_str(), Some("citizen.wallet.backup.v1"));
        assert_eq!(restore["status"].as_str(), Some("restored"));
    }
}
