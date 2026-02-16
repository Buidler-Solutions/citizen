use chrono::Utc;
use citizen_crypto::{
    aggregate_signatures, hash_block_header, parse_verifying_key, quorum_threshold, sign_message,
    verify_signature, ValidatorKeypair,
};
use citizen_ledger::Ledger;
use citizen_network::{BlockProposal, ConsensusMessage, Network};
use citizen_storage::LedgerStorage;
use citizen_types::{
    Block, BlockHeader, CommitProof, ConsensusConfig, GovernanceAction, LedgerEntry,
    PendingReplacement, ProtocolError, ValidatorId, ValidatorSetSnapshot, ValidatorStatus,
};
use ed25519_dalek::Signature;
use parking_lot::RwLock;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use tokio::time::{interval, Duration};
use tracing::{info, warn};

pub type Result<T> = std::result::Result<T, ProtocolError>;

struct PendingRound {
    proposal: Option<BlockProposal>,
    proposal_hash: Option<String>,
    prevotes: BTreeMap<ValidatorId, SignedPreVote>,
}

#[derive(Clone)]
struct SignedPreVote {
    hash: String,
    signature: Signature,
}

impl PendingRound {
    fn new() -> Self {
        Self {
            proposal: None,
            proposal_hash: None,
            prevotes: BTreeMap::new(),
        }
    }
}

pub struct ConsensusEngine<N, S>
where
    N: Network + 'static,
    S: LedgerStorage + 'static,
{
    pub validator_id: ValidatorId,
    config: ConsensusConfig,
    network: Arc<N>,
    ledger: Arc<Ledger<S>>,
    validator_set: RwLock<ValidatorSetSnapshot>,
    signer: ValidatorKeypair,
    rounds: RwLock<HashMap<u64, PendingRound>>,
    committed: RwLock<HashSet<u64>>,
}

