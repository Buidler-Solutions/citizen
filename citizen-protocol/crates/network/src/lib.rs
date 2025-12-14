use async_trait::async_trait;
use citizen_types::{
    Block, BlockHeader, GovernanceProposal, GovernanceVote, LedgerEntry, ProtocolError, ValidatorId,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio::time::{sleep, Duration};
use tracing::{debug, warn};

pub type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ConsensusMessage {
    Propose(BlockProposal),
    PreVote {
        height: u64,
        validator: ValidatorId,
        hash: String,
        signature: String,
    },
    Commit {
        height: u64,
        block: Block,
    },
    GovernanceProposal(GovernanceProposal),
    GovernanceVote(GovernanceVote),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockProposal {
    pub header: BlockHeader,
    pub entries: Vec<LedgerEntry>,
    pub round: u64,
}

#[async_trait]
pub trait Network: Send + Sync {
    async fn broadcast(&self, message: ConsensusMessage) -> Result<()>;
    async fn unicast(&self, target: &ValidatorId, message: ConsensusMessage) -> Result<()>;
    async fn subscribe(&self) -> Result<mpsc::Receiver<ConsensusMessage>>;
}

#[derive(Clone)]
pub struct MockNetwork {
    latency: NetworkLatency,
    peers: Arc<RwLock<HashMap<ValidatorId, mpsc::Sender<ConsensusMessage>>>>,
    broadcaster: broadcast::Sender<ConsensusMessage>,
}

#[derive(Clone, Copy, Debug)]
pub struct NetworkLatency {
    pub min_ms: u64,
    pub max_ms: u64,
    pub jitter_ms: u64,
    pub packet_loss: f64,
}

impl NetworkLatency {
    fn sample_delay(&self) -> Duration {
        let mut rng = rand::thread_rng();
        let base = rng.gen_range(self.min_ms..=self.max_ms);
        let jitter = rng.gen_range(0..=self.jitter_ms);
        Duration::from_millis(base + jitter)
    }

    fn drop_packet(&self) -> bool {
        let mut rng = rand::thread_rng();
        rng.gen_bool(self.packet_loss)
    }
}

impl MockNetwork {
    pub fn new(latency: NetworkLatency) -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            latency,
            peers: Arc::new(RwLock::new(HashMap::new())),
            broadcaster: tx,
        }
    }

    pub async fn register(
        &self,
        validator: ValidatorId,
    ) -> Result<mpsc::Receiver<ConsensusMessage>> {
        let (tx, rx) = mpsc::channel(256);
        self.peers.write().await.insert(validator, tx);
        Ok(rx)
    }

    async fn deliver(&self, message: ConsensusMessage) -> Result<()> {
        if self.latency.drop_packet() {
            warn!("network dropping packet");
            return Ok(());
        }
        let delay = self.latency.sample_delay();
        sleep(delay).await;
        let _ = self.broadcaster.send(message);
        Ok(())
    }
}

#[async_trait]
impl Network for MockNetwork {
    async fn broadcast(&self, message: ConsensusMessage) -> Result<()> {
        self.deliver(message).await
    }

    async fn unicast(&self, target: &ValidatorId, message: ConsensusMessage) -> Result<()> {
        if self.latency.drop_packet() {
            warn!(target, "network dropping unicast packet");
            return Ok(());
        }
        let delay = self.latency.sample_delay();
        sleep(delay).await;
        if let Some(peer) = self.peers.read().await.get(target) {
            peer.send(message).await.map_err(|err| {
                ProtocolError::ConsensusViolation(format!("failed to unicast to {target}: {err}"))
            })?;
        }
        Ok(())
    }

    async fn subscribe(&self) -> Result<mpsc::Receiver<ConsensusMessage>> {
        let mut rx = self.broadcaster.subscribe();
        let (tx, client_rx) = mpsc::channel(256);
        tokio::spawn(async move {
            while let Ok(message) = rx.recv().await {
                if tx.send(message).await.is_err() {
                    break;
                }
            }
        });
        Ok(client_rx)
    }
}
