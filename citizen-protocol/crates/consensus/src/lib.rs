use chrono::Utc;
use citizen_crypto::{
    aggregate_signatures, hash_block_header, parse_verifying_key, quorum_threshold, sign_message,
    verify_signature, ValidatorKeypair,
};
use citizen_ledger::Ledger;
use citizen_network::{BlockProposal, ConsensusMessage, Network};
use citizen_storage::LedgerStorage;
use citizen_types::{
    Block, BlockHeader, CommitProof, ConsensusConfig, GovernanceAction,
    LedgerEntry, PendingReplacement, ProtocolError, ValidatorId,
    ValidatorMetadata, ValidatorPerformance, ValidatorSetSnapshot, ValidatorStatus,
};
use ed25519_dalek::Signature;
use parking_lot::RwLock;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use tracing::{info, warn};

pub type Result<T> = std::result::Result<T, ProtocolError>;

struct PendingRound {
    proposal: Option<BlockProposal>,
    proposal_hash: Option<String>,
    prevotes: BTreeMap<ValidatorId, SignedPreVote>,
}

#[derive(Default)]
struct LivenessMonitor {
    missed_prevotes: BTreeMap<ValidatorId, u64>,
    last_heartbeat_height: BTreeMap<ValidatorId, u64>,
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
    config: RwLock<ConsensusConfig>,
    network: Arc<N>,
    ledger: Arc<Ledger<S>>,
    validator_set: RwLock<ValidatorSetSnapshot>,
    signer: ValidatorKeypair,
    rounds: RwLock<HashMap<u64, PendingRound>>,
    committed: RwLock<HashSet<u64>>,
    included_entries: RwLock<HashSet<String>>,
    gossiped_entries: RwLock<HashSet<String>>,
    pending_proposals: RwLock<HashMap<u64, BlockProposal>>,
    liveness: RwLock<LivenessMonitor>,
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
            config: RwLock::new(config),
            network,
            ledger,
            validator_set: RwLock::new(validator_set),
            signer,
            rounds: RwLock::new(HashMap::new()),
            committed: RwLock::new(HashSet::new()),
            included_entries: RwLock::new(HashSet::new()),
            gossiped_entries: RwLock::new(HashSet::new()),
            pending_proposals: RwLock::new(HashMap::new()),
            liveness: RwLock::new(LivenessMonitor::default()),
        })
    }

    pub async fn run(self: Arc<Self>) -> Result<()> {
        let config = self.config.read().clone();
        let block_ms = config.block_time_millis;
        let mut inbox = self.network.subscribe().await?;

        // OS-level watchdog — immune to Tokio timer stalls
        let (watchdog_tx, mut watchdog_rx) = mpsc::unbounded_channel();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(block_ms));
                let _ = watchdog_tx.send(());
            }
        });

        // Background gossip (non-blocking — broadcasts are spawned)
        let gossip_engine = Arc::clone(&self);
        tokio::spawn(async move {
            let mut gossip_ticker = interval(Duration::from_millis(2000));
            loop {
                gossip_ticker.tick().await;
                gossip_engine.gossip_pending_entries().await;
            }
        });

        // Background heartbeat
        let hb_engine = Arc::clone(&self);
        let hb_interval_ms = config.heartbeat_interval_millis;
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_millis(hb_interval_ms));
            loop {
                ticker.tick().await;
                if let Err(err) = hb_engine.broadcast_heartbeat().await {
                    warn!(?err, "broadcast_heartbeat error");
                }
            }
        });

        // Initial block sync — request historical blocks from peers before
        // entering the consensus event loop. This lets a node that joins mid-chain
        // catch up by fetching blocks from existing validators.
        info!(local_height = self.ledger.storage().latest_height().unwrap_or(0), "checking if block sync is needed");
        let _ = self.sync_from_peers().await;

        loop {
            tokio::select! {
                _ = watchdog_rx.recv() => {
                    let _ = tokio::time::timeout(Duration::from_secs(5), self.try_propose()).await;
                    self.try_pending_proposal().await;
                }
                maybe_msg = inbox.recv() => {
                    if let Some(message) = maybe_msg {
                        match tokio::time::timeout(Duration::from_secs(5), self.handle_message(message)).await {
                            Ok(Ok(())) => {}
                            Ok(Err(err)) => warn!(?err, "handle_message error"),
                            Err(_) => warn!("handle_message TIMED OUT"),
                        }
                        self.try_pending_proposal().await;
                    } else {
                        warn!("inbox closed, consensus loop exiting");
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
        let prev_hash = match self.ledger.storage().get_block(current_height)? {
            Some(ref previous) => hash_block_header(&previous.header),
            None => "GENESIS".to_string(),
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
        let network = Arc::clone(&self.network);
        let msg = ConsensusMessage::Propose(proposal.clone());
        tokio::spawn(async move {
            if let Err(err) = network.broadcast(msg).await {
                warn!(?err, "proposal broadcast failed");
            }
        });
        self.handle_proposal(proposal).await
    }

    async fn broadcast_heartbeat(&self) -> Result<()> {
        let is_active = {
            let snapshot = self.validator_set.read();
            snapshot
                .validators
                .get(&self.validator_id)
                .is_some_and(|meta| meta.status == ValidatorStatus::Active)
        };
        if !is_active {
            return Ok(());
        }
        let observed_height = self.ledger.storage().latest_height()?;
        let network = Arc::clone(&self.network);
        let vid = self.validator_id.clone();
        tokio::spawn(async move {
            let _ = network
                .broadcast(ConsensusMessage::Heartbeat {
                    validator: vid,
                    observed_height,
                })
                .await;
        });
        Ok(())
    }

    fn handle_heartbeat(&self, validator: ValidatorId, observed_height: u64) {
        let snapshot = self.validator_set.read();
        if !snapshot
            .validators
            .get(&validator)
            .is_some_and(|meta| meta.status == ValidatorStatus::Active)
        {
            return;
        }
        drop(snapshot);
        self.liveness
            .write()
            .last_heartbeat_height
            .insert(validator.clone(), observed_height);

        if self.check_sync_needed(observed_height) {
            let local = self.ledger.storage().latest_height().unwrap_or(0);
            info!(
                observed_height,
                local_height = local,
                "heartbeat reveals node is behind, requesting sync"
            );
            let vid = self.validator_id.clone();
            let network = Arc::clone(&self.network);
            let target = validator.clone();
            tokio::spawn(async move {
                let _ = network
                    .unicast(
                        &target,
                        ConsensusMessage::SyncRequest {
                            requester: vid,
                            from_height: local + 1,
                            to_height: local + 100,
                        },
                    )
                    .await;
            });
        }
    }

    async fn handle_message(&self, message: ConsensusMessage) -> Result<()> {
        match message {
            ConsensusMessage::Propose(proposal) => self.handle_proposal(proposal).await,
            ConsensusMessage::Heartbeat {
                validator,
                observed_height,
            } => {
                self.handle_heartbeat(validator, observed_height);
                Ok(())
            }
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
                match &proposal.proposal_type {
                    GovernanceAction::UpdateParameter(name, value) => {
                        self.apply_runtime_parameter(name, value)?;
                    }
                    GovernanceAction::AddValidator(request) => {
                        let mut snapshot = self.validator_set.write();
                        if !snapshot.validators.contains_key(&request.candidate_id) {
                            snapshot.validators.insert(
                                request.candidate_id.clone(),
                                ValidatorMetadata {
                                    validator_id: request.candidate_id.clone(),
                                    public_key: request.public_key.clone(),
                                    anchors: request.anchors.clone(),
                                    joined_at: request.submitted_at,
                                    status: ValidatorStatus::Active,
                                    performance: ValidatorPerformance {
                                        uptime_bps: 0,
                                        missed_prevotes: 0,
                                    },
                                },
                            );
                            self.ledger.update_validator_set(snapshot.clone())?;
                            info!(candidate = %request.candidate_id, "validator admitted via governance");
                        }
                    }
                    GovernanceAction::RemoveValidator(request) => {
                        let mut snapshot = self.validator_set.write();
                        if let Some(meta) = snapshot.validators.get_mut(&request.validator_id) {
                            meta.status = ValidatorStatus::Suspended;
                            self.ledger.update_validator_set(snapshot.clone())?;
                            info!(validator = %request.validator_id, "validator suspended via governance");
                        }
                    }
                    _ => {}
                }
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
            ConsensusMessage::NewEntry(entry) => {
                let entry_id = entry.entry_id.to_string();
                {
                    let gossiped = self.gossiped_entries.read();
                    if gossiped.len() >= self.config.read().max_pending_gossiped_entries
                        && !gossiped.contains(&entry_id)
                    {
                        warn!(
                            pending = gossiped.len(),
                            max = self.config.read().max_pending_gossiped_entries,
                            "mempool full, dropping gossiped entry"
                        );
                        return Ok(());
                    }
                }
                self.gossiped_entries.write().insert(entry_id.clone());
                if self.included_entries.read().contains(&entry_id) {
                    return Ok(());
                }
                info!(%entry_id, namespace = %entry.namespace, "received gossiped entry from peer");
                if let Err(err) = self.ledger.apply_entry(entry) {
                    warn!(%entry_id, ?err, "failed to apply gossiped entry");
                }
                Ok(())
            }
            ConsensusMessage::SyncRequest {
                requester,
                from_height,
                to_height,
            } => {
                self.handle_sync_request(requester, from_height, to_height)
                    .await
            }
            ConsensusMessage::SyncResponse { requester: _, blocks } => {
                self.handle_sync_response(blocks).await
            }
        }
    }

    async fn handle_proposal(&self, proposal: BlockProposal) -> Result<()> {
        let latest_height = self.ledger.storage().latest_height()?;
        let prop_height = proposal.header.height;

        if prop_height > latest_height + 1 {
            info!(height = prop_height, latest_height, proposer = %proposal.header.proposer, "buffering proposal for future height");
            self.pending_proposals.write().insert(prop_height, proposal);
            return Ok(());
        }

        if let Err(err) = self.validate_proposal(&proposal) {
            warn!(height = prop_height, proposer = %proposal.header.proposer, ?err, "rejecting invalid proposal");
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
        let network = Arc::clone(&self.network);
        let vid = self.validator_id.clone();
        let sig_hex = hex::encode(signature.to_bytes());
        tokio::spawn(async move {
            let _ = network
                .broadcast(ConsensusMessage::PreVote {
                    height,
                    validator: vid,
                    hash,
                    signature: sig_hex,
                })
                .await;
        });
        if self.has_quorum(height)? {
            if let Some(prop) = self.get_proposal(height) {
                let block = self.create_block_with_commit(prop, height)?;
                let network = Arc::clone(&self.network);
                let block_for_broadcast = block.clone();
                tokio::spawn(async move {
                    let _ = network
                        .broadcast(ConsensusMessage::Commit {
                            height,
                            block: block_for_broadcast,
                        })
                        .await;
                });
                self.finalize_block(height, block).await?;
            }
        }
        Ok(())
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
                let network = Arc::clone(&self.network);
                let block_for_broadcast = block.clone();
                tokio::spawn(async move {
                    let _ = network
                        .broadcast(ConsensusMessage::Commit {
                            height,
                            block: block_for_broadcast,
                        })
                        .await;
                });
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
            self.config.read().quorum_bps,
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
            self.config.read().quorum_bps,
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

        let expected_prev_hash = match self
            .ledger
            .storage()
            .get_block(latest_height)?
        {
            Some(ref previous) => hash_block_header(&previous.header),
            None => "GENESIS".to_string(),
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
        _height: u64,
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
        Ok(true)
    }

    async fn finalize_block(&self, height: u64, block: Block) -> Result<()> {
        if self.committed.read().contains(&height) {
            return Ok(());
        }
        // Mark entries as included
        {
            let mut included = self.included_entries.write();
            for entry in &block.entries {
                included.insert(entry.entry_id.to_string());
            }
        }
        self.ledger.apply_block(block.clone())?;
        self.record_liveness(height, &block);
        self.sync_pending_replacements(height)?;
        self.maybe_roll_epoch(height, &block).await?;
        self.committed.write().insert(height);
        self.rounds.write().retain(|&h, _| h >= height);
        self.pending_proposals.write().retain(|&h, _| h > height);
        let entry_ids: Vec<String> = block.entries.iter()
            .map(|e| e.entry_id.to_string())
            .collect();
        info!(height, entry_count = block.entries.len(), ?entry_ids, "block finalized");

        Ok(())
    }

    async fn try_pending_proposal(&self) {
        let latest_height = match self.ledger.storage().latest_height() {
            Ok(h) => h,
            Err(_) => return,
        };
        let next_height = latest_height + 1;
        let proposal = self.pending_proposals.write().remove(&next_height);
        if let Some(proposal) = proposal {
            info!(height = next_height, "processing buffered proposal after finalization");
            if let Err(err) = self.handle_proposal(proposal).await {
                warn!(height = next_height, ?err, "failed to process buffered proposal");
            }
        }
    }

    // ── Block sync protocol ──

    /// Respond to a sync request from a peer by serving historical blocks.
    async fn handle_sync_request(
        &self,
        requester: ValidatorId,
        from_height: u64,
        to_height: u64,
    ) -> Result<()> {
        let latest = self.ledger.storage().latest_height()?;
        let cap = to_height.min(latest);
        if from_height > cap {
            info!(
                from_height, to_height, latest,
                "sync request: nothing to serve (range beyond local height)"
            );
            let network = Arc::clone(&self.network);
            let req_id = requester.clone();
            tokio::spawn(async move {
                let _ = network
                    .unicast(
                        &requester,
                        ConsensusMessage::SyncResponse {
                            requester: req_id,
                            blocks: vec![],
                        },
                    )
                    .await;
            });
            return Ok(());
        }

        const MAX_BLOCKS_PER_RESPONSE: u64 = 50;
        let effective_to = cap.min(from_height + MAX_BLOCKS_PER_RESPONSE - 1);

        let mut blocks = Vec::new();
        for h in from_height..=effective_to {
            if let Ok(Some(block)) = self.ledger.storage().get_block(h) {
                blocks.push(block);
            }
        }

        info!(
            from_height,
            effective_to,
            served = blocks.len(),
            latest,
            "serving sync request"
        );

        let network = Arc::clone(&self.network);
        let req_id = requester.clone();
        tokio::spawn(async move {
            let _ = network
                .unicast(
                    &requester,
                    ConsensusMessage::SyncResponse {
                        requester: req_id,
                        blocks,
                    },
                )
                .await;
        });
        Ok(())
    }

    /// Apply a batch of historical blocks received from a peer during sync.
    async fn handle_sync_response(&self, blocks: Vec<Block>) -> Result<()> {
        if blocks.is_empty() {
            info!("sync response: no blocks (already at tip or peer has nothing)");
            return Ok(());
        }

        let local_height = self.ledger.storage().latest_height()?;
        let mut applied = 0u64;

        for block in blocks {
            if block.header.height <= local_height {
                continue;
            }

            let expected_height = self.ledger.storage().latest_height()? + 1;
            if block.header.height != expected_height {
                warn!(
                    block_height = block.header.height,
                    expected_height,
                    "sync: skipping non-contiguous block"
                );
                continue;
            }

            self.finalize_block(block.header.height, block).await?;
            applied += 1;
        }

        if applied > 0 {
            info!(applied, "sync response applied");
        }

        Ok(())
    }

    /// Attempt to catch up to the network's latest height by requesting
    /// historical blocks from peers. Called at startup and when a heartbeat
    /// reveals the node is behind.
    pub async fn sync_from_peers(&self) -> Result<()> {
        let local_height = self.ledger.storage().latest_height()?;
        let snapshot = self.validator_set.read().clone();
        let peer_ids: Vec<ValidatorId> = snapshot
            .validators
            .keys()
            .filter(|id| *id != &self.validator_id)
            .cloned()
            .collect();

        if peer_ids.is_empty() {
            info!("sync: no peers to request blocks from");
            return Ok(());
        }

        info!(
            local_height,
            peer_count = peer_ids.len(),
            "sync: requesting blocks from peers"
        );

        for peer in &peer_ids {
            let from = local_height + 1;
            let to = local_height + 100;

            if let Err(err) = self
                .network
                .unicast(
                    peer,
                    ConsensusMessage::SyncRequest {
                        requester: self.validator_id.clone(),
                        from_height: from,
                        to_height: to,
                    },
                )
                .await
            {
                warn!(peer = %peer, ?err, "sync: failed to send request");
            }
        }

        Ok(())
    }

    /// Check if the node is behind the observed height and trigger sync.
    /// Called from the main event loop when heartbeats arrive.
    fn check_sync_needed(&self, observed_height: u64) -> bool {
        if let Ok(local) = self.ledger.storage().latest_height() {
            observed_height > local
        } else {
            false
        }
    }

    async fn maybe_roll_epoch(&self, height: u64, block: &Block) -> Result<()> {
        let snapshot = self.validator_set.read().clone();
        let epoch_length_blocks = self.config.read().epoch_length_blocks;
        if epoch_length_blocks == 0 || height % epoch_length_blocks != 0 {
            return Ok(());
        }

        let seed_material = format!(
            "{}:{}:{}:{}",
            hash_block_header(&block.header),
            snapshot.epoch_state.epoch + 1,
            snapshot.validators.len(),
            snapshot.epoch_state.manifest_digest
        );

        let mut new_snapshot = snapshot;
        new_snapshot.epoch_state.epoch += 1;
        new_snapshot.epoch_state.epoch_length_blocks = self.config.read().epoch_length_blocks;
        new_snapshot.epoch_state.last_seed = seed_material;
        self.ledger.update_validator_set(new_snapshot.clone())?;
        *self.validator_set.write() = new_snapshot;
        self.liveness.write().missed_prevotes.clear();
        Ok(())
    }

    fn sync_pending_replacements(&self, height: u64) -> Result<()> {
        let threshold = self.config.read().liveness_missed_prevote_threshold;
        if threshold == 0 {
            return Ok(());
        }

        let liveness = self.liveness.read();
        let mut snapshot = self.validator_set.write();
        let mut known: HashSet<_> = snapshot
            .epoch_state
            .pending_replacements
            .iter()
            .map(|replacement| replacement.failed_validator.clone())
            .collect();
        let mut changed = false;

        for (validator_id, missed) in &liveness.missed_prevotes {
            if *missed < threshold {
                continue;
            }
            if !snapshot
                .validators
                .get(validator_id)
                .is_some_and(|meta| meta.status == ValidatorStatus::Active)
            {
                continue;
            }
            if known.insert(validator_id.clone()) {
                snapshot
                    .epoch_state
                    .pending_replacements
                    .push(PendingReplacement {
                        failed_validator: validator_id.clone(),
                        reason: "mid-epoch-liveness-threshold".into(),
                        detected_at_height: height,
                    });
                changed = true;
            }
        }

        if changed {
            self.ledger.update_validator_set(snapshot.clone())?;
        }
        Ok(())
    }

    fn apply_runtime_parameter(&self, name: &str, value: &serde_json::Value) -> Result<()> {
        match name {
            "epoch_length_blocks" => {
                let parsed = value.as_u64().ok_or_else(|| {
                    ProtocolError::GovernanceError(
                        "epoch_length_blocks update requires an unsigned integer".into(),
                    )
                })?;
                self.config.write().epoch_length_blocks = parsed;
                let mut snapshot = self.validator_set.write();
                snapshot.epoch_state.epoch_length_blocks = parsed;
                self.ledger.update_validator_set(snapshot.clone())?;
            }
            "quorum_bps" => {
                let parsed = value.as_u64().ok_or_else(|| {
                    ProtocolError::GovernanceError(
                        "quorum_bps update requires an unsigned integer".into(),
                    )
                })? as u32;
                self.config.write().quorum_bps = parsed;
                let mut snapshot = self.validator_set.write();
                snapshot.quorum_bps = parsed;
                self.ledger.update_validator_set(snapshot.clone())?;
            }
            _ => {}
        }

        Ok(())
    }

    fn record_liveness(&self, _height: u64, block: &Block) {
        let snapshot = self.validator_set.read();
        let active = self.active_validator_ids(&snapshot);
        drop(snapshot);

        let participants = &block.header.commit_proof.participant_ids;
        let mut liveness = self.liveness.write();
        for validator_id in active {
            if participants.contains(&validator_id) {
                liveness.missed_prevotes.insert(validator_id, 0);
            } else {
                let missed = liveness.missed_prevotes.entry(validator_id).or_default();
                *missed += 1;
            }
        }
    }

    fn active_validator_ids(&self, snapshot: &ValidatorSetSnapshot) -> Vec<ValidatorId> {
        snapshot
            .validators
            .keys()
            .cloned()
            .collect()
    }

    async fn gossip_pending_entries(&self) {
        let known_namespaces = [
            "identity.citizen",
            "registry.land",
            "audit.procurement",
            "governance.vote",
            "forms.commitment",
            "onboarding.interest",
            "content.article",
            "builder.credits",
            "consent.receipt",
        ];
        let mut to_gossip = Vec::new();
        {
            let mut gossiped = self.gossiped_entries.write();
            for ns in known_namespaces {
                if let Ok(ns_entries) = self.ledger.storage().namespace_entries(&ns.to_string()) {
                    for entry in ns_entries {
                        let id = entry.entry_id.to_string();
                        if !gossiped.contains(&id) {
                            gossiped.insert(id);
                            to_gossip.push(entry);
                        }
                    }
                }
            }
        }
        for entry in to_gossip {
            let entry_id = entry.entry_id.to_string();
            info!(%entry_id, namespace = %entry.namespace, "gossiping entry to peers");
            let network = Arc::clone(&self.network);
            let id = entry_id.clone();
            tokio::spawn(async move {
                if let Err(err) = network.broadcast(ConsensusMessage::NewEntry(entry)).await {
                    warn!(%id, ?err, "failed to gossip entry");
                }
            });
        }
    }

    async fn collect_entries(&self) -> Result<Vec<LedgerEntry>> {
        let latest_height = self.ledger.storage().latest_height()?;
        // Use genesis block timestamp as the floor: include all entries
        // submitted after chain start. This avoids the sliding-window problem
        // where entries from early blocks get excluded by a moving last_block_ts.
        let genesis_ts = if latest_height > 0 {
            self.ledger
                .storage()
                .get_block(1)?
                .map(|b| b.header.timestamp)
                .unwrap_or(0)
        } else {
            0
        };

        let known_namespaces = [
            "identity.citizen",
            "registry.land",
            "audit.procurement",
            "governance.vote",
            "forms.commitment",
            "onboarding.interest",
            "content.article",
            "builder.credits",
            "consent.receipt",
        ];

        let mut total_stored = 0usize;
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        let mut author_counts: HashMap<String, usize> = HashMap::new();
        let max_per_author = self.config.read().max_entries_per_block / 4;
        let included = self.included_entries.read();
        let included_count = included.len();
        for ns in known_namespaces {
            if let Ok(ns_entries) = self.ledger.storage().namespace_entries(&ns.to_string()) {
                if !ns_entries.is_empty() {
                    info!(namespace = ns, found = ns_entries.len(), included_count, genesis_ts, "collect_entries: scanning namespace");
                }
                total_stored += ns_entries.len();
                for entry in ns_entries {
                    let id = entry.entry_id.to_string();
                    let is_included = included.contains(&id);
                    let ts_ok = entry.timestamp >= genesis_ts;
                    if !is_included && !seen.contains(&id) && ts_ok {
                        let author_count = author_counts.entry(entry.author.clone()).or_insert(0);
                        if max_per_author > 0 && *author_count >= max_per_author {
                            info!(
                                entry_id = %entry.entry_id,
                                namespace = ns,
                                author = %entry.author,
                                max_per_author,
                                "collect_entries: skipping entry — author already has max entries in this block"
                            );
                            continue;
                        }
                        *author_count += 1;
                        seen.insert(id);
                        entries.push(entry);
                    } else if is_included {
                        info!(%id, namespace = ns, "collect_entries: skipping already-included entry");
                    } else if !ts_ok {
                        info!(%id, namespace = ns, entry_ts = entry.timestamp, genesis_ts, "collect_entries: skipping entry with timestamp < genesis");
                    }
                }
            }
        }
        drop(included);
        for entry in &entries {
            if let Some(hash) = entry.payload.get("data_hash").and_then(|v| v.as_str()) {
                info!(entry_id = %entry.entry_id, %hash, namespace = %entry.namespace, "collect_entries: entry payload hash");
            }
        }
        info!(count = entries.len(), total_stored, latest_height, genesis_ts, "collect_entries");
        Ok(entries)
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
    use super::*;
    use citizen_crypto::{KeyRegistry, ValidatorKeypair};
    use citizen_ledger::Ledger;
    use citizen_network::{MockNetwork, NetworkLatency};
    use citizen_storage::MemoryStorage;
    use citizen_types::{
        Block, BlockHeader, CommitProof, ConsensusConfig, NamespaceDescriptor,
        ValidatorMetadata, ValidatorPerformance, ValidatorSetSnapshot, ValidatorStatus,
        EpochState,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    fn make_test_ledger(kp: &ValidatorKeypair) -> Arc<Ledger<MemoryStorage>> {
        let storage = Arc::new(MemoryStorage::new());
        let registry = KeyRegistry::new();
        registry.insert("validator-alpha".to_string(), *kp.verifying_key());
        let ledger = Arc::new(Ledger::new(storage, registry));
        ledger.bootstrap_namespaces(vec![citizen_types::NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "test.ns".into(),
                version: 1,
                rules_hash: "sha256:test".into(),
                governed_by: "governance.vote".into(),
            },
            writers: vec![].into_iter().collect(),
            validators: vec![],
        }]);
        ledger
    }

    fn sign_block(header: &BlockHeader, kp: &ValidatorKeypair) -> CommitProof {
        let message = citizen_crypto::hash_block_header(header);
        let sig = citizen_crypto::sign_message(kp, message.as_bytes());
        let sig_hex = hex::encode(sig.to_bytes());
        CommitProof {
            aggregated_signature: format!("validator-alpha:{sig_hex}"),
            participant_ids: ["validator-alpha".to_string()].into_iter().collect(),
        }
    }

    fn make_signed_block(height: u64, prev_hash: &str, kp: &ValidatorKeypair) -> Block {
        let mut header = BlockHeader {
            height,
            prev_hash: prev_hash.to_string(),
            entry_root: "EMPTY".to_string(),
            proposer: "validator-alpha".to_string(),
            timestamp: 1700000000 + height as i64,
            commit_proof: CommitProof {
                aggregated_signature: String::new(),
                participant_ids: std::collections::BTreeSet::new(),
            },
        };
        header.commit_proof = sign_block(&header, kp);
        Block {
            header,
            entries: vec![],
        }
    }

    fn make_validator_snapshot(
        validator_ids: &[&str],
        alpha_kp: &ValidatorKeypair,
    ) -> ValidatorSetSnapshot {
        let mut validators = BTreeMap::new();
        for vid in validator_ids {
            let public_key = if *vid == "validator-alpha" {
                hex::encode(alpha_kp.verifying_key().to_bytes())
            } else {
                let kp = ValidatorKeypair::generate(vid.to_string());
                hex::encode(kp.verifying_key().to_bytes())
            };
            validators.insert(
                vid.to_string(),
                ValidatorMetadata {
                    validator_id: vid.to_string(),
                    public_key,
                    anchors: vec![format!("org:{vid}")],
                    joined_at: chrono::Utc::now(),
                    status: ValidatorStatus::Active,
                    performance: ValidatorPerformance {
                        uptime_bps: 10000,
                        missed_prevotes: 0,
                    },
                },
            );
        }
        ValidatorSetSnapshot {
            height: 0,
            validators,
            quorum_bps: 6667,
            epoch_state: EpochState {
                epoch: 0,
                epoch_length_blocks: 0,
                pending_replacements: vec![],
                manifest_digest: String::new(),
                last_seed: String::new(),
            },
        }
    }

    fn make_engine() -> (
        ConsensusEngine<MockNetwork, MemoryStorage>,
        Arc<MockNetwork>,
        ValidatorKeypair,
    ) {
        let kp = ValidatorKeypair::generate("validator-alpha".to_string());
        let ledger = make_test_ledger(&kp);
        let network = Arc::new(MockNetwork::new(NetworkLatency {
            min_ms: 0,
            max_ms: 0,
            jitter_ms: 0,
            packet_loss: 0.0,
        }));
        let snapshot = make_validator_snapshot(&["validator-alpha"], &kp);
        let config = ConsensusConfig {
            block_time_millis: 1000,
            max_entries_per_block: 100,
            max_pending_gossiped_entries: 10_000,
            quorum_bps: 6667,
            epoch_length_blocks: 0,
            heartbeat_interval_millis: 3000,
            liveness_missed_prevote_threshold: 10,
        };
        let engine = ConsensusEngine::new(
            "validator-alpha".to_string(),
            kp.clone(),
            config,
            network.clone(),
            ledger,
            snapshot,
        )
        .unwrap();
        (engine, network, kp)
    }

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

    #[tokio::test]
    async fn sync_response_applies_missing_blocks() {
        let (engine, _network, kp) = make_engine();
        assert_eq!(engine.ledger.storage().latest_height().unwrap(), 0);

        let block1 = make_signed_block(1, "GENESIS", &kp);
        let hash1 = citizen_crypto::hash_block_header(&block1.header);
        let block2 = make_signed_block(2, &hash1, &kp);
        let hash2 = citizen_crypto::hash_block_header(&block2.header);
        let block3 = make_signed_block(3, &hash2, &kp);

        engine
            .handle_sync_response(vec![block1, block2, block3])
            .await
            .unwrap();

        assert_eq!(engine.ledger.storage().latest_height().unwrap(), 3);
        assert!(engine.ledger.storage().get_block(1).unwrap().is_some());
        assert!(engine.ledger.storage().get_block(2).unwrap().is_some());
        assert!(engine.ledger.storage().get_block(3).unwrap().is_some());
    }

    #[tokio::test]
    async fn sync_response_skips_non_contiguous_blocks() {
        let (engine, _network, kp) = make_engine();

        let block5 = make_signed_block(5, "GENESIS", &kp);
        engine
            .handle_sync_response(vec![block5])
            .await
            .unwrap();

        assert_eq!(engine.ledger.storage().latest_height().unwrap(), 0);
    }

    #[tokio::test]
    async fn sync_response_empty_is_noop() {
        let (engine, _network, _kp) = make_engine();

        engine.handle_sync_response(vec![]).await.unwrap();
        assert_eq!(engine.ledger.storage().latest_height().unwrap(), 0);
    }

    #[tokio::test]
    async fn sync_response_does_not_reapply_existing_blocks() {
        let (engine, _network, kp) = make_engine();

        let block1 = make_signed_block(1, "GENESIS", &kp);
        engine.ledger.storage().store_block(block1).unwrap();
        assert_eq!(engine.ledger.storage().latest_height().unwrap(), 1);

        let block1_dup = make_signed_block(1, "GENESIS", &kp);
        engine.handle_sync_response(vec![block1_dup]).await.unwrap();
        assert_eq!(engine.ledger.storage().latest_height().unwrap(), 1);
    }

    #[test]
    fn check_sync_needed_detects_height_gap() {
        let (engine, _network, _kp) = make_engine();

        assert!(engine.check_sync_needed(10));

        let block = make_signed_block(1, "GENESIS", &ValidatorKeypair::generate("validator-alpha".to_string()));
        engine.ledger.storage().store_block(block).unwrap();

        assert!(engine.check_sync_needed(10));
        assert!(!engine.check_sync_needed(1));
        assert!(!engine.check_sync_needed(0));
    }
}
