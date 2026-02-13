use async_trait::async_trait;
use citizen_types::{
    Block, BlockHeader, GovernanceProposal, GovernanceVote, LedgerEntry, ProtocolError,
    ValidatorId, ValidatorSetSnapshot,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant};
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio::time::{sleep, Duration};
#[cfg(feature = "libp2p")]
use tracing::info;
use tracing::warn;

#[cfg(feature = "libp2p")]
use blake3;
#[cfg(feature = "libp2p")]
use futures::StreamExt;
#[cfg(feature = "libp2p")]
use libp2p::{
    gossipsub::{self, MessageId, TopicHash},
    identity,
    swarm::SwarmEvent,
    PeerId, Swarm,
};
use quinn::{ClientConfig, Endpoint, RecvStream, SendStream, ServerConfig};
use rcgen::generate_simple_self_signed;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::RootCertStore;

pub type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PeerHandshake {
    pub validator_id: ValidatorId,
    pub public_key: String,
    pub key_epoch: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WireMessage {
    handshake: PeerHandshake,
    message: ConsensusMessage,
}

#[derive(Clone)]
pub struct AdmissionControl {
    allowed: Arc<RwLock<HashMap<ValidatorId, String>>>,
    rotation_interval: StdDuration,
    current_epoch: Arc<RwLock<u64>>,
    last_rotation: Arc<RwLock<Instant>>,
}

impl AdmissionControl {
    pub fn from_snapshot(snapshot: ValidatorSetSnapshot, rotation_interval: StdDuration) -> Self {
        let allowed = snapshot
            .validators
            .iter()
            .map(|(id, meta)| (id.clone(), meta.public_key.clone()))
            .collect();
        Self::new_with_allowlist(allowed, rotation_interval)
    }

    pub fn new_with_allowlist(
        allowed: HashMap<ValidatorId, String>,
        rotation_interval: StdDuration,
    ) -> Self {
        Self {
            allowed: Arc::new(RwLock::new(allowed)),
            rotation_interval,
            current_epoch: Arc::new(RwLock::new(0)),
            last_rotation: Arc::new(RwLock::new(Instant::now())),
        }
    }

    pub async fn update_snapshot(&self, snapshot: ValidatorSetSnapshot) {
        let mut allowed = self.allowed.write().await;
        allowed.clear();
        allowed.extend(
            snapshot
                .validators
                .iter()
                .map(|(id, meta)| (id.clone(), meta.public_key.clone())),
        );
    }

    pub async fn allows(&self, handshake: &PeerHandshake) -> bool {
        let allowed = self.allowed.read().await;
        let Some(expected_key) = allowed.get(&handshake.validator_id) else {
            return false;
        };
        if expected_key != &handshake.public_key {
            return false;
        }

        let epoch = self.current_epoch.read().await;
        handshake.key_epoch >= *epoch
    }

    pub async fn maybe_rotate(&self) -> u64 {
        let mut epoch = self.current_epoch.write().await;
        let mut last_rotation = self.last_rotation.write().await;
        if last_rotation.elapsed() >= self.rotation_interval {
            *epoch += 1;
            *last_rotation = Instant::now();
        }
        *epoch
    }

    pub async fn current_epoch(&self) -> u64 {
        *self.current_epoch.read().await
    }
}

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

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct MessageCounters {
    pub broadcasts: u64,
    pub unicasts: u64,
    pub dropped: u64,
}

#[derive(Default)]
pub struct NetworkMetrics {
    counters: parking_lot::Mutex<MessageCounters>,
    latencies_ms: parking_lot::RwLock<Vec<u64>>,
}

impl NetworkMetrics {
    pub fn record_delay(&self, delay: Duration, dropped: bool, is_unicast: bool) {
        let mut counters = self.counters.lock();
        if dropped {
            counters.dropped += 1;
            return;
        }
        if is_unicast {
            counters.unicasts += 1;
        } else {
            counters.broadcasts += 1;
        }
        self.latencies_ms
            .write()
            .push(delay.as_millis().min(u128::from(u64::MAX)) as u64);
    }

    pub fn snapshot(&self) -> (MessageCounters, Vec<u64>) {
        (
            self.counters.lock().clone(),
            self.latencies_ms.read().clone(),
        )
    }
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
    metrics: Arc<NetworkMetrics>,
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
            metrics: Arc::new(NetworkMetrics::default()),
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
        let dropped = self.latency.drop_packet();
        let delay = self.latency.sample_delay();
        sleep(delay).await;
        if !dropped {
            let _ = self.broadcaster.send(message);
        } else {
            warn!("network dropping packet");
        }
        self.metrics.record_delay(delay, dropped, false);
        Ok(())
    }

    pub fn metrics(&self) -> Arc<NetworkMetrics> {
        self.metrics.clone()
    }
}

