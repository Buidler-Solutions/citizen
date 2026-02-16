mod admission;

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use chrono::Utc;
use citizen_api::{ApiClientProfile, ApiEdgeConfig, ApiServer};
use citizen_consensus::ConsensusEngine;
use citizen_crypto::{verifying_key_to_string, KeyRegistry, ValidatorKeypair};
use citizen_ledger::Ledger;
use citizen_network::{
    AdmissionControl, ConsensusMessage, HandshakeIdentity, MockNetwork, Network, NetworkLatency,
    QuicNetwork,
};
use citizen_storage::RocksDbStorage;
use citizen_types::{
    ConsensusConfig, NamespaceRuleset, ProtocolError, ValidatorId, ValidatorMetadata,
    ValidatorSetSnapshot,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::signal;

use admission::{startup::run_preflight, AdmissionContext, AdmissionError, AdmissionSettings};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .init();

    let config_path = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node.toml"));
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

    let api_server = ApiServer::with_edge_config(ledger.clone(), config.api_edge_config());
    let api_handle = api_server
        .serve(SocketAddr::from((Ipv4Addr::LOCALHOST, config.api_port)))
        .await;

    let consensus_task = if config.node_role == NodeRole::Validator {
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
            },
            network,
            ledger,
            snapshot,
        )?);

        Some(tokio::spawn(async move {
            if let Err(err) = consensus.run().await {
                tracing::error!(?err, "consensus error");
            }
        }))
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

#[derive(Clone, Debug, Serialize, Deserialize)]
struct NodeConfig {
    #[serde(default)]
    node_role: NodeRole,
    validator_id: ValidatorId,
    #[serde(default = "default_quorum")]
    quorum_bps: u32,
    #[serde(default = "default_block_time")]
    block_time_millis: u64,
    #[serde(default)]
    signing_key_hex: Option<String>,
    #[serde(default = "default_api_port")]
    api_port: u16,
    #[serde(default)]
    api_auth_required: bool,
    #[serde(default = "default_api_write_rpm")]
    api_max_write_requests_per_minute: usize,
    #[serde(default)]
    api_clients: Vec<ApiClientConfig>,
    #[serde(default)]
    data_dir: Option<PathBuf>,
    #[serde(default)]
    bind_addr: Option<SocketAddr>,
    #[serde(default)]
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
            clients,
        }
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
                    suspended: false,
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
                suspended: false,
            },
        );
        ValidatorSetSnapshot {
            height: 0,
            validators,
            quorum_bps: self.quorum_bps,
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

        let validators = admission_context
            .validator_allowlist
            .iter()
            .map(|(validator_id, public_key)| {
                (
                    validator_id.clone(),
                    ValidatorMetadata {
                        validator_id: validator_id.clone(),
                        public_key: public_key.clone(),
                        anchors: vec!["manifest-allowlist".to_string()],
                        joined_at: Utc::now(),
                        suspended: false,
                    },
                )
            })
            .collect();

        Ok(ValidatorSetSnapshot {
            height: 0,
            validators,
            quorum_bps: self.quorum_bps,
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
            signing_key_hex: None,
            api_port: default_api_port(),
            api_auth_required: false,
            api_max_write_requests_per_minute: default_api_write_rpm(),
            api_clients: Vec::new(),
            data_dir: Some(PathBuf::from("data")),
            bind_addr: Some(default_bind()),
            namespaces: Vec::new(),
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

fn default_api_write_rpm() -> usize {
    120
}

fn default_api_port() -> u16 {
    8080
}

fn default_rotation_secs() -> u64 {
    3600
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
    fn startup_preflight_rejects_network_mismatch_for_validator_and_observer() {
        let storage = MemoryStorage::new();

        let validator_config = NodeConfig {
            node_role: NodeRole::Validator,
            network_id: "citizen-othernet".to_string(),
            ..NodeConfig::default()
        };
        let observer_config = NodeConfig {
            node_role: NodeRole::Observer,
            network_id: "citizen-othernet".to_string(),
            ..NodeConfig::default()
        };

        let validator_result = run_preflight(&validator_config.admission_settings(), &storage);
        let observer_result = run_preflight(&observer_config.admission_settings(), &storage);

        assert!(matches!(
            validator_result,
            Err(AdmissionError::RuntimeNetworkMismatch { .. })
        ));
        assert!(matches!(
            observer_result,
            Err(AdmissionError::RuntimeNetworkMismatch { .. })
        ));
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
}
