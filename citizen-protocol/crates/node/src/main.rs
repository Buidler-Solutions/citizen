mod admission;

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use chrono::Utc;
use citizen_api::{ApiClientProfile, ApiEdgeConfig, ApiServer, MinioOffchainObjectStoreConfig};
use citizen_consensus::ConsensusEngine;
use citizen_crypto::{verifying_key_to_string, KeyRegistry, ValidatorKeypair};
use citizen_ledger::Ledger;
use citizen_network::{
    AdmissionControl, ConsensusMessage, HandshakeIdentity, MockNetwork, Network, NetworkLatency,
    QuicNetwork,
};
use citizen_storage::RocksDbStorage;
use citizen_txpool::TxPool;
use citizen_types::{
    ConsensusConfig, EpochState, NamespaceRuleset, ProtocolError, ValidatorId, ValidatorMetadata,
    ValidatorPerformance, ValidatorSetSnapshot, ValidatorStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use tokio::signal;

use admission::{startup::run_preflight, AdmissionContext, AdmissionSettings};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match parse_cli_args(env::args()) {
        CliDirective::PrintHelp => {
            print_help();
            return Ok(());
        }
        CliDirective::PrintVersion => {
            println!("citizen-node {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        CliDirective::Run { .. } => {}
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .init();

    let config_path = match parse_cli_args(env::args()) {
        CliDirective::Run { config_path } => config_path,
        CliDirective::PrintHelp | CliDirective::PrintVersion => unreachable!(),
    };
    let config = NodeConfig::load(&config_path).unwrap_or_default();

    tracing::info!("validator_id" = %config.validator_id, "block_time_ms" = config.block_time_millis, "quorum_bps" = config.quorum_bps, "loaded_config" = %config_path.display());

    let storage_path = config
        .data_dir
        .clone()
        .unwrap_or_else(|| PathBuf::from("data"));
    let storage = Arc::new(RocksDbStorage::open(storage_path)?);
    let admission_settings = config.admission_settings();
    let admission_context = run_preflight(&admission_settings, storage.as_ref())
        .map_err(|err| anyhow::anyhow!("admission preflight failed: {err}"))?;
    tracing::info!(
        network_id = %admission_context.network_id,
        genesis_hash = %admission_context.genesis_hash,
        manifest_digest = %admission_context.manifest_digest,
        manifest_version = ?admission_context.manifest_version,
        "admission preflight passed"
    );
    let key_registry = KeyRegistry::new();
    let ledger = Arc::new(Ledger::new(storage.clone(), key_registry));
    ledger.bootstrap_namespaces(config.namespaces.clone());
    let txpool = Arc::new(TxPool::default());

    let api_server = if config.offchain_minio_config().is_some() {
        tracing::warn!("node does not yet support combining MinIO off-chain store with shared txpool; using local object store");
        ApiServer::with_edge_config_and_txpool(
            Arc::clone(&ledger),
            config.api_edge_config(),
            Arc::clone(&txpool),
        )
    } else {
        ApiServer::with_edge_config_and_txpool(
            Arc::clone(&ledger),
            config.api_edge_config(),
            Arc::clone(&txpool),
        )
    };
    let api_handle = api_server
        .serve(SocketAddr::from((Ipv4Addr::LOCALHOST, config.api_port)))
        .await;

    let consensus_task = if config.node_role == NodeRole::Validator && !config.standby_only {
        let keypair = config.load_or_generate_keypair()?;
        let verifying_key_hex = verifying_key_to_string(keypair.verifying_key());
        tracing::info!("verifying_key" = %verifying_key_hex, "note" = "share this key for validator admission");
        let snapshot = config.build_admission_snapshot(&verifying_key_hex, &admission_context)?;
        let rotation = Duration::from_secs(config.network_key_rotation_secs);
        let admission_identity = config.handshake_identity(&admission_context);
        let admission = Arc::new(AdmissionControl::from_snapshot(
            snapshot.clone(),
            rotation,
            admission_identity,
        ));

        let network = if !config.peers.is_empty() {
            let peers = config
                .peers
                .iter()
                .filter_map(|p| {
                    p.address
                        .parse()
                        .ok()
                        .map(|addr| (p.validator_id.clone(), addr))
                })
                .collect();
            Arc::new(NodeNetwork::Quic(QuicNetwork::new(
                config.bind_addr.unwrap_or(default_bind()),
                peers,
                admission,
                config.validator_id.clone(),
                verifying_key_hex,
                Some(keypair.signing_key()),
            )?))
        } else {
            Arc::new(NodeNetwork::Mock(MockNetwork::new(NetworkLatency {
                min_ms: 20,
                max_ms: 80,
                jitter_ms: 20,
                packet_loss: 0.0,
            })))
        };

        let consensus = Arc::new(ConsensusEngine::new(
            config.validator_id.clone(),
            keypair,
            ConsensusConfig {
                block_time_millis: config.block_time_millis,
                max_entries_per_block: 1024,
                quorum_bps: config.quorum_bps,
                epoch_length_blocks: config.epoch_length_blocks,
                promotion_limit: config.promotion_limit,
                heartbeat_interval_millis: config.heartbeat_interval_millis,
                liveness_missed_prevote_threshold: config.liveness_missed_prevote_threshold,
            },
            network,
            ledger,
            txpool,
            snapshot,
        )?);

        Some(tokio::spawn(async move {
            if let Err(err) = consensus.run().await {
                tracing::error!(?err, "consensus error");
            }
        }))
    } else {
        if config.node_role == NodeRole::Validator && config.standby_only {
            tracing::info!(
                "mode" = "validator-standby",
                "msg" = "consensus disabled by standby_only configuration"
            );
            None
        } else {
            let observer_network_task = if !config.peers.is_empty() {
                let snapshot = config
                    .build_admission_snapshot(&config.observer_public_key(), &admission_context)?;
                let rotation = Duration::from_secs(config.network_key_rotation_secs);
                let admission_identity = config.handshake_identity(&admission_context);
                let admission = Arc::new(AdmissionControl::from_snapshot(
                    snapshot,
                    rotation,
                    admission_identity,
                ));
                let peers = config
                    .peers
                    .iter()
                    .filter_map(|p| {
                        p.address
                            .parse()
                            .ok()
                            .map(|addr| (p.validator_id.clone(), addr))
                    })
                    .collect();
                let network = Arc::new(NodeNetwork::Quic(QuicNetwork::new(
                    config.bind_addr.unwrap_or(default_bind()),
                    peers,
                    admission,
                    config.validator_id.clone(),
                    config.observer_public_key(),
                    None,
                )?));
                Some(tokio::spawn(async move {
                    match network.subscribe().await {
                        Ok(mut receiver) => while receiver.recv().await.is_some() {},
                        Err(err) => {
                            tracing::error!(?err, "observer failed to subscribe to network");
                        }
                    }
                }))
            } else {
                None
            };
            tracing::info!(
                "mode" = "observer",
                "msg" = "consensus disabled; read-only API profile active"
            );
            observer_network_task
        }
    };

    tracing::info!("msg" = "node running", "api_port" = config.api_port);

    signal::ctrl_c()
        .await
        .context("failed to listen for shutdown signal")?;
    tracing::info!("msg" = "shutdown signal received");

    if let Some(task) = consensus_task {
        task.abort();
    }
    api_handle.abort();

    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum CliDirective {
    Run { config_path: PathBuf },
    PrintHelp,
    PrintVersion,
}

fn parse_cli_args<I>(args: I) -> CliDirective
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter();
    let _ = args.next();
    match args.next().as_deref() {
        None => CliDirective::Run {
            config_path: PathBuf::from("node.toml"),
        },
        Some("-h") | Some("--help") | Some("help") => CliDirective::PrintHelp,
        Some("-V") | Some("--version") | Some("version") => CliDirective::PrintVersion,
        Some(config_path) => CliDirective::Run {
            config_path: PathBuf::from(config_path),
        },
    }
}

fn print_help() {
    println!(
        "citizen-node {version}\n\
Usage: citizen-node [CONFIG_PATH]\n\
\n\
Starts a CITIZEN node using CONFIG_PATH (default: node.toml).\n\
\n\
Options:\n\
  -h, --help       Show this help message\n\
  -V, --version    Show version",
        version = env!("CARGO_PKG_VERSION")
    );
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct NodeConfig {
    #[serde(default)]
    node_role: NodeRole,
    validator_id: ValidatorId,
    #[serde(default = "default_quorum")]
    quorum_bps: u32,
    #[serde(default = "default_block_time")]
    block_time_millis: u64,
    #[serde(default = "default_epoch_length")]
    epoch_length_blocks: u64,
    #[serde(default = "default_promotion_limit")]
    promotion_limit: usize,
    #[serde(default = "default_heartbeat_interval")]
    heartbeat_interval_millis: u64,
    #[serde(default = "default_liveness_threshold")]
    liveness_missed_prevote_threshold: u64,
    #[serde(default)]
    standby_only: bool,
    #[serde(default)]
    signing_key_hex: Option<String>,
    #[serde(default = "default_api_port")]
    api_port: u16,
    #[serde(default)]
    api_auth_required: bool,
    #[serde(default)]
    api_require_builder_credit_for_all_writes: bool,
    #[serde(default = "default_true")]
    api_local_finalize_mode: bool,
    #[serde(default = "default_api_write_rpm")]
    api_max_write_requests_per_minute: usize,
    #[serde(default)]
    api_clients: Vec<ApiClientConfig>,
    #[serde(default)]
    api_offchain_encrypted_files_v1_enabled: bool,
    #[serde(default)]
    api_offchain_minio: Option<ApiOffchainMinioConfig>,
    #[serde(default)]
    data_dir: Option<PathBuf>,
    #[serde(default)]
    bind_addr: Option<SocketAddr>,
    #[serde(default = "default_namespaces")]
    namespaces: Vec<NamespaceRuleset>,
    #[serde(default)]
    validators: Vec<ConfigValidator>,
    #[serde(default)]
    peers: Vec<PeerConfig>,
    #[serde(default = "default_rotation_secs")]
    network_key_rotation_secs: u64,
    #[serde(default = "default_network_id")]
    network_id: String,
    #[serde(default)]
    manifest_path: Option<PathBuf>,
    #[serde(default = "default_manifest_enforce")]
    manifest_enforce: bool,
    #[serde(default)]
    startup_secret: Option<String>,
    #[serde(default)]
    expected_genesis_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ConfigValidator {
    validator_id: ValidatorId,
    public_key: String,
    #[serde(default)]
    anchors: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PeerConfig {
    validator_id: ValidatorId,
    address: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ApiOffchainMinioConfig {
    endpoint: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    #[serde(default = "default_true")]
    use_tls: bool,
    #[serde(default = "default_true")]
    path_style: bool,
    #[serde(default = "default_minio_key_prefix")]
    key_prefix: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ApiClientConfig {
    api_key: String,
    #[serde(default)]
    scopes: Vec<String>,
}

impl NodeConfig {
    fn observer_public_key(&self) -> String {
        self.validators
            .iter()
            .find(|validator| validator.validator_id == self.validator_id)
            .map(|validator| validator.public_key.clone())
            .unwrap_or_else(|| "observer-readonly-key".to_string())
    }

    fn api_edge_config(&self) -> ApiEdgeConfig {
        let clients = self
            .api_clients
            .iter()
            .map(|client| {
                (
                    client.api_key.clone(),
                    ApiClientProfile::with_scopes(client.scopes.clone()),
                )
            })
            .collect();
        ApiEdgeConfig {
            write_enabled: self.node_role != NodeRole::Observer,
            auth_required: self.api_auth_required,
            max_write_requests_per_minute: self.api_max_write_requests_per_minute,
            offchain_encrypted_files_v1_enabled: self.api_offchain_encrypted_files_v1_enabled,
            require_builder_credit_for_all_writes: self.api_require_builder_credit_for_all_writes,
            local_finalize_mode: self.api_local_finalize_mode,
            clients,
        }
    }

    fn offchain_minio_config(&self) -> Option<MinioOffchainObjectStoreConfig> {
        self.api_offchain_minio
            .as_ref()
            .map(|cfg| MinioOffchainObjectStoreConfig {
                endpoint: cfg.endpoint.clone(),
                bucket: cfg.bucket.clone(),
                access_key: cfg.access_key.clone(),
                secret_key: cfg.secret_key.clone(),
                use_tls: cfg.use_tls,
                path_style: cfg.path_style,
                key_prefix: cfg.key_prefix.clone(),
            })
    }

    fn admission_settings(&self) -> AdmissionSettings {
        AdmissionSettings {
            network_id: self.network_id.clone(),
            manifest_path: self.manifest_path.clone(),
            manifest_enforce: self.manifest_enforce,
            startup_secret: self.startup_secret.clone(),
            expected_genesis_hash: self.expected_genesis_hash.clone(),
        }
    }

    fn handshake_identity(&self, context: &AdmissionContext) -> HandshakeIdentity {
        HandshakeIdentity {
            network_id: context.network_id.clone(),
            genesis_hash: context.genesis_hash.clone(),
            manifest_digest: context.manifest_digest.clone(),
            startup_secret: self.startup_secret.clone(),
            max_clock_skew: Duration::from_secs(30),
        }
    }

    fn load(path: &PathBuf) -> Option<Self> {
        let contents = fs::read_to_string(path).ok()?;
        toml::from_str(&contents).ok()
    }

    fn load_or_generate_keypair(&self) -> Result<ValidatorKeypair, ProtocolError> {
        if let Some(hex_secret) = &self.signing_key_hex {
            let bytes = hex::decode(hex_secret)
                .map_err(|err| ProtocolError::crypto(format!("invalid signing key hex: {err}")))?;
            ValidatorKeypair::from_secret_bytes(self.validator_id.clone(), &bytes)
        } else {
            Ok(ValidatorKeypair::generate(self.validator_id.clone()))
        }
    }

    fn build_validator_set(&self, self_public_key: &str) -> ValidatorSetSnapshot {
        let mut validators: BTreeMap<ValidatorId, ValidatorMetadata> = BTreeMap::new();
        for config in &self.validators {
            validators.insert(
                config.validator_id.clone(),
                ValidatorMetadata {
                    validator_id: config.validator_id.clone(),
                    public_key: config.public_key.clone(),
                    anchors: config.anchors.clone(),
                    joined_at: Utc::now(),
                    status: ValidatorStatus::Active,
                    performance: ValidatorPerformance {
                        uptime_bps: 10_000,
                        missed_prevotes: 0,
                    },
                },
            );
        }
        validators.insert(
            self.validator_id.clone(),
            ValidatorMetadata {
                validator_id: self.validator_id.clone(),
                public_key: self_public_key.to_string(),
                anchors: vec!["self-configured".into()],
                joined_at: Utc::now(),
                status: ValidatorStatus::Active,
                performance: ValidatorPerformance {
                    uptime_bps: 10_000,
                    missed_prevotes: 0,
                },
            },
        );
        let active_size = validators.len().div_ceil(2);
        for (index, metadata) in validators.values_mut().enumerate() {
            metadata.status = if index < active_size {
                ValidatorStatus::Active
            } else {
                ValidatorStatus::Standby
            };
        }
        ValidatorSetSnapshot {
            height: 0,
            validators,
            quorum_bps: self.quorum_bps,
            epoch_state: EpochState {
                epoch: 0,
                epoch_length_blocks: self.epoch_length_blocks,
                promotion_limit: self.promotion_limit,
                pending_replacements: Vec::new(),
                scheduled_rotation: None,
                manifest_digest: "manifest-not-enforced".into(),
                last_seed: "genesis".into(),
            },
        }
    }

    fn build_admission_snapshot(
        &self,
        self_public_key: &str,
        admission_context: &AdmissionContext,
    ) -> anyhow::Result<ValidatorSetSnapshot> {
        if admission_context.validator_allowlist.is_empty() {
            return Ok(self.build_validator_set(self_public_key));
        }

        let Some(allowlisted_public_key) = admission_context
            .validator_allowlist
            .get(&self.validator_id)
        else {
            anyhow::bail!(
                "local validator_id is not present in signed manifest allowlist: {}",
                self.validator_id
            );
        };
        if allowlisted_public_key != self_public_key {
            anyhow::bail!(
                "local public key does not match signed manifest allowlist for {}",
                self.validator_id
            );
        }

        let active_size = admission_context.validator_allowlist.len().div_ceil(2);
        let validators = admission_context
            .validator_allowlist
            .iter()
            .enumerate()
            .map(|(index, (validator_id, public_key))| {
                (
                    validator_id.clone(),
                    ValidatorMetadata {
                        validator_id: validator_id.clone(),
                        public_key: public_key.clone(),
                        anchors: vec!["manifest-allowlist".to_string()],
                        joined_at: Utc::now(),
                        status: if index < active_size {
                            ValidatorStatus::Active
                        } else {
                            ValidatorStatus::Standby
                        },
                        performance: ValidatorPerformance {
                            uptime_bps: 10_000,
                            missed_prevotes: 0,
                        },
                    },
                )
            })
            .collect();

        Ok(ValidatorSetSnapshot {
            height: 0,
            validators,
            quorum_bps: self.quorum_bps,
            epoch_state: EpochState {
                epoch: 0,
                epoch_length_blocks: self.epoch_length_blocks,
                promotion_limit: self.promotion_limit,
                pending_replacements: Vec::new(),
                scheduled_rotation: None,
                manifest_digest: admission_context.manifest_digest.clone(),
                last_seed: admission_context.manifest_digest.clone(),
            },
        })
    }
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            node_role: NodeRole::default(),
            validator_id: "validator.local".into(),
            quorum_bps: default_quorum(),
            block_time_millis: default_block_time(),
            epoch_length_blocks: default_epoch_length(),
            promotion_limit: default_promotion_limit(),
            heartbeat_interval_millis: default_heartbeat_interval(),
            liveness_missed_prevote_threshold: default_liveness_threshold(),
            standby_only: false,
            signing_key_hex: None,
            api_port: default_api_port(),
            api_auth_required: false,
            api_require_builder_credit_for_all_writes: false,
            api_local_finalize_mode: true,
            api_max_write_requests_per_minute: default_api_write_rpm(),
            api_clients: Vec::new(),
            api_offchain_encrypted_files_v1_enabled: false,
            api_offchain_minio: None,
            data_dir: Some(PathBuf::from("data")),
            bind_addr: Some(default_bind()),
            namespaces: default_namespaces(),
            validators: Vec::new(),
            peers: Vec::new(),
            network_key_rotation_secs: default_rotation_secs(),
            network_id: default_network_id(),
            manifest_path: None,
            manifest_enforce: default_manifest_enforce(),
            startup_secret: None,
            expected_genesis_hash: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum NodeRole {
    #[default]
    Validator,
    Observer,
}

fn default_quorum() -> u32 {
    8_000
}

fn default_block_time() -> u64 {
    1_000
}

fn default_epoch_length() -> u64 {
    100
}

fn default_promotion_limit() -> usize {
    10
}

fn default_heartbeat_interval() -> u64 {
    500
}

fn default_liveness_threshold() -> u64 {
    3
}

fn default_api_write_rpm() -> usize {
    120
}

fn default_true() -> bool {
    true
}

fn default_minio_key_prefix() -> String {
    "citizen/offchain-encrypted-files/v1".to_string()
}

fn default_api_port() -> u16 {
    8080
}

fn default_rotation_secs() -> u64 {
    3600
}

fn default_namespaces() -> Vec<NamespaceRuleset> {
    vec![
        NamespaceRuleset {
            descriptor: citizen_types::NamespaceDescriptor {
                namespace: "identity.citizen".into(),
                version: 1,
                rules_hash: "sha256:identity-default-v1".into(),
                governed_by: "governance.vote".into(),
            },
            writers: BTreeSet::from(["registry.identity".into()]),
            validators: vec![citizen_types::NamespaceRule {
                name: "require_signature".into(),
                config: json!({}),
            }],
        },
        NamespaceRuleset {
            descriptor: citizen_types::NamespaceDescriptor {
                namespace: "registry.land".into(),
                version: 1,
                rules_hash: "sha256:land-default-v1".into(),
                governed_by: "governance.vote".into(),
            },
            writers: BTreeSet::from(["registry.land".into()]),
            validators: vec![
                citizen_types::NamespaceRule {
                    name: "require_signature".into(),
                    config: json!({}),
                },
                citizen_types::NamespaceRule {
                    name: "prevent_double_transfer".into(),
                    config: json!({"object_id": "object_id"}),
                },
            ],
        },
        NamespaceRuleset {
            descriptor: citizen_types::NamespaceDescriptor {
                namespace: "audit.procurement".into(),
                version: 1,
                rules_hash: "sha256:audit-default-v1".into(),
                governed_by: "governance.vote".into(),
            },
            writers: BTreeSet::from(["audit.procurement".into()]),
            validators: vec![citizen_types::NamespaceRule {
                name: "require_signature".into(),
                config: json!({}),
            }],
        },
        NamespaceRuleset {
            descriptor: citizen_types::NamespaceDescriptor {
                namespace: "governance.vote".into(),
                version: 1,
                rules_hash: "sha256:governance-default-v1".into(),
                governed_by: "governance.vote".into(),
            },
            writers: BTreeSet::from(["governance.vote".into()]),
            validators: vec![citizen_types::NamespaceRule {
                name: "require_signature".into(),
                config: json!({}),
            }],
        },
        NamespaceRuleset {
            descriptor: citizen_types::NamespaceDescriptor {
                namespace: "forms.commitment".into(),
                version: 1,
                rules_hash: "sha256:forms-commitment-default-v1".into(),
                governed_by: "governance.vote".into(),
            },
            writers: BTreeSet::from(["forms.commitment".into()]),
            validators: vec![
                citizen_types::NamespaceRule {
                    name: "require_signature".into(),
                    config: json!({}),
                },
                citizen_types::NamespaceRule {
                    name: "require_payload_fields".into(),
                    config: json!({
                        "fields": ["data_hash", "encrypted_form_url", "payload_wallet_signature.signer"],
                    }),
                },
            ],
        },
        NamespaceRuleset {
            descriptor: citizen_types::NamespaceDescriptor {
                namespace: "builder.credits".into(),
                version: 1,
                rules_hash: "sha256:builder-credits-default-v1".into(),
                governed_by: "governance.vote".into(),
            },
            writers: BTreeSet::from(["builder.credits".into()]),
            validators: vec![
                citizen_types::NamespaceRule {
                    name: "require_signature".into(),
                    config: json!({}),
                },
                citizen_types::NamespaceRule {
                    name: "builder_credit_policy".into(),
                    config: json!({
                        "required_grant_approvals": 3,
                        "max_daily_spend": 5000,
                        "grant_approvers": [
                            {"id": "grant:ops-1", "public_key": "a28000878f6ad2d87478d4e217c042375d6254a52de30eda7ccb1e6063cdc9f8"},
                            {"id": "grant:ops-2", "public_key": "ce7b9bd48eb28da70be46149b4c390bfdbf063ee57d0c1c3d8671f043261275f"},
                            {"id": "grant:ops-3", "public_key": "33f916e23f89cafc8eb1cacaffbcc9fec622974b27383ed2491c7573427856bc"},
                            {"id": "grant:ops-4", "public_key": "8900579255c892112d9128bee22b01c2e96c6dd8942e80157ecddfd14982c1f2"},
                            {"id": "grant:ops-5", "public_key": "4c35b96dec331f6a59b4342559ad5d1bed7fdcb1eada43e10d0d79cfafc99811"}
                        ],
                        "programmable_multisig": {
                            "enabled": false,
                            "policy_id": "builder-credits-auto-v1",
                            "actors": ["automation.builder-credit-bot"],
                            "max_grant_amount": 1000
                        }
                    }),
                },
            ],
        },
        NamespaceRuleset {
            descriptor: citizen_types::NamespaceDescriptor {
                namespace: "execution.module".into(),
                version: 1,
                rules_hash: "sha256:execution-module-default-v1".into(),
                governed_by: "governance.vote".into(),
            },
            writers: BTreeSet::from(["execution.module".into()]),
            validators: vec![
                citizen_types::NamespaceRule {
                    name: "require_signature".into(),
                    config: json!({}),
                },
                citizen_types::NamespaceRule {
                    name: "wasm_runtime_policy".into(),
                    config: json!({
                        "allowed_module_classes": ["deterministic-indexer", "policy-guard", "receipt-verifier"],
                        "required_governance_approvals": 3
                    }),
                },
            ],
        },
    ]
}

fn default_network_id() -> String {
    "citizen-localnet".to_string()
}

fn default_manifest_enforce() -> bool {
    true
}

fn default_bind() -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, 9000))
}

enum NodeNetwork {
    Mock(MockNetwork),
    Quic(QuicNetwork),
}

#[async_trait::async_trait]
impl Network for NodeNetwork {
    async fn broadcast(&self, message: ConsensusMessage) -> Result<(), ProtocolError> {
        match self {
            NodeNetwork::Mock(inner) => inner.broadcast(message).await,
            NodeNetwork::Quic(inner) => inner.broadcast(message).await,
        }
    }

    async fn unicast(
        &self,
        target: &ValidatorId,
        message: ConsensusMessage,
    ) -> Result<(), ProtocolError> {
        match self {
            NodeNetwork::Mock(inner) => inner.unicast(target, message).await,
            NodeNetwork::Quic(inner) => inner.unicast(target, message).await,
        }
    }

    async fn subscribe(
        &self,
    ) -> Result<tokio::sync::mpsc::Receiver<ConsensusMessage>, ProtocolError> {
        match self {
            NodeNetwork::Mock(inner) => inner.subscribe().await,
            NodeNetwork::Quic(inner) => inner.subscribe().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admission::AdmissionError;
    use citizen_storage::MemoryStorage;

    #[test]
    fn observer_public_key_prefers_configured_validator_key() {
        let config = NodeConfig {
            validator_id: "observer-1".to_string(),
            validators: vec![ConfigValidator {
                validator_id: "observer-1".to_string(),
                public_key: "observer-public-key".to_string(),
                anchors: vec![],
            }],
            ..NodeConfig::default()
        };

        assert_eq!(config.observer_public_key(), "observer-public-key");
    }

    #[test]
    fn observer_public_key_falls_back_when_missing_from_validator_set() {
        let config = NodeConfig {
            validator_id: "observer-2".to_string(),
            validators: vec![ConfigValidator {
                validator_id: "validator-1".to_string(),
                public_key: "validator-public-key".to_string(),
                anchors: vec![],
            }],
            ..NodeConfig::default()
        };

        assert_eq!(config.observer_public_key(), "observer-readonly-key");
    }

    #[test]
    fn handshake_identity_is_role_agnostic() {
        let context = AdmissionContext {
            network_id: "citizen-localnet".to_string(),
            genesis_hash: "genesis-hash".to_string(),
            manifest_digest: "manifest-digest".to_string(),
            manifest_version: Some(3),
            validator_allowlist: BTreeMap::new(),
        };

        let validator_config = NodeConfig {
            node_role: NodeRole::Validator,
            startup_secret: Some("validator-shared-secret".to_string()),
            ..NodeConfig::default()
        };
        let observer_config = NodeConfig {
            node_role: NodeRole::Observer,
            startup_secret: Some("validator-shared-secret".to_string()),
            ..NodeConfig::default()
        };

        assert_eq!(
            validator_config.handshake_identity(&context),
            observer_config.handshake_identity(&context)
        );
    }

    #[test]
    fn startup_preflight_runtime_policy_is_role_agnostic() {
        let storage = MemoryStorage::new();

        let validator_config = NodeConfig {
            node_role: NodeRole::Validator,
            network_id: "citizen-othernet".to_string(),
            manifest_enforce: false,
            startup_secret: Some("role-agnostic-startup-secret".to_string()),
            ..NodeConfig::default()
        };
        let observer_config = NodeConfig {
            node_role: NodeRole::Observer,
            network_id: "citizen-othernet".to_string(),
            manifest_enforce: false,
            startup_secret: Some("role-agnostic-startup-secret".to_string()),
            ..NodeConfig::default()
        };

        let validator_result = run_preflight(&validator_config.admission_settings(), &storage);
        let observer_result = run_preflight(&observer_config.admission_settings(), &storage);

        if crate::admission::runtime_identity::RUNTIME_NETWORK_ID.is_some() {
            assert!(matches!(
                validator_result,
                Err(AdmissionError::RuntimeNetworkMismatch { .. })
            ));
            assert!(matches!(
                observer_result,
                Err(AdmissionError::RuntimeNetworkMismatch { .. })
            ));
        } else {
            assert!(validator_result.is_ok());
            assert!(observer_result.is_ok());
        }
    }

    #[test]
    fn admission_snapshot_uses_manifest_allowlist_when_present() {
        let config = NodeConfig {
            validator_id: "validator-alpha".to_string(),
            quorum_bps: 8_000,
            ..NodeConfig::default()
        };
        let mut allowlist = BTreeMap::new();
        allowlist.insert("validator-alpha".to_string(), "alpha-pubkey".to_string());
        allowlist.insert("validator-beta".to_string(), "beta-pubkey".to_string());
        let context = AdmissionContext {
            network_id: "citizen-localnet".to_string(),
            genesis_hash: "genesis-hash".to_string(),
            manifest_digest: "manifest-digest".to_string(),
            manifest_version: Some(3),
            validator_allowlist: allowlist,
        };

        let snapshot = config
            .build_admission_snapshot("alpha-pubkey", &context)
            .expect("manifest allowlist should be used");
        assert_eq!(snapshot.validators.len(), 2);
        assert_eq!(
            snapshot
                .validators
                .get("validator-beta")
                .expect("beta should exist")
                .public_key,
            "beta-pubkey"
        );
    }

    #[test]
    fn admission_snapshot_rejects_local_key_mismatch_against_manifest_allowlist() {
        let config = NodeConfig {
            validator_id: "validator-alpha".to_string(),
            ..NodeConfig::default()
        };
        let mut allowlist = BTreeMap::new();
        allowlist.insert("validator-alpha".to_string(), "alpha-pubkey".to_string());
        let context = AdmissionContext {
            network_id: "citizen-localnet".to_string(),
            genesis_hash: "genesis-hash".to_string(),
            manifest_digest: "manifest-digest".to_string(),
            manifest_version: Some(3),
            validator_allowlist: allowlist,
        };

        let result = config.build_admission_snapshot("different-pubkey", &context);
        assert!(result.is_err());
    }

    #[test]
    fn default_config_bootstraps_canonical_namespaces() {
        let config = NodeConfig::default();

        assert!(config
            .namespaces
            .iter()
            .any(|ruleset| ruleset.descriptor.namespace == "builder.credits"));
        assert!(config
            .namespaces
            .iter()
            .any(|ruleset| ruleset.descriptor.namespace == "forms.commitment"));
        assert!(config
            .namespaces
            .iter()
            .any(|ruleset| ruleset.descriptor.namespace == "execution.module"));
    }

    #[test]
    fn deserialization_uses_default_namespaces_when_omitted() {
        let config: NodeConfig = toml::from_str(
            r#"validator_id = "validator.local"
api_port = 9001"#,
        )
        .expect("config should deserialize");

        assert!(!config.namespaces.is_empty());
    }

    #[test]
    fn parse_cli_args_defaults_to_node_toml() {
        let directive = parse_cli_args(vec!["citizen-node".to_string()]);

        assert_eq!(
            directive,
            CliDirective::Run {
                config_path: PathBuf::from("node.toml")
            }
        );
    }

    #[test]
    fn parse_cli_args_handles_help_flags() {
        assert_eq!(
            parse_cli_args(vec!["citizen-node".to_string(), "--help".to_string()]),
            CliDirective::PrintHelp
        );
        assert_eq!(
            parse_cli_args(vec!["citizen-node".to_string(), "-h".to_string()]),
            CliDirective::PrintHelp
        );
    }

    #[test]
    fn parse_cli_args_treats_non_flag_as_config_path() {
        let directive = parse_cli_args(vec![
            "citizen-node".to_string(),
            "config/testnet/validator.toml".to_string(),
        ]);

        assert_eq!(
            directive,
            CliDirective::Run {
                config_path: PathBuf::from("config/testnet/validator.toml")
            }
        );
    }
}