impl<N, S> ConsensusEngine<N, S>
where
    N: Network + 'static,
    S: LedgerStorage + 'static,
{
    pub fn new(
        validator_id: ValidatorId,
        signer: ValidatorKeypair,
        config: ConsensusConfig,
        network: Arc<N>,
        ledger: Arc<Ledger<S>>,
        validator_set: ValidatorSetSnapshot,
    ) -> Result<Self> {
        ledger.update_validator_set(validator_set.clone())?;
        Ok(Self {
            validator_id,
            config,
            network,
            ledger,
            validator_set: RwLock::new(validator_set),
            signer,
            rounds: RwLock::new(HashMap::new()),
            committed: RwLock::new(HashSet::new()),
        })
    }

    pub async fn run(self: Arc<Self>) -> Result<()> {
        let mut ticker = interval(Duration::from_millis(self.config.block_time_millis));
        let mut inbox = self.network.subscribe().await?;

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    self.try_propose().await?;
                }
                maybe_msg = inbox.recv() => {
                    if let Some(message) = maybe_msg {
                        self.handle_message(message).await?;
                    } else {
                        break;
                    }
                }
            }
        }
        Ok(())
    }

    async fn try_propose(&self) -> Result<()> {
        let snapshot = self.validator_set.read().clone();
        let total = self.active_validator_ids(&snapshot).len();
        if total == 0 {
            return Ok(());
        }
        let current_height = self.ledger.storage().latest_height()?;
        let next_height = current_height + 1;
        let leader = self.select_leader(next_height, &snapshot);
        if leader != self.validator_id {
            return Ok(());
        }
        if self.rounds.read().contains_key(&next_height) {
            return Ok(());
        }
        let entries = self.collect_entries().await?;
        let prev_hash = if current_height == 0 {
            "GENESIS".to_string()
        } else {
            let previous = self
                .ledger
                .storage()
                .get_block(current_height)?
                .ok_or_else(|| {
                    ProtocolError::ConsensusViolation("missing previous block".into())
                })?;
            hash_block_header(&previous.header)
        };
        let header = BlockHeader {
            height: next_height,
            prev_hash,
            entry_root: compute_entry_root(&entries),
            proposer: self.validator_id.clone(),
            timestamp: Utc::now().timestamp(),
            commit_proof: CommitProof {
                aggregated_signature: String::new(),
                participant_ids: BTreeSet::new(),
            },
        };
        let proposal = BlockProposal {
            header,
            entries,
            round: 0,
        };
        {
            let mut rounds = self.rounds.write();
            rounds.insert(next_height, PendingRound::new());
        }
        self.broadcast_proposal(proposal).await
    }

    fn select_leader(&self, height: u64, snapshot: &ValidatorSetSnapshot) -> ValidatorId {
        let mut ids = self.active_validator_ids(snapshot);
        ids.sort();
        let index = (height as usize) % ids.len();
        ids[index].clone()
    }

    async fn broadcast_proposal(&self, proposal: BlockProposal) -> Result<()> {
        let height = proposal.header.height;
        {
            let mut rounds = self.rounds.write();
            let entry = rounds.entry(height).or_insert_with(PendingRound::new);
            entry.proposal = Some(proposal.clone());
        }
        info!(height, proposer = %proposal.header.proposer, "broadcasting proposal");
        self.network
            .broadcast(ConsensusMessage::Propose(proposal.clone()))
            .await?;
        self.handle_proposal(proposal).await
    }

    async fn handle_message(&self, message: ConsensusMessage) -> Result<()> {
        match message {
            ConsensusMessage::Propose(proposal) => self.handle_proposal(proposal).await,
            ConsensusMessage::PreVote {
                height,
                validator,
                hash: _hash,
                signature,
            } => {
                self.handle_prevote(height, validator, _hash, signature)
                    .await
            }
            ConsensusMessage::Commit { height, block } => self.handle_commit(height, block).await,
            ConsensusMessage::GovernanceProposal(proposal) => {
                info!(id = %proposal.proposal_id, "received governance proposal");
                self.ledger.track_governance(proposal)?;
                Ok(())
            }
            ConsensusMessage::GovernanceVote(vote) => {
                info!(proposal = %vote.proposal_id, voter = %vote.validator, "received governance vote");
                if self.ledger.storage().latest_validator_set()?.is_some() {
                    let _ = self.ledger.storage().track_governance_proposal(
                        citizen_types::GovernanceProposal {
                            proposal_id: vote.proposal_id.clone(),
                            proposal_type: GovernanceAction::UpdateParameter(
                                "vote".into(),
                                serde_json::json!({"note": "vote observed"}),
                            ),
                            author: vote.validator.clone(),
                            payload: serde_json::json!({}),
                            submitted_at: vote.cast_at,
                            voting_period_secs: 0,
                        },
                    );
                }
                Ok(())
            }
        }
    }

    async fn handle_proposal(&self, proposal: BlockProposal) -> Result<()> {
        if let Err(err) = self.validate_proposal(&proposal) {
            warn!(height = proposal.header.height, proposer = %proposal.header.proposer, ?err, "rejecting invalid proposal");
            return Ok(());
        }

        let height = proposal.header.height;
        let hash = hash_block_header(&proposal.header);
        {
            let mut rounds = self.rounds.write();
            let entry = rounds.entry(height).or_insert_with(PendingRound::new);
            match entry.proposal_hash.as_deref() {
                None => {
                    entry.proposal = Some(proposal.clone());
                    entry.proposal_hash = Some(hash.clone());
                }
                Some(existing_hash) if existing_hash != hash => {
                    warn!(height, proposer = %proposal.header.proposer, "ignoring conflicting proposal for round");
                    return Ok(());
                }
                _ => {}
            }
        }
        let signature = sign_message(&self.signer, hash.as_bytes());
        self.record_prevote(
            height,
            self.validator_id.clone(),
            hash.clone(),
            signature.clone(),
        )?;
        self.network
            .broadcast(ConsensusMessage::PreVote {
                height,
                validator: self.validator_id.clone(),
                hash,
                signature: hex::encode(signature.to_bytes()),
            })
            .await
    }

    async fn handle_prevote(
        &self,
        height: u64,
        validator: ValidatorId,
        hash: String,
        signature_hex: String,
    ) -> Result<()> {
        if self.committed.read().contains(&height) {
            return Ok(());
        }
        let signature = signature_from_hex(&signature_hex)?;
        if !self.validate_prevote(height, &validator, &hash, &signature)? {
            warn!(height, validator = %validator, "rejecting invalid prevote");
            return Ok(());
        }
        self.record_prevote(height, validator.clone(), hash.clone(), signature.clone())?;
        let should_commit = self.has_quorum(height)?;
        if should_commit {
            if let Some(proposal) = self.get_proposal(height) {
                let block = self.create_block_with_commit(proposal, height)?;
                self.network
                    .broadcast(ConsensusMessage::Commit {
                        height,
                        block: block.clone(),
                    })
                    .await?;
                self.finalize_block(height, block).await?;
            }
        }
        Ok(())
    }

    async fn handle_commit(&self, height: u64, block: Block) -> Result<()> {
        if self.committed.read().contains(&height) {
            return Ok(());
        }
        self.finalize_block(height, block).await
    }

    fn record_prevote(
        &self,
        height: u64,
        validator: ValidatorId,
        hash: String,
        signature: Signature,
    ) -> Result<()> {
        let mut rounds = self.rounds.write();
        let entry = rounds.entry(height).or_insert_with(PendingRound::new);
        if let Some(existing) = entry.prevotes.get(&validator) {
            if existing.hash != hash {
                return Err(ProtocolError::ConsensusViolation(format!(
                    "validator {validator} equivocated for height {height}"
                )));
            }
            return Ok(());
        }
        entry
            .prevotes
            .insert(validator, SignedPreVote { hash, signature });
        Ok(())
    }

    fn has_quorum(&self, height: u64) -> Result<bool> {
        let rounds = self.rounds.read();
        let Some(state) = rounds.get(&height) else {
            return Ok(false);
        };
        let Some(expected_hash) = state.proposal_hash.as_ref() else {
            return Ok(false);
        };
        let snapshot = self.validator_set.read();
        let quorum = quorum_threshold(
            self.active_validator_ids(&snapshot).len(),
            snapshot.quorum_bps,
        );
        let votes_for_hash = state
            .prevotes
            .values()
            .filter(|vote| vote.hash == *expected_hash)
            .count();
        Ok(votes_for_hash >= quorum)
    }

    fn get_proposal(&self, height: u64) -> Option<BlockProposal> {
        let rounds = self.rounds.read();
        rounds.get(&height).and_then(|round| round.proposal.clone())
    }

    fn create_block_with_commit(&self, proposal: BlockProposal, height: u64) -> Result<Block> {
        let mut rounds = self.rounds.write();
        let state = rounds
            .get_mut(&height)
            .ok_or_else(|| ProtocolError::ConsensusViolation("missing round state".into()))?;
        let snapshot = self.validator_set.read();
        let quorum = quorum_threshold(
            self.active_validator_ids(&snapshot).len(),
            snapshot.quorum_bps,
        );
        let proposal_hash = state
            .proposal_hash
            .clone()
            .ok_or_else(|| ProtocolError::ConsensusViolation("missing proposal hash".into()))?;
        let quorum_votes: BTreeMap<ValidatorId, Signature> = state
            .prevotes
            .iter()
            .filter_map(|(validator, vote)| {
                (vote.hash == proposal_hash).then_some((validator.clone(), vote.signature))
            })
            .collect();
        let proof = aggregate_signatures(&quorum_votes, quorum)?;
        let mut header = proposal.header;
        header.commit_proof = proof;
        let block = Block {
            header,
            entries: proposal.entries,
        };
        state.proposal = None;
        Ok(block)
    }

    fn validate_proposal(&self, proposal: &BlockProposal) -> Result<()> {
        let snapshot = self.validator_set.read();
        let proposer_meta = snapshot
            .validators
            .get(&proposal.header.proposer)
            .ok_or_else(|| ProtocolError::MissingValidator(proposal.header.proposer.clone()))?;
        if proposer_meta.status != ValidatorStatus::Active {
            return Err(ProtocolError::ConsensusViolation(format!(
                "non-active proposer {}",
                proposal.header.proposer
            )));
        }

        let expected_leader = self.select_leader(proposal.header.height, &snapshot);
        if expected_leader != proposal.header.proposer {
            return Err(ProtocolError::ConsensusViolation(format!(
                "unexpected proposer {}, expected {}",
                proposal.header.proposer, expected_leader
            )));
        }

        let latest_height = self.ledger.storage().latest_height()?;
        if proposal.header.height != latest_height + 1 {
            return Err(ProtocolError::ConsensusViolation(format!(
                "proposal height {} does not extend local height {}",
                proposal.header.height, latest_height
            )));
        }

        let expected_prev_hash = if latest_height == 0 {
            "GENESIS".to_string()
        } else {
            let previous = self
                .ledger
                .storage()
                .get_block(latest_height)?
                .ok_or_else(|| {
                    ProtocolError::ConsensusViolation("missing previous block".into())
                })?;
            hash_block_header(&previous.header)
        };
        if proposal.header.prev_hash != expected_prev_hash {
            return Err(ProtocolError::ConsensusViolation(format!(
                "proposal prev_hash mismatch at height {}",
                proposal.header.height
            )));
        }

        let expected_entry_root = compute_entry_root(&proposal.entries);
        if proposal.header.entry_root != expected_entry_root {
            return Err(ProtocolError::ConsensusViolation(format!(
                "proposal entry root mismatch at height {}",
                proposal.header.height
            )));
        }

        Ok(())
    }

    fn validate_prevote(
        &self,
        height: u64,
        validator: &ValidatorId,
        hash: &str,
        signature: &Signature,
    ) -> Result<bool> {
        let snapshot = self.validator_set.read();
        let Some(meta) = snapshot.validators.get(validator) else {
            return Ok(false);
        };
        if meta.status != ValidatorStatus::Active {
            return Ok(false);
        }
        let key = parse_verifying_key(&meta.public_key)?;
        if !verify_signature(&key, hash.as_bytes(), signature) {
            return Ok(false);
        }
        drop(snapshot);

        let rounds = self.rounds.read();
        let Some(round_state) = rounds.get(&height) else {
            return Ok(false);
        };
        let Some(expected_hash) = round_state.proposal_hash.as_ref() else {
            return Ok(false);
        };
        Ok(expected_hash == hash)
    }

    async fn finalize_block(&self, height: u64, block: Block) -> Result<()> {
        if self.committed.read().contains(&height) {
            return Ok(());
        }
        self.ledger.apply_block(block.clone())?;
        self.maybe_roll_epoch(height, &block)?;
        self.committed.write().insert(height);
        info!(height, "block finalized");
        Ok(())
    }

    fn maybe_roll_epoch(&self, height: u64, block: &Block) -> Result<()> {
        let mut snapshot = self.validator_set.write();
        if snapshot.epoch_state.epoch_length_blocks == 0
            || height % snapshot.epoch_state.epoch_length_blocks != 0
        {
            return Ok(());
        }

        let active_ids = self.active_validator_ids(&snapshot);
        let standby_ids = self.standby_validator_ids(&snapshot);
        if active_ids.is_empty() || standby_ids.is_empty() {
            snapshot.epoch_state.epoch += 1;
            snapshot.epoch_state.last_seed = hash_block_header(&block.header);
            self.ledger.update_validator_set(snapshot.clone())?;
            return Ok(());
        }

        let mut failed_active: Vec<_> = active_ids
            .iter()
            .filter(|id| {
                snapshot
                    .validators
                    .get(*id)
                    .is_some_and(|meta| meta.status == ValidatorStatus::Suspended)
            })
            .cloned()
            .collect();
        failed_active.truncate(snapshot.epoch_state.promotion_limit);

        if failed_active.is_empty() {
            snapshot.epoch_state.epoch += 1;
            snapshot.epoch_state.last_seed = hash_block_header(&block.header);
            self.ledger.update_validator_set(snapshot.clone())?;
            return Ok(());
        }

        let seed_material = format!(
            "{}:{}:{}",
            hash_block_header(&block.header),
            snapshot.epoch_state.epoch + 1,
            snapshot.validators.len()
        );
        let mut standby = standby_ids;
        standby.sort_by_key(|id| {
            let mut hasher = blake3::Hasher::new();
            hasher.update(seed_material.as_bytes());
            hasher.update(id.as_bytes());
            hasher.finalize().to_hex().to_string()
        });
        let promote_count = failed_active.len().min(standby.len());
        let promoted: Vec<_> = standby.into_iter().take(promote_count).collect();

        for demoted in failed_active.into_iter().take(promote_count) {
            if let Some(meta) = snapshot.validators.get_mut(&demoted) {
                meta.status = ValidatorStatus::Standby;
            }
            snapshot
                .epoch_state
                .pending_replacements
                .push(PendingReplacement {
                    failed_validator: demoted,
                    reason: "epoch-liveness-rotation".into(),
                    detected_at_height: height,
                });
        }
        for promoted_id in promoted {
            if let Some(meta) = snapshot.validators.get_mut(&promoted_id) {
                meta.status = ValidatorStatus::Active;
            }
        }
        snapshot.epoch_state.epoch += 1;
        snapshot.epoch_state.last_seed = seed_material;
        self.ledger.update_validator_set(snapshot.clone())?;
        Ok(())
    }

    fn active_validator_ids(&self, snapshot: &ValidatorSetSnapshot) -> Vec<ValidatorId> {
        snapshot
            .validators
            .iter()
            .filter_map(|(id, meta)| (meta.status == ValidatorStatus::Active).then_some(id.clone()))
            .collect()
    }

    fn standby_validator_ids(&self, snapshot: &ValidatorSetSnapshot) -> Vec<ValidatorId> {
        snapshot
            .validators
            .iter()
            .filter_map(|(id, meta)| {
                (meta.status == ValidatorStatus::Standby).then_some(id.clone())
            })
            .collect()
    }

    async fn collect_entries(&self) -> Result<Vec<LedgerEntry>> {
        // Placeholder for namespace-specific logic; simulation uses empty batches.
        Ok(Vec::new())
    }
}

