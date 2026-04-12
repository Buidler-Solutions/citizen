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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerEntry {
    pub entry_id: Uuid,
    pub namespace: NamespaceId,
    pub action: String,
    pub object_id: String,
    pub payload: Value,
    #[serde(default)]
    pub privacy_flag: bool,
    #[serde(default)]
    pub privacy_mode: PrivacyMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_commitment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ciphertext_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salt_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kdf_params: Option<KdfParams>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent_receipt: Option<ConsentReceipt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authorized_readers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custodian_policy_id: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub field_reader_acls: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_wrapped_secrets: Vec<KeyWrap>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub revocation_events: Vec<RevocationEvent>,
    pub author: String,
    pub signature: String,
    pub timestamp: UnixTimestamp,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyMode {
    #[default]
    None,
    Passphrase,
    Hybrid,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyWrap {
    pub reader_id: String,
    pub wrapped_dek: String,
    pub wrap_algorithm: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RevocationEvent {
    pub event_id: String,
    pub data_hash: String,
    pub reader_id: String,
    pub timestamp: UnixTimestamp,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threshold_signatures: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub output_length: usize,
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
    pub status: ValidatorStatus,
    pub performance: ValidatorPerformance,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ValidatorStatus {
    Active,
    Standby,
    Suspended,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatorPerformance {
    pub uptime_bps: u16,
    pub missed_prevotes: u64,
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
    RotateValidators(ValidatorRotation),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatorRotation {
    pub epoch: u64,
    pub seed: String,
    pub active: Vec<ValidatorId>,
    pub standby: Vec<ValidatorId>,
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
    pub epoch_state: EpochState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct EpochState {
    pub epoch: u64,
    pub epoch_length_blocks: u64,
    pub promotion_limit: usize,
    pub pending_replacements: Vec<PendingReplacement>,
    pub scheduled_rotation: Option<ScheduledRotation>,
    pub manifest_digest: String,
    pub last_seed: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledRotation {
    pub decided_at_height: BlockHeight,
    pub apply_at_height: BlockHeight,
    pub rotation: ValidatorRotation,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingReplacement {
    pub failed_validator: ValidatorId,
    pub reason: String,
    pub detected_at_height: BlockHeight,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConsensusConfig {
    pub block_time_millis: u64,
    pub max_entries_per_block: usize,
    pub quorum_bps: u32,
    pub epoch_length_blocks: u64,
    pub promotion_limit: usize,
    pub heartbeat_interval_millis: u64,
    pub liveness_missed_prevote_threshold: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConsensusOutcome {
    pub block: Block,
    pub duration_ms: u64,
    pub aborted_rounds: u32,
    pub leader_rotations: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignedEnvelope<T> {
    pub envelope_id: Uuid,
    pub signer: String,
    pub signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub co_signatures: Vec<EnvelopeCoSignature>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_policy: Option<EnvelopeMultisigPolicy>,
    pub submitted_at: DateTime<Utc>,
    pub payload: T,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvelopeCoSignature {
    pub signer: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvelopeMultisigPolicy {
    pub threshold: u16,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_signers: Vec<String>,
    #[serde(default)]
    pub require_author_signature: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeterministicReceipt {
    pub receipt_id: Uuid,
    pub envelope_id: Uuid,
    pub status: ReceiptStatus,
    pub validation: ValidationSummary,
    pub finality: Option<FinalityProof>,
    pub recorded_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidationSummary {
    pub namespace: NamespaceId,
    pub action: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offchain_commitments: Option<OffchainCommitmentSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OffchainCommitmentSummary {
    pub payload_commitment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ciphertext_hash: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub encrypted_field_commitments: Vec<PayloadFieldCommitmentSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PayloadFieldCommitmentSummary {
    pub field_path: String,
    pub payload_commitment: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FinalityProof {
    pub block_height: BlockHeight,
    pub block_hash: String,
    pub commit_proof: CommitProof,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DidDocument {
    pub did: String,
    pub controller: String,
    pub status: DidStatus,
    pub claims_hash: Option<String>,
    pub updated_at: UnixTimestamp,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum DidStatus {
    Active,
    Revoked,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConsentReceipt {
    pub subject_did: String,
    pub data_hash: String,
    pub policy_ref: String,
    pub granted_at: UnixTimestamp,
    pub expires_at: UnixTimestamp,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authorized_readers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custodian_policy_id: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub field_reader_acls: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConsentPolicyCheck {
    pub valid: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReceiptStatus {
    Accepted,
    Rejected,
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SimulationConfig {
    pub validators: usize,
    pub scenario: SimulationScenario,
    pub network: NetworkModel,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SimulationScenario {
    Normal,
    PartialFailure,
    ActiveFailure10,
    ActiveFailure15,
    ActiveFailure30,
    QuorumLoss,
    MaliciousLeader,
    ByzantineSubset,
    NetworkPartition,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NetworkModel {
    pub same_region_rtt_ms: (u64, u64),
    pub cross_region_rtt_ms: (u64, u64),
    pub jitter_ms: u64,
    pub packet_loss: f64,
}

#[cfg(test)]
mod tests {
    use super::{EnvelopeCoSignature, EnvelopeMultisigPolicy, SignedEnvelope};
    use chrono::{TimeZone, Utc};
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn signed_envelope_legacy_decode_encode_parity() {
        let raw = json!({
            "envelope_id": "8f6ad2f0-a0a5-45f8-9360-992f20b25889",
            "signer": "did:citizen:alice",
            "signature": "sig:alice",
            "submitted_at": "2026-01-01T00:00:00Z",
            "payload": {
                "value": "legacy"
            }
        });

        let decoded: SignedEnvelope<serde_json::Value> =
            serde_json::from_value(raw.clone()).expect("legacy envelope should decode");

        assert!(decoded.signature_scope.is_none());
        assert!(decoded.co_signatures.is_empty());
        assert!(decoded.multisig_policy.is_none());

        let encoded = serde_json::to_value(decoded).expect("legacy envelope should encode");
        assert_eq!(encoded, raw);
    }

    #[test]
    fn signed_envelope_multisig_decode_encode_parity() {
        let envelope = SignedEnvelope {
            envelope_id: Uuid::parse_str("8f6ad2f0-a0a5-45f8-9360-992f20b25889")
                .expect("valid uuid"),
            signer: "did:citizen:alice".to_string(),
            signature: "sig:alice".to_string(),
            signature_scope: Some("canonical_payload_v1".to_string()),
            co_signatures: vec![EnvelopeCoSignature {
                signer: "did:citizen:bob".to_string(),
                signature: "sig:bob".to_string(),
            }],
            multisig_policy: Some(EnvelopeMultisigPolicy {
                threshold: 2,
                allowed_signers: vec![
                    "did:citizen:alice".to_string(),
                    "did:citizen:bob".to_string(),
                ],
                require_author_signature: true,
            }),
            submitted_at: Utc
                .with_ymd_and_hms(2026, 1, 1, 0, 0, 0)
                .single()
                .expect("valid timestamp"),
            payload: json!({
                "value": "multisig"
            }),
        };

        let encoded = serde_json::to_value(&envelope).expect("multisig envelope should encode");
        let decoded: SignedEnvelope<serde_json::Value> =
            serde_json::from_value(encoded.clone()).expect("multisig envelope should decode");

        assert_eq!(decoded, envelope);
        assert_eq!(
            encoded,
            json!({
                "envelope_id": "8f6ad2f0-a0a5-45f8-9360-992f20b25889",
                "signer": "did:citizen:alice",
                "signature": "sig:alice",
                "signature_scope": "canonical_payload_v1",
                "co_signatures": [{
                    "signer": "did:citizen:bob",
                    "signature": "sig:bob"
                }],
                "multisig_policy": {
                    "threshold": 2,
                    "allowed_signers": ["did:citizen:alice", "did:citizen:bob"],
                    "require_author_signature": true
                },
                "submitted_at": "2026-01-01T00:00:00Z",
                "payload": {
                    "value": "multisig"
                }
            })
        );
    }
}
