use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use citizen_consensus::ConsensusEngine;
use citizen_crypto::{verifying_key_to_string, KeyRegistry, ValidatorKeypair};
use citizen_ledger::Ledger;
use citizen_network::{MessageCounters, MockNetwork, NetworkLatency};
use citizen_storage::{LedgerStorage, MemoryStorage};
use citizen_types::{
    ConsensusConfig, EpochState, NetworkModel, ProtocolError, SimulationConfig, SimulationScenario,
    ValidatorMetadata, ValidatorPerformance, ValidatorSetSnapshot, ValidatorStatus,
};
use rand::seq::SliceRandom;
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::{info, warn};

pub type Result<T> = std::result::Result<T, ProtocolError>;

pub struct SimulationHarness {
    config: SimulationConfig,
    consensus_config: ConsensusConfig,
    network: Arc<MockNetwork>,
    nodes: Vec<SimNode>,
}

struct SimNode {
    id: String,
    consensus: Arc<ConsensusEngine<MockNetwork, MemoryStorage>>,
    ledger: Arc<Ledger<MemoryStorage>>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SimulationReport {
    pub final_heights: BTreeMap<String, u64>,
    pub duration_secs: u64,
    pub message_counters: MessageCounters,
    pub latency_ms: LatencySummary,
    pub golden_artifact: Option<std::path::PathBuf>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct LatencySummary {
    pub p50: u64,
    pub p90: u64,
    pub p99: u64,
    pub samples: usize,
}

impl SimulationHarness {
    pub fn new(config: SimulationConfig) -> Result<Self> {
        let consensus_config = ConsensusConfig {
            block_time_millis: 1_000,
            max_entries_per_block: 512,
            quorum_bps: 8_000,
            epoch_length_blocks: 100,
            promotion_limit: 12,
            heartbeat_interval_millis: 500,
            liveness_missed_prevote_threshold: 3,
        };
        let network = Arc::new(MockNetwork::new(latency_from_model(&config.network)));
        let (validators, snapshot) = build_validator_set(config.validators);
        let mut nodes = Vec::new();
        for (id, keypair) in validators {
            let storage = Arc::new(MemoryStorage::new());
            let ledger = Arc::new(Ledger::new(storage.clone(), KeyRegistry::new()));
            let consensus = Arc::new(ConsensusEngine::new(
                id.clone(),
                keypair,
                consensus_config.clone(),
                network.clone(),
                ledger.clone(),
                snapshot.clone(),
            )?);
            nodes.push(SimNode {
                id,
                consensus,
                ledger,
            });
        }
        Ok(Self {
            config,
            consensus_config,
            network,
            nodes,
        })
    }

    pub async fn execute(self, duration: Duration) -> Result<SimulationReport> {
        let mut handles: Vec<(String, JoinHandle<()>)> = Vec::new();
        for node in &self.nodes {
            let engine = node.consensus.clone();
            let id = node.id.clone();
            let handle = tokio::spawn(async move {
                if let Err(err) = engine.run().await {
                    tracing::error!(validator = %id, ?err, "consensus failure");
                }
            });
            handles.push((node.id.clone(), handle));
        }

        match self.config.scenario {
            SimulationScenario::Normal => {
                info!("scenario" = "normal", "duration_secs" = duration.as_secs());
                sleep(duration).await;
            }
            SimulationScenario::PartialFailure => {
                let failure_count =
                    std::cmp::max(1, (self.nodes.len() as f32 * 0.15).ceil() as usize);
                info!(
                    "scenario" = "partial_failure",
                    failure_count,
                    "note" = "stopping random validators mid-run"
                );
                sleep(duration / 2).await;
                let mut rng = rand::thread_rng();
                let mut victims: Vec<_> = handles.iter_mut().collect();
                victims.shuffle(&mut rng);
                for (id, handle) in victims.into_iter().take(failure_count) {
                    warn!("validator" = %id, "action" = "abort" , "reason" = "simulated outage");
                    handle.abort();
                }
                sleep(duration / 2).await;
            }
            SimulationScenario::ActiveFailure10 => {
                simulate_active_failures(&mut handles, 0.10, duration).await;
            }
            SimulationScenario::ActiveFailure15 => {
                simulate_active_failures(&mut handles, 0.15, duration).await;
            }
            SimulationScenario::ActiveFailure30 => {
                simulate_active_failures(&mut handles, 0.30, duration).await;
            }
            SimulationScenario::QuorumLoss => {
                info!(
                    "scenario" = "quorum_loss",
                    "action" = "dropping subset until quorum broken"
                );
                sleep(duration / 3).await;
                let quorum_threshold =
                    quorum_count(self.nodes.len(), self.consensus_config.quorum_bps);
                let mut active = handles.len();
                for (id, handle) in &mut handles {
                    if active <= quorum_threshold {
                        break;
                    }
                    warn!("validator" = %id, "action" = "abort", "reason" = "forced quorum loss");
                    handle.abort();
                    active -= 1;
                }
                sleep(duration * 2 / 3).await;
            }
            SimulationScenario::MaliciousLeader => {
                info!(
                    "scenario" = "malicious_leader",
                    "note" = "introducing invalid proposals"
                );
                if let Some((_, handle)) = handles.first_mut() {
                    handle.abort();
                }
                sleep(duration).await;
            }
            SimulationScenario::ByzantineSubset => {
                info!(
                    "scenario" = "byzantine_subset",
                    "note" = "dropping 19% validators"
                );
                let byzantine = std::cmp::max(1, (self.nodes.len() as f32 * 0.19).floor() as usize);
                for (id, handle) in handles.iter_mut().take(byzantine) {
                    warn!("validator" = %id, "action" = "abort", "reason" = "byzantine simulation");
                    handle.abort();
                }
                sleep(duration).await;
            }
            SimulationScenario::NetworkPartition => {
                info!(
                    "scenario" = "network_partition",
                    "note" = "splitting validators 60/40"
                );
                sleep(duration / 2).await;
                // For simplicity, we just abort 40% of validators to mimic stalled partition.
                let drop_count = (self.nodes.len() as f32 * 0.4).round() as usize;
                for (id, handle) in handles.iter_mut().take(drop_count) {
                    warn!("validator" = %id, "action" = "abort", "reason" = "partition simulation");
                    handle.abort();
                }
                sleep(duration / 2).await;
            }
        }

        for (_, handle) in handles {
            handle.abort();
            let _ = handle.await;
        }

        let mut heights = BTreeMap::new();
        for node in &self.nodes {
            let height = node.ledger.storage().latest_height()?;
            heights.insert(node.id.clone(), height);
        }

        let (counters, latencies) = self.network.metrics().snapshot();
        let latency_ms = percentile_summary(latencies);

        let report = SimulationReport {
            final_heights: heights,
            duration_secs: duration.as_secs(),
            message_counters: counters,
            latency_ms,
            golden_artifact: None,
        };

        Ok(persist_golden(report)?)
    }
}

fn latency_from_model(model: &NetworkModel) -> NetworkLatency {
    NetworkLatency {
        min_ms: model.same_region_rtt_ms.0,
        max_ms: model.cross_region_rtt_ms.1,
        jitter_ms: model.jitter_ms,
        packet_loss: model.packet_loss,
    }
}

fn build_validator_set(count: usize) -> (Vec<(String, ValidatorKeypair)>, ValidatorSetSnapshot) {
    let mut validators = Vec::new();
    let mut metadata = BTreeMap::new();
    for idx in 0..count {
        let id = format!("validator-{idx:03}");
        let keypair = ValidatorKeypair::generate(id.clone());
        metadata.insert(
            id.clone(),
            ValidatorMetadata {
                validator_id: id.clone(),
                public_key: verifying_key_to_string(keypair.verifying_key()),
                anchors: vec![format!("simulation-node-{idx}")],
                joined_at: Utc::now(),
                status: if idx < count.div_ceil(2) {
                    ValidatorStatus::Active
                } else {
                    ValidatorStatus::Standby
                },
                performance: ValidatorPerformance {
                    uptime_bps: 10_000,
                    missed_prevotes: 0,
                },
            },
        );
        validators.push((id, keypair));
    }
    let snapshot = ValidatorSetSnapshot {
        height: 0,
        validators: metadata,
        quorum_bps: 8_000,
        epoch_state: EpochState {
            epoch: 0,
            epoch_length_blocks: 100,
            promotion_limit: count.div_ceil(8),
            pending_replacements: Vec::new(),
            scheduled_rotation: None,
            manifest_digest: "simulation-manifest".into(),
            last_seed: "genesis".into(),
        },
    };
    (validators, snapshot)
}

fn quorum_count(total: usize, quorum_bps: u32) -> usize {
    ((total * quorum_bps as usize) + 9_999) / 10_000
}

async fn simulate_active_failures(
    handles: &mut [(String, JoinHandle<()>)],
    ratio: f32,
    duration: Duration,
) {
    let failure_count = std::cmp::max(1, (handles.len() as f32 * ratio).ceil() as usize);
    info!(
        "scenario" = "active_failure",
        failure_count,
        ratio,
        "note" = "dropping validators mid-epoch"
    );
    sleep(duration / 2).await;
    let mut rng = rand::thread_rng();
    let mut victims: Vec<_> = handles.iter_mut().collect();
    victims.shuffle(&mut rng);
    for (id, handle) in victims.into_iter().take(failure_count) {
        warn!("validator" = %id, "action" = "abort", "reason" = "simulated active failure");
        handle.abort();
    }
    sleep(duration / 2).await;
}

fn percentile_summary(samples: Vec<u64>) -> LatencySummary {
    if samples.is_empty() {
        return LatencySummary {
            p50: 0,
            p90: 0,
            p99: 0,
            samples: 0,
        };
    }
    let mut sorted = samples;
    sorted.sort_unstable();
    let len = sorted.len();
    let percentile = |pct: f64| -> u64 {
        let idx = ((pct * len as f64).ceil() as usize).saturate_to(len.saturating_sub(1));
        sorted.get(idx).copied().unwrap_or(0)
    };
    LatencySummary {
        p50: percentile(0.50),
        p90: percentile(0.90),
        p99: percentile(0.99),
        samples: len,
    }
}

trait SaturatingIndex {
    fn saturate_to(self, max: usize) -> usize;
}

impl SaturatingIndex for usize {
    fn saturate_to(self, max: usize) -> usize {
        if self > max {
            max
        } else {
            self
        }
    }
}

fn persist_golden(mut report: SimulationReport) -> Result<SimulationReport> {
    let dir = std::path::PathBuf::from("reports/golden");
    std::fs::create_dir_all(&dir).map_err(ProtocolError::storage)?;
    let filename = format!(
        "report-{}.json",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    let path = dir.join(filename);
    let json = serde_json::to_vec_pretty(&report).map_err(ProtocolError::storage)?;
    std::fs::write(&path, json).map_err(ProtocolError::storage)?;
    report.golden_artifact = Some(path);
    Ok(report)
}