fn compute_entry_root(entries: &[LedgerEntry]) -> String {
    if entries.is_empty() {
        return "EMPTY".to_string();
    }
    let mut hasher = blake3::Hasher::new();
    for entry in entries {
        hasher.update(entry.entry_id.as_bytes());
        hasher.update(entry.namespace.as_bytes());
        hasher.update(entry.action.as_bytes());
        hasher.update(entry.object_id.as_bytes());
        hasher.update(entry.signature.as_bytes());
        hasher.update(&entry.timestamp.to_be_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

fn signature_from_hex(hex_signature: &str) -> Result<Signature> {
    let bytes = hex::decode(hex_signature)
        .map_err(|err| ProtocolError::crypto(format!("invalid signature hex: {err}")))?;
    Signature::from_slice(&bytes)
        .map_err(|err| ProtocolError::crypto(format!("invalid signature bytes: {err}")))
}

#[cfg(test)]
mod tests {
    use super::compute_entry_root;
    use citizen_types::LedgerEntry;
    use serde_json::json;

    #[test]
    fn entry_root_is_deterministic_for_identical_entries() {
        let entry: LedgerEntry = serde_json::from_value(json!({
            "entry_id": "11111111-1111-1111-1111-111111111111",
            "namespace": "registry.land",
            "action": "TRANSFER_OWNERSHIP",
            "object_id": "LOT-239-A",
            "payload": {"from":"did:A","to":"did:B"},
            "author": "did:A",
            "signature": "sig",
            "timestamp": 1736500000
        }))
        .expect("valid entry fixture");
        let root_a = compute_entry_root(std::slice::from_ref(&entry));
        let root_b = compute_entry_root(&[entry]);
        assert_eq!(root_a, root_b);
    }
}
