use chrono::Utc;
use citizen_crypto::{
    aggregate_signatures, hash_block_header, quorum_threshold, sign_message, ValidatorKeypair,
};
use citizen_ledger::Ledger;
use citizen_network::{BlockProposal, ConsensusMessage, Network};
use citizen_storage::LedgerStorage;
use citizen_types::{
    Block, BlockHeader, CommitProof, ConsensusConfig, GovernanceAction, LedgerEntry, ProtocolError,
    ValidatorId, ValidatorSetSnapshot,
};
use ed25519_dalek::Signature;
use parking_lot::RwLock;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use tokio::time::{interval, Duration};
use tracing::info;

pub type Result<T> = std::result::Result<T, ProtocolError>;

struct PendingRound {
    proposal: Option<BlockProposal>,
    prevotes: BTreeMap<ValidatorId, Signature>,
}

impl PendingRound {
    fn new() -> Self {
        Self {
            proposal: None,
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
        let total = snapshot.validators.len();
        if total == 0 {
            return Ok(());
        }
        let current_height = self.ledger.storage().latest_height()?;
        let next_height = current_height + 1;
        let leader = self.select_leader(next_height, &snapshot);
        if leader != self.validator_id {
            return Ok(());
        }
        let mut rounds = self.rounds.write();
        if rounds.contains_key(&next_height) {
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
        rounds.insert(next_height, PendingRound::new());
        drop(rounds);
        self.broadcast_proposal(proposal).await
    }

    fn select_leader(&self, height: u64, snapshot: &ValidatorSetSnapshot) -> ValidatorId {
        let mut ids: Vec<_> = snapshot.validators.keys().cloned().collect();
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
                hash,
                signature,
            } => {
                self.handle_prevote(height, validator, hash, signature)
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
                if let Some(snapshot) = self.ledger.storage().latest_validator_set()? {
                    let _ = self.ledger.storage().track_governance_proposal(
                        citizen_types::GovernanceProposal {
                            proposal_id: vote.proposal_id.clone(),
                            proposal_type: citizen_types::GovernanceAction::UpdateParameter(
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
        let height = proposal.header.height;
        {
            let mut rounds = self.rounds.write();
            let entry = rounds.entry(height).or_insert_with(PendingRound::new);
            if entry.proposal.is_none() {
                entry.proposal = Some(proposal.clone());
            }
        }
        let hash = hash_block_header(&proposal.header);
        let signature = sign_message(&self.signer, hash.as_bytes());
        self.record_prevote(height, self.validator_id.clone(), signature.clone());
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
        self.record_prevote(height, validator.clone(), signature.clone());
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

    fn record_prevote(&self, height: u64, validator: ValidatorId, signature: Signature) {
        let mut rounds = self.rounds.write();
        let entry = rounds.entry(height).or_insert_with(PendingRound::new);
        entry.prevotes.insert(validator, signature);
    }

    fn has_quorum(&self, height: u64) -> Result<bool> {
        let rounds = self.rounds.read();
        let Some(state) = rounds.get(&height) else {
            return Ok(false);
        };
        let snapshot = self.validator_set.read();
        let quorum = quorum_threshold(snapshot.validators.len(), self.config.quorum_bps);
        Ok(state.prevotes.len() >= quorum)
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
        let quorum = quorum_threshold(
            self.validator_set.read().validators.len(),
            self.config.quorum_bps,
        );
        let proof = aggregate_signatures(&state.prevotes, quorum)?;
        let mut header = proposal.header;
        header.commit_proof = proof;
        let block = Block {
            header,
            entries: proposal.entries,
        };
        state.proposal = None;
        Ok(block)
    }

    async fn finalize_block(&self, height: u64, block: Block) -> Result<()> {
        if self.committed.read().contains(&height) {
            return Ok(());
        }
        self.ledger.apply_block(block.clone())?;
        self.committed.write().insert(height);
        info!(height, "block finalized");
        Ok(())
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
        hasher.update(entry.timestamp.to_be_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

fn signature_from_hex(hex_signature: &str) -> Result<Signature> {
    let bytes = hex::decode(hex_signature)
        .map_err(|err| ProtocolError::crypto(format!("invalid signature hex: {err}")))?;
    Signature::from_slice(&bytes)
        .map_err(|err| ProtocolError::crypto(format!("invalid signature bytes: {err}")))
}
