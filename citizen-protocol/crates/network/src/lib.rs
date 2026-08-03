use async_trait::async_trait;
use blake3::Hasher;
use citizen_types::{
    Block, BlockHeader, GovernanceProposal, GovernanceVote, LedgerEntry, ProtocolError,
    ValidatorId, ValidatorSetSnapshot,
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, PUBLIC_KEY_LENGTH};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio::time::{sleep, Duration};
#[cfg(feature = "libp2p")]
use tracing::info;
use tracing::warn;

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
use std::fs;
use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuicTlsConfig {
    pub cert_chain_path: PathBuf,
    pub private_key_path: PathBuf,
    pub ca_cert_path: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PeerHandshake {
    pub validator_id: ValidatorId,
    pub public_key: String,
    pub key_epoch: u64,
    pub network_id: String,
    pub genesis_hash: String,
    pub manifest_digest: String,
    pub nonce: u64,
    pub timestamp_ms: u64,
    pub psk_proof: Option<String>,
    pub handshake_signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandshakeIdentity {
    pub network_id: String,
    pub genesis_hash: String,
    pub manifest_digest: String,
    pub startup_secret: Option<String>,
    pub max_clock_skew: StdDuration,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WireMessage {
    handshake: PeerHandshake,
    message: ConsensusMessage,
}

#[derive(Serialize)]
struct HandshakeSigningPayload<'a> {
    validator_id: &'a str,
    public_key: &'a str,
    key_epoch: u64,
    network_id: &'a str,
    genesis_hash: &'a str,
    manifest_digest: &'a str,
    nonce: u64,
    timestamp_ms: u64,
    psk_proof: &'a Option<String>,
}

#[derive(Clone)]
pub struct AdmissionControl {
    allowed: Arc<RwLock<HashMap<ValidatorId, String>>>,
    rotation_interval: StdDuration,
    current_epoch: Arc<RwLock<u64>>,
    last_rotation: Arc<RwLock<Instant>>,
    identity: HandshakeIdentity,
    replay_cache: Arc<RwLock<HashMap<String, u64>>>,
    metrics: Arc<AdmissionMetrics>,
}

#[derive(Default)]
struct AdmissionMetrics {
    handshake_reject_total: AtomicU64,
    psk_challenge_fail_total: AtomicU64,
    handshake_reject_total_by_reason: parking_lot::Mutex<HashMap<&'static str, u64>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AdmissionMetricsSnapshot {
    pub handshake_reject_total: u64,
    pub psk_challenge_fail_total: u64,
    pub handshake_reject_total_by_reason: HashMap<&'static str, u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdmissionRejectionReason {
    UnknownValidator,
    PublicKeyMismatch,
    StaleKeyEpoch,
    NetworkIdentityMismatch,
    InvalidSystemTime,
    ClockSkewExceeded,
    ReplayDetected,
    MissingPskProof,
    InvalidPskProof,
    InvalidHandshakeSignature,
}

impl AdmissionControl {
    pub fn from_snapshot(
        snapshot: ValidatorSetSnapshot,
        rotation_interval: StdDuration,
        identity: HandshakeIdentity,
    ) -> Self {
        let allowed = snapshot
            .validators
            .iter()
            .map(|(id, meta)| (id.clone(), meta.public_key.clone()))
            .collect();
        Self::new_with_allowlist(allowed, rotation_interval, identity)
    }

    pub fn new_with_allowlist(
        allowed: HashMap<ValidatorId, String>,
        rotation_interval: StdDuration,
        identity: HandshakeIdentity,
    ) -> Self {
        Self {
            allowed: Arc::new(RwLock::new(allowed)),
            rotation_interval,
            current_epoch: Arc::new(RwLock::new(0)),
            last_rotation: Arc::new(RwLock::new(Instant::now())),
            identity,
            replay_cache: Arc::new(RwLock::new(HashMap::new())),
            metrics: Arc::new(AdmissionMetrics::default()),
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
        self.check_handshake(handshake).await.is_ok()
    }

    pub async fn check_handshake(
        &self,
        handshake: &PeerHandshake,
    ) -> std::result::Result<(), AdmissionRejectionReason> {
        let allowed = self.allowed.read().await;
        let Some(expected_key) = allowed.get(&handshake.validator_id) else {
            return Err(self.reject(AdmissionRejectionReason::UnknownValidator));
        };
        if expected_key != &handshake.public_key {
            return Err(self.reject(AdmissionRejectionReason::PublicKeyMismatch));
        }

        let epoch = self.current_epoch.read().await;
        if handshake.key_epoch < *epoch {
            return Err(self.reject(AdmissionRejectionReason::StaleKeyEpoch));
        }
        drop(epoch);

        if handshake.network_id != self.identity.network_id
            || handshake.genesis_hash != self.identity.genesis_hash
            || handshake.manifest_digest != self.identity.manifest_digest
        {
            return Err(self.reject(AdmissionRejectionReason::NetworkIdentityMismatch));
        }

        let now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as u64,
            Err(_) => return Err(self.reject(AdmissionRejectionReason::InvalidSystemTime)),
        };
        let skew_ms = self.identity.max_clock_skew.as_millis() as u64;
        if handshake.timestamp_ms.saturating_add(skew_ms) < now_ms
            || now_ms.saturating_add(skew_ms) < handshake.timestamp_ms
        {
            return Err(self.reject(AdmissionRejectionReason::ClockSkewExceeded));
        }

        if !verify_handshake_signature(handshake) {
            return Err(self.reject(AdmissionRejectionReason::InvalidHandshakeSignature));
        }

        let replay_key = format!(
            "{}:{}:{}",
            handshake.validator_id, handshake.nonce, handshake.timestamp_ms
        );
        {
            let replay_cache = self.replay_cache.read().await;
            if replay_cache.contains_key(&replay_key) {
                return Err(self.reject(AdmissionRejectionReason::ReplayDetected));
            }
        }

        if let Some(secret) = &self.identity.startup_secret {
            let Some(psk_proof) = &handshake.psk_proof else {
                return Err(self.reject(AdmissionRejectionReason::MissingPskProof));
            };
            let expected = derive_psk_proof(secret, handshake);
            if !constant_time_eq(expected.as_bytes(), psk_proof.as_bytes()) {
                return Err(self.reject(AdmissionRejectionReason::InvalidPskProof));
            }
        }

        let mut replay_cache = self.replay_cache.write().await;
        replay_cache.insert(replay_key, now_ms);
        if replay_cache.len() > 4096 {
            replay_cache.retain(|_, observed_ms| now_ms.saturating_sub(*observed_ms) <= skew_ms);
        }
        Ok(())
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

    pub fn identity(&self) -> HandshakeIdentity {
        self.identity.clone()
    }

    pub fn metrics_snapshot(&self) -> AdmissionMetricsSnapshot {
        AdmissionMetricsSnapshot {
            handshake_reject_total: self.metrics.handshake_reject_total.load(Ordering::Relaxed),
            psk_challenge_fail_total: self
                .metrics
                .psk_challenge_fail_total
                .load(Ordering::Relaxed),
            handshake_reject_total_by_reason: self
                .metrics
                .handshake_reject_total_by_reason
                .lock()
                .clone(),
        }
    }

    fn reject(&self, reason: AdmissionRejectionReason) -> AdmissionRejectionReason {
        self.metrics
            .handshake_reject_total
            .fetch_add(1, Ordering::Relaxed);
        *self
            .metrics
            .handshake_reject_total_by_reason
            .lock()
            .entry(reason.as_metric_label())
            .or_insert(0) += 1;
        if matches!(
            reason,
            AdmissionRejectionReason::MissingPskProof | AdmissionRejectionReason::InvalidPskProof
        ) {
            self.metrics
                .psk_challenge_fail_total
                .fetch_add(1, Ordering::Relaxed);
        }
        reason
    }
}

impl AdmissionRejectionReason {
    fn as_metric_label(&self) -> &'static str {
        match self {
            AdmissionRejectionReason::UnknownValidator => "unknown_validator",
            AdmissionRejectionReason::PublicKeyMismatch => "public_key_mismatch",
            AdmissionRejectionReason::StaleKeyEpoch => "stale_key_epoch",
            AdmissionRejectionReason::NetworkIdentityMismatch => "network_identity_mismatch",
            AdmissionRejectionReason::InvalidSystemTime => "invalid_system_time",
            AdmissionRejectionReason::ClockSkewExceeded => "clock_skew_exceeded",
            AdmissionRejectionReason::ReplayDetected => "replay_detected",
            AdmissionRejectionReason::MissingPskProof => "missing_psk_proof",
            AdmissionRejectionReason::InvalidPskProof => "invalid_psk_proof",
            AdmissionRejectionReason::InvalidHandshakeSignature => "invalid_handshake_signature",
        }
    }
}

fn derive_psk_proof(secret: &str, handshake: &PeerHandshake) -> String {
    let mut hasher = Hasher::new();
    hasher.update(secret.as_bytes());
    hasher.update(handshake.validator_id.as_bytes());
    hasher.update(handshake.public_key.as_bytes());
    hasher.update(handshake.network_id.as_bytes());
    hasher.update(handshake.genesis_hash.as_bytes());
    hasher.update(handshake.manifest_digest.as_bytes());
    hasher.update(&handshake.key_epoch.to_le_bytes());
    hasher.update(&handshake.nonce.to_le_bytes());
    hasher.update(&handshake.timestamp_ms.to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

fn handshake_signing_payload(handshake: &PeerHandshake) -> Vec<u8> {
    bincode::serialize(&HandshakeSigningPayload {
        validator_id: &handshake.validator_id,
        public_key: &handshake.public_key,
        key_epoch: handshake.key_epoch,
        network_id: &handshake.network_id,
        genesis_hash: &handshake.genesis_hash,
        manifest_digest: &handshake.manifest_digest,
        nonce: handshake.nonce,
        timestamp_ms: handshake.timestamp_ms,
        psk_proof: &handshake.psk_proof,
    })
    .unwrap_or_default()
}

fn sign_handshake(signing_key: &SigningKey, handshake: &PeerHandshake) -> String {
    let payload = handshake_signing_payload(handshake);
    let signature = signing_key.sign(&payload);
    hex::encode(signature.to_bytes())
}

fn verify_handshake_signature(handshake: &PeerHandshake) -> bool {
    let pk_bytes = match hex::decode(&handshake.public_key) {
        Ok(bytes) if bytes.len() == PUBLIC_KEY_LENGTH => bytes,
        _ => return false,
    };
    let mut pk_array = [0u8; PUBLIC_KEY_LENGTH];
    pk_array.copy_from_slice(&pk_bytes);
    let verifying_key = match VerifyingKey::from_bytes(&pk_array) {
        Ok(key) => key,
        Err(_) => return false,
    };
    let signature_bytes = match hex::decode(&handshake.handshake_signature) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let signature = match Signature::from_slice(&signature_bytes) {
        Ok(signature) => signature,
        Err(_) => return false,
    };
    let payload = handshake_signing_payload(handshake);
    verifying_key.verify(&payload, &signature).is_ok()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (l, r) in left.iter().zip(right.iter()) {
        diff |= l ^ r;
    }
    diff == 0
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ConsensusMessage {
    Propose(BlockProposal),
    Heartbeat {
        validator: ValidatorId,
        observed_height: u64,
    },
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
    NewEntry(LedgerEntry),
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
        let mut rng = rand::rng();
        let base = rng.random_range(self.min_ms..=self.max_ms);
        let jitter = rng.random_range(0..=self.jitter_ms);
        Duration::from_millis(base + jitter)
    }

    fn drop_packet(&self) -> bool {
        let mut rng = rand::rng();
        rng.random_bool(self.packet_loss)
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
    local_signing_key: Option<Arc<SigningKey>>,
    connections: Arc<tokio::sync::Mutex<HashMap<ValidatorId, quinn::Connection>>>,
}

impl QuicNetwork {
    pub fn new(
        bind_addr: SocketAddr,
        peer_map: HashMap<ValidatorId, SocketAddr>,
        admission: Arc<AdmissionControl>,
        local_validator_id: ValidatorId,
        local_public_key: String,
        local_signing_key: Option<Arc<SigningKey>>,
        tls_config: Option<QuicTlsConfig>,
    ) -> Result<Self> {
        let (certificate_chain, private_key, root_certs) = if let Some(config) = tls_config {
            let certificate_chain = vec![load_certificate(&config.cert_chain_path)?];
            let private_key = load_private_key(&config.private_key_path)?;
            let root_certs = vec![load_certificate(&config.ca_cert_path)?];
            (certificate_chain, private_key, root_certs)
        } else {
            let cert = generate_simple_self_signed(["citizen.local".into()])
                .map_err(ProtocolError::storage)?;
            let priv_key_bytes = cert.signing_key.serialize_der();
            let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(priv_key_bytes));
            let cert_der = CertificateDer::from(cert.cert);
            (vec![cert_der.clone()], private_key, vec![cert_der])
        };

        let mut transport = quinn::TransportConfig::default();
        transport.max_idle_timeout(Some(quinn::IdleTimeout::from(
            quinn::VarInt::from_u32(10_000),
        )));
        transport.keep_alive_interval(Some(StdDuration::from_secs(3)));
        transport.initial_mtu(1200);
        transport.stream_receive_window(quinn::VarInt::from_u32(2 * 1024 * 1024));
        transport.receive_window(quinn::VarInt::from_u32(8 * 1024 * 1024));
        #[cfg(target_os = "macos")]
        {
            transport.mtu_discovery_config(None);
        }
        let transport = Arc::new(transport);

        let mut server_config = ServerConfig::with_single_cert(certificate_chain, private_key)
            .map_err(ProtocolError::storage)?;
        server_config.transport_config(Arc::clone(&transport));
        let endpoint =
            Endpoint::server(server_config, bind_addr).map_err(ProtocolError::storage)?;
        let mut roots = RootCertStore::empty();
        let _ = roots.add_parsable_certificates(root_certs);
        let mut client_cfg =
            ClientConfig::with_root_certificates(roots.into()).map_err(ProtocolError::storage)?;
        client_cfg.transport_config(Arc::clone(&transport));

        let (tx, _) = broadcast::channel(1024);
        let network = Self {
            endpoint,
            peers: Arc::new(RwLock::new(peer_map)),
            subscribers: tx,
            client_cfg,
            admission,
            local_validator_id,
            local_public_key,
            local_signing_key,
            connections: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
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
            const CONNECT_TIMEOUT: StdDuration = StdDuration::from_secs(5);
            while let Some(connecting) = endpoint.accept().await {
                let tx = tx.clone();
                let admission = admission.clone();
                tokio::spawn(async move {
                    match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
                        Ok(Ok(conn)) => {
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
                        Ok(Err(_)) => {}
                        Err(_) => {
                            tracing::warn!("QUIC accept handshake timed out after {:?}", CONNECT_TIMEOUT);
                        }
                    }
                });
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
                match recv.read_to_end(16 * 1024 * 1024).await {
                    Ok(data) => {
                        if data.is_empty() {
                            break;
                        }
                        match serde_json::from_slice::<WireMessage>(&data) {
                            Ok(wire) => {
                                let msg_type = match &wire.message {
                                    ConsensusMessage::Propose(_) => "Propose",
                                    ConsensusMessage::Heartbeat { .. } => "Heartbeat",
                                    ConsensusMessage::PreVote { .. } => "PreVote",
                                    ConsensusMessage::Commit { .. } => "Commit",
                                    ConsensusMessage::GovernanceProposal(_) => "GovProposal",
                                    ConsensusMessage::GovernanceVote(_) => "GovVote",
                                    ConsensusMessage::NewEntry(e) => {
                                        tracing::info!(from = %wire.handshake.validator_id, entry_id = %e.entry_id, namespace = %e.namespace, bytes = data.len(), "quic recv NewEntry");
                                        "NewEntry"
                                    }
                                };
                                tracing::trace!(%msg_type, from = %wire.handshake.validator_id, bytes = data.len(), "quic recv");
                                match admission.check_handshake(&wire.handshake).await {
                                    Ok(()) => {
                                        let _ = tx.send(wire.message);
                                    }
                                    Err(reason) => {
                                        warn!(
                                            validator = %wire.handshake.validator_id,
                                            ?reason,
                                            "quic message rejected by admission policy; closing stream"
                                        );
                                        break;
                                    }
                                }
                            }
                            Err(err) => {
                                tracing::warn!(bytes = data.len(), ?err, "quic deserialize failed");
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    async fn connection(&self, target: &ValidatorId) -> Result<(SendStream, RecvStream)> {
        const CONNECT_TIMEOUT: StdDuration = StdDuration::from_secs(5);
        let peers = self.peers.read().await;
        let Some(addr) = peers.get(target) else {
            return Err(ProtocolError::ConsensusViolation(format!(
                "unknown peer {target}"
            )));
        };
        let addr = *addr;
        drop(peers);

        // Try to reuse an existing connection — clone the Connection handle
        // out of the map so we DON'T hold the mutex during open_bi/await.
        {
            let conns = self.connections.lock().await;
            if let Some(conn) = conns.get(target).cloned() {
                drop(conns);
                match tokio::time::timeout(CONNECT_TIMEOUT, conn.open_bi()).await {
                    Ok(Ok((send, recv))) => return Ok((send, recv)),
                    Ok(Err(_)) | Err(_) => {
                        let mut conns = self.connections.lock().await;
                        conns.remove(target);
                    }
                }
            }
        }

        // Create a new connection
        let conn = self
            .endpoint
            .connect_with(self.client_cfg.clone(), addr, "citizen.local")
            .map_err(ProtocolError::storage)?;
        let conn = tokio::time::timeout(CONNECT_TIMEOUT, conn)
            .await
            .map_err(|_| {
                ProtocolError::timeout(format!(
                    "QUIC connect to {addr} timed out after {CONNECT_TIMEOUT:?}"
                ))
            })?
            .map_err(ProtocolError::storage)?;
        let (send, recv) = tokio::time::timeout(CONNECT_TIMEOUT, conn.open_bi())
            .await
            .map_err(|_| {
                ProtocolError::timeout(format!(
                    "QUIC stream open to {addr} timed out after {CONNECT_TIMEOUT:?}"
                ))
            })?
            .map_err(ProtocolError::storage)?;

        // Store the connection in the pool so it stays alive
        self.connections.lock().await.insert(target.clone(), conn);

        Ok((send, recv))
    }
}

fn load_certificate(path: &PathBuf) -> Result<CertificateDer<'static>> {
    let bytes = fs::read(path).map_err(ProtocolError::storage)?;
    Ok(CertificateDer::from(bytes))
}

fn load_private_key(path: &PathBuf) -> Result<PrivateKeyDer<'static>> {
    let bytes = fs::read(path).map_err(ProtocolError::storage)?;
    Ok(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(bytes)))
}

#[async_trait]
impl Network for QuicNetwork {
    async fn broadcast(&self, message: ConsensusMessage) -> Result<()> {
        let peers = self.peers.read().await.clone();
        let handles: Vec<_> = peers
            .iter()
            .map(|(validator, _)| {
                let msg = message.clone();
                let validator = validator.clone();
                async move {
                    if let Err(err) = self.unicast(&validator, msg).await {
                        tracing::warn!(
                            validator = %validator,
                            error = %err,
                            "broadcast unicast failed, continuing"
                        );
                    }
                }
            })
            .collect();
        futures::future::join_all(handles).await;
        Ok(())
    }

    async fn unicast(&self, target: &ValidatorId, message: ConsensusMessage) -> Result<()> {
        const WRITE_TIMEOUT: StdDuration = StdDuration::from_secs(5);
        let (mut send, _) = self.connection(target).await?;
        let epoch = self.admission.maybe_rotate().await;
        let wire = WireMessage {
            handshake: {
                let identity = self.admission.identity();
                let nonce = rand::rng().random();
                let timestamp_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or_default();
                let mut handshake = PeerHandshake {
                    validator_id: self.local_validator_id.clone(),
                    public_key: self.local_public_key.clone(),
                    key_epoch: epoch,
                    network_id: identity.network_id,
                    genesis_hash: identity.genesis_hash,
                    manifest_digest: identity.manifest_digest,
                    nonce,
                    timestamp_ms,
                    psk_proof: None,
                    handshake_signature: String::new(),
                };
                if let Some(secret) = identity.startup_secret {
                    handshake.psk_proof = Some(derive_psk_proof(&secret, &handshake));
                }
                if let Some(signing_key) = &self.local_signing_key {
                    handshake.handshake_signature = sign_handshake(signing_key, &handshake);
                }
                handshake
            },
            message,
        };
        let data = serde_json::to_vec(&wire).map_err(ProtocolError::storage)?;
        if let ConsensusMessage::NewEntry(e) = &wire.message {
            tracing::info!(to = %target, entry_id = %e.entry_id, bytes = data.len(), "quic send NewEntry");
        }
        let write_result = tokio::time::timeout(WRITE_TIMEOUT, send.write_all(&data)).await;
        write_result
            .map_err(|_| ProtocolError::timeout(format!("QUIC write to {target} timed out")))?
            .map_err(ProtocolError::storage)?;
        send.finish().map_err(ProtocolError::storage)
    }

    async fn subscribe(&self) -> Result<mpsc::Receiver<ConsensusMessage>> {
        let mut rx = self.subscribers.subscribe();
        let (tx, client_rx) = mpsc::channel(256);
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(msg) => {
                        if tx.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(skipped = n, "consensus subscriber lagged, resuming");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        Ok(client_rx)
    }
}
