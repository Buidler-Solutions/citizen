use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use chrono::Utc;
use citizen_api::ApiServer;
use citizen_consensus::ConsensusEngine;
use citizen_crypto::{verifying_key_to_string, KeyRegistry, ValidatorKeypair};
use citizen_ledger::Ledger;
use citizen_network::{MockNetwork, Network, NetworkLatency, QuicNetwork};
use citizen_storage::RocksDbStorage;
use citizen_types::{
    ConsensusConfig, NamespaceRuleset, ProtocolError, ValidatorId, ValidatorMetadata,
    ValidatorSetSnapshot,
};
use serde::{Deserialize, Serialize};
use tokio::signal;
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

    let keypair = config.load_or_generate_keypair()?;
    let verifying_key_hex = verifying_key_to_string(keypair.verifying_key());
    tracing::info!("verifying_key" = %verifying_key_hex, "note" = "share this key for validator admission");

    let storage_path = config
        .data_dir
        .clone()
        .unwrap_or_else(|| PathBuf::from("data"));
    let storage = Arc::new(RocksDbStorage::open(storage_path)?);
    let key_registry = KeyRegistry::new();
    let ledger = Arc::new(Ledger::new(storage.clone(), key_registry));
    ledger.bootstrap_namespaces(config.namespaces.clone());

    let snapshot = config.build_validator_set(&verifying_key_hex);

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
        network.clone(),
        ledger.clone(),
        snapshot,
    )?);

    let api_server = ApiServer::new(ledger.clone());
    let api_handle = api_server
        .serve(SocketAddr::from((Ipv4Addr::LOCALHOST, config.api_port)))
        .await;

    let consensus_task = {
        let engine = consensus.clone();
        tokio::spawn(async move {
            if let Err(err) = engine.run().await {
                tracing::error!(?err, "consensus error");
            }
        })
    };

    tracing::info!("msg" = "node running", "api_port" = config.api_port);

    signal::ctrl_c()
        .await
        .context("failed to listen for shutdown signal")?;
    tracing::info!("msg" = "shutdown signal received");

    consensus_task.abort();
    api_handle.abort();

    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct NodeConfig {
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
    data_dir: Option<PathBuf>,
    #[serde(default)]
    bind_addr: Option<SocketAddr>,
    #[serde(default)]
    namespaces: Vec<NamespaceRuleset>,
    #[serde(default)]
    validators: Vec<ConfigValidator>,
    #[serde(default)]
    peers: Vec<PeerConfig>,
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

impl NodeConfig {
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
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            validator_id: "validator.local".into(),
            quorum_bps: default_quorum(),
            block_time_millis: default_block_time(),
            signing_key_hex: None,
            api_port: default_api_port(),
            data_dir: Some(PathBuf::from("data")),
            bind_addr: Some(default_bind()),
            namespaces: Vec::new(),
            validators: Vec::new(),
            peers: Vec::new(),
        }
    }
}

fn default_quorum() -> u32 {
    8_000
}

fn default_block_time() -> u64 {
    1_000
}

fn default_api_port() -> u16 {
    8080
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
    async fn broadcast(
        &self,
        message: citizen_types::ConsensusMessage,
    ) -> Result<(), ProtocolError> {
        match self {
            NodeNetwork::Mock(inner) => inner.broadcast(message).await,
            NodeNetwork::Quic(inner) => inner.broadcast(message).await,
        }
    }

    async fn unicast(
        &self,
        target: &ValidatorId,
        message: citizen_types::ConsensusMessage,
    ) -> Result<(), ProtocolError> {
        match self {
            NodeNetwork::Mock(inner) => inner.unicast(target, message).await,
            NodeNetwork::Quic(inner) => inner.unicast(target, message).await,
        }
    }

    async fn subscribe(
        &self,
    ) -> Result<tokio::sync::mpsc::Receiver<citizen_types::ConsensusMessage>, ProtocolError> {
        match self {
            NodeNetwork::Mock(inner) => inner.subscribe().await,
            NodeNetwork::Quic(inner) => inner.subscribe().await,
        }
    }
}