#[async_trait]
impl Network for MockNetwork {
    async fn broadcast(&self, message: ConsensusMessage) -> Result<()> {
        self.deliver(message).await
    }

    async fn unicast(&self, target: &ValidatorId, message: ConsensusMessage) -> Result<()> {
        let dropped = self.latency.drop_packet();
        let delay = self.latency.sample_delay();
        sleep(delay).await;
        if !dropped {
            if let Some(peer) = self.peers.read().await.get(target) {
                peer.send(message).await.map_err(|err| {
                    ProtocolError::ConsensusViolation(format!(
                        "failed to unicast to {target}: {err}"
                    ))
                })?;
            }
        } else {
            warn!(target, "network dropping unicast packet");
        }
        self.metrics.record_delay(delay, dropped, true);
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

#[cfg(feature = "libp2p")]
#[derive(Clone)]
pub struct Libp2pNetwork {
    swarm: Arc<tokio::sync::Mutex<Swarm<gossipsub::Behaviour>>>,
    topic: gossipsub::IdentTopic,
    subscribers: Arc<RwLock<Vec<mpsc::Sender<ConsensusMessage>>>>,
    validators: Arc<RwLock<HashMap<ValidatorId, PeerId>>>,
}

#[cfg(feature = "libp2p")]
impl Libp2pNetwork {
    pub async fn new(listen_addr: SocketAddr, validator_id: ValidatorId) -> Result<Self> {
        let local_key = identity::Keypair::generate_ed25519();
        let local_peer_id = PeerId::from(local_key.public());
        info!(%validator_id, %local_peer_id, "libp2p peer initialized");

        let mut gossipsub_config = gossipsub::ConfigBuilder::default()
            .message_id_fn(|message: &gossipsub::Message| {
                MessageId::from(blake3::hash(&message.data).to_hex().to_string())
            })
            .validate_messages()
            .validation_mode(gossipsub::ValidationMode::Strict)
            .build()
            .map_err(ProtocolError::storage)?;
        gossipsub_config.max_transmit_size = 1024 * 1024;

        let auth_keys = gossipsub::MessageAuthenticity::Signed(local_key.clone());
        let mut behaviour = gossipsub::Behaviour::new(auth_keys, gossipsub_config)
            .map_err(ProtocolError::storage)?;
        let topic = gossipsub::IdentTopic::new("citizen/consensus");
        behaviour
            .subscribe(&topic)
            .map_err(ProtocolError::ConsensusViolation)?;

        let transport = libp2p::tokio_development_transport(local_key.clone())
            .await
            .map_err(ProtocolError::storage)?;
        let mut swarm = Swarm::with_tokio_executor(transport, behaviour, local_peer_id);
        let addr = format!("/ip4/{}/tcp/{}", listen_addr.ip(), listen_addr.port())
            .parse()
            .map_err(ProtocolError::storage)?;
        Swarm::listen_on(&mut swarm, addr).map_err(ProtocolError::storage)?;

        let network = Self {
            swarm: Arc::new(tokio::sync::Mutex::new(swarm)),
            topic,
            subscribers: Arc::new(RwLock::new(Vec::new())),
            validators: Arc::new(RwLock::new(HashMap::new())),
        };
        network.spawn_event_loop();
        Ok(network)
    }

    pub async fn add_peer(&self, validator: ValidatorId, peer: PeerId) {
        self.validators.write().await.insert(validator, peer);
    }

    fn spawn_event_loop(&self) {
        let swarm = self.swarm.clone();
        let topic = self.topic.clone();
        let subscribers = self.subscribers.clone();
        let validators = self.validators.clone();
        tokio::spawn(async move {
            let mut swarm = swarm.lock().await;
            loop {
                match swarm.next().await {
                    Some(SwarmEvent::Behaviour(gossipsub::Event::Message {
                        propagation_source: _,
                        message,
                        ..
                    })) => {
                        if message.topic != TopicHash::from_raw(topic.hash()) {
                            continue;
                        }
                        let allowed_peers = validators.read().await;
                        if let Some(source) = message.source {
                            if !allowed_peers.values().any(|peer| peer == &source) {
                                warn!(?source, "libp2p message rejected by admission policy");
                                continue;
                            }
                        }
                        if let Ok(consensus) =
                            serde_json::from_slice::<ConsensusMessage>(&message.data)
                        {
                            let senders = subscribers.read().await.clone();
                            for tx in senders {
                                let _ = tx.send(consensus.clone()).await;
                            }
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        });
    }
}

#[cfg(feature = "libp2p")]
#[async_trait]
impl Network for Libp2pNetwork {
    async fn broadcast(&self, message: ConsensusMessage) -> Result<()> {
        let mut swarm = self.swarm.lock().await;
        let data = serde_json::to_vec(&message).map_err(ProtocolError::storage)?;
        swarm
            .behaviour_mut()
            .publish(self.topic.clone(), data)
            .map_err(|err| ProtocolError::ConsensusViolation(err.to_string()))?;
        Ok(())
    }

    async fn unicast(&self, _target: &ValidatorId, message: ConsensusMessage) -> Result<()> {
        // libp2p gossipsub does not guarantee direct unicast; we tag payload with target
        // and rely on consumer-side filtering.
        self.broadcast(message).await
    }

    async fn subscribe(&self) -> Result<mpsc::Receiver<ConsensusMessage>> {
        let (tx, rx) = mpsc::channel(256);
        self.subscribers.write().await.push(tx);
        Ok(rx)
    }
}

#[derive(Clone)]
pub struct QuicNetwork {
    endpoint: Endpoint,
    peers: Arc<RwLock<HashMap<ValidatorId, SocketAddr>>>,
    subscribers: broadcast::Sender<ConsensusMessage>,
    client_cfg: ClientConfig,
    admission: Arc<AdmissionControl>,
    local_validator_id: ValidatorId,
    local_public_key: String,
}

impl QuicNetwork {
    pub fn new(
        bind_addr: SocketAddr,
        peer_map: HashMap<ValidatorId, SocketAddr>,
        admission: Arc<AdmissionControl>,
        local_validator_id: ValidatorId,
        local_public_key: String,
    ) -> Result<Self> {
        let cert = generate_simple_self_signed(["citizen.local".into()])
            .map_err(ProtocolError::storage)?;
        let priv_key_bytes = cert.signing_key.serialize_der();
        let priv_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(priv_key_bytes));
        let cert_der = CertificateDer::from(cert.cert);
        let server_config = ServerConfig::with_single_cert(vec![cert_der.clone()], priv_key)
            .map_err(ProtocolError::storage)?;
        let endpoint =
            Endpoint::server(server_config, bind_addr).map_err(ProtocolError::storage)?;
        let mut roots = RootCertStore::empty();
        let _ = roots.add_parsable_certificates([cert_der]);
        let client_cfg =
            ClientConfig::with_root_certificates(roots.into()).map_err(ProtocolError::storage)?;

        let (tx, _) = broadcast::channel(1024);
        let network = Self {
            endpoint,
            peers: Arc::new(RwLock::new(peer_map)),
            subscribers: tx,
            client_cfg,
            admission,
            local_validator_id,
            local_public_key,
        };
        network.spawn_accept_loop();
        Ok(network)
    }

    pub async fn update_validator_snapshot(&self, snapshot: ValidatorSetSnapshot) {
        self.admission.update_snapshot(snapshot).await;
    }

    pub async fn update_peers(&self, peer_map: HashMap<ValidatorId, SocketAddr>) {
        let mut peers = self.peers.write().await;
        peers.clear();
        peers.extend(peer_map);
    }

    fn spawn_accept_loop(&self) {
        let endpoint = self.endpoint.clone();
        let tx = self.subscribers.clone();
        let admission = self.admission.clone();
        tokio::spawn(async move {
            while let Some(connecting) = endpoint.accept().await {
                if let Ok(conn) = connecting.await {
                    loop {
                        match conn.accept_bi().await {
                            Ok((send, recv)) => {
                                QuicNetwork::spawn_reader(tx.clone(), admission.clone(), recv);
                                drop(send);
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        });
    }

    fn spawn_reader(
        tx: broadcast::Sender<ConsensusMessage>,
        admission: Arc<AdmissionControl>,
        mut recv: RecvStream,
    ) {
        tokio::spawn(async move {
            loop {
                match recv.read_to_end(1024 * 1024).await {
                    Ok(data) => {
                        if data.is_empty() {
                            break;
                        }
                        if let Ok(wire) = bincode::deserialize::<WireMessage>(&data) {
                            if admission.allows(&wire.handshake).await {
                                let _ = tx.send(wire.message);
                            } else {
                                warn!(
                                    validator = %wire.handshake.validator_id,
                                    "quic message rejected by admission policy"
                                );
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    async fn connection(&self, target: &ValidatorId) -> Result<(SendStream, RecvStream)> {
        let peers = self.peers.read().await;
        let Some(addr) = peers.get(target) else {
            return Err(ProtocolError::ConsensusViolation(format!(
                "unknown peer {target}"
            )));
        };
        let addr = *addr;
        drop(peers);
        let conn = self
            .endpoint
            .connect_with(self.client_cfg.clone(), addr, "citizen")
            .map_err(ProtocolError::storage)?
            .await
            .map_err(ProtocolError::storage)?;
        conn.open_bi().await.map_err(ProtocolError::storage)
    }
}

#[async_trait]
impl Network for QuicNetwork {
    async fn broadcast(&self, message: ConsensusMessage) -> Result<()> {
        let peers = self.peers.read().await.clone();
        for (validator, _) in peers.iter() {
            let _ = self.unicast(validator, message.clone()).await?;
        }
        Ok(())
    }

    async fn unicast(&self, target: &ValidatorId, message: ConsensusMessage) -> Result<()> {
        let (mut send, _) = self.connection(target).await?;
        let epoch = self.admission.maybe_rotate().await;
        let wire = WireMessage {
            handshake: PeerHandshake {
                validator_id: self.local_validator_id.clone(),
                public_key: self.local_public_key.clone(),
                key_epoch: epoch,
            },
            message,
        };
        let data = bincode::serialize(&wire).map_err(ProtocolError::storage)?;
        send.write_all(&data)
            .await
            .map_err(ProtocolError::storage)?;
        send.finish().map_err(ProtocolError::storage)
    }

    async fn subscribe(&self) -> Result<mpsc::Receiver<ConsensusMessage>> {
        let mut rx = self.subscribers.subscribe();
        let (tx, client_rx) = mpsc::channel(256);
        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                if tx.send(msg).await.is_err() {
                    break;
                }
            }
        });
        Ok(client_rx)
    }
}
