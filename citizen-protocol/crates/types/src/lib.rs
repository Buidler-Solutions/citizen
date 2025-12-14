use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_with::serde_as;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use uuid::Uuid;

pub type ValidatorId = String;
pub type NamespaceId = String;
pub type BlockHeight = u64;
pub type UnixTimestamp = i64;

#[serde_as]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockHeader {
    pub height: BlockHeight,
    pub prev_hash: String,
    pub entry_root: String,
    pub proposer: ValidatorId,
    pub timestamp: UnixTimestamp,
    pub commit_proof: CommitProof,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Block {
    pub header: BlockHeader,
    pub entries: Vec<LedgerEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitProof {
    pub aggregated_signature: String,
    pub participant_ids: BTreeSet<ValidatorId>,
}

impl CommitProof {
    pub fn participant_count(&self) -> usize {
        self.participant_ids.len()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LedgerEntry {
    pub entry_id: Uuid,
    pub namespace: NamespaceId,
    pub action: String,
    pub object_id: String,
    pub payload: Value,
    pub author: String,
    pub signature: String,
    pub timestamp: UnixTimestamp,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NamespaceDescriptor {
    pub namespace: NamespaceId,
    pub version: u32,
    pub rules_hash: String,
    pub governed_by: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatorMetadata {
    pub validator_id: ValidatorId,
    pub public_key: String,
    pub anchors: Vec<String>,
    pub joined_at: DateTime<Utc>,
    pub suspended: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GovernanceProposal {
    pub proposal_id: String,
    pub proposal_type: GovernanceAction,
    pub author: ValidatorId,
    pub payload: Value,
    pub submitted_at: DateTime<Utc>,
    pub voting_period_secs: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GovernanceVote {
    pub proposal_id: String,
    pub validator: ValidatorId,
    pub vote: VoteChoice,
    pub signature: String,
    pub cast_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatorAdmissionRequest {
    pub candidate_id: ValidatorId,
    pub public_key: String,
    pub anchors: Vec<String>,
    pub submitted_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatorRemovalRequest {
    pub validator_id: ValidatorId,
    pub reason: String,
    pub evidence_hash: Option<String>,
    pub submitted_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmergencyAction {
    pub action: EmergencyActionType,
    pub reason: String,
    pub submitted_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum GovernanceAction {
    AddValidator(ValidatorAdmissionRequest),
    RemoveValidator(ValidatorRemovalRequest),
    UpdateNamespace(NamespaceDescriptor),
    Emergency(EmergencyAction),
    UpdateParameter(String, Value),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum EmergencyActionType {
    PauseLedger,
    AdjustQuorum { new_quorum_bps: u32 },
    SuspendValidator { validator_id: ValidatorId },
    TriggerUpgrade { component: String, version: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum VoteChoice {
    Yes,
    No,
    Abstain,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NamespaceRuleset {
    pub descriptor: NamespaceDescriptor,
    pub writers: BTreeSet<String>,
    pub validators: Vec<NamespaceRule>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NamespaceRule {
    pub name: String,
    pub config: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatorSetSnapshot {
    pub height: BlockHeight,
    pub validators: BTreeMap<ValidatorId, ValidatorMetadata>,
    pub quorum_bps: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConsensusConfig {
    pub block_time_millis: u64,
    pub max_entries_per_block: usize,
    pub quorum_bps: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConsensusOutcome {
    pub block: Block,
    pub duration_ms: u64,
    pub aborted_rounds: u32,
    pub leader_rotations: u32,
}

#[derive(thiserror::Error, Debug)]
pub enum ProtocolError {
    #[error("invalid namespace: {0}")]
    InvalidNamespace(String),
    #[error("validation failed: {0}")]
    ValidationFailed(String),
    #[error("consensus violation: {0}")]
    ConsensusViolation(String),
    #[error("governance error: {0}")]
    GovernanceError(String),
    #[error("missing validator: {0}")]
    MissingValidator(String),
    #[error("storage error: {0}")]
    StorageError(String),
    #[error("crypto error: {0}")]
    CryptoError(String),
}

impl ProtocolError {
    pub fn storage<E: fmt::Display>(err: E) -> Self {
        ProtocolError::StorageError(err.to_string())
    }

    pub fn crypto<E: fmt::Display>(err: E) -> Self {
        ProtocolError::CryptoError(err.to_string())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SimulationConfig {
    pub validators: usize,
    pub scenario: SimulationScenario,
    pub network: NetworkModel,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SimulationScenario {
    Normal,
    PartialFailure,
    QuorumLoss,
    MaliciousLeader,
    ByzantineSubset,
    NetworkPartition,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkModel {
    pub same_region_rtt_ms: (u64, u64),
    pub cross_region_rtt_ms: (u64, u64),
    pub jitter_ms: u64,
    pub packet_loss: f64,
}
