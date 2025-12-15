use citizen_crypto::quorum_threshold;
use citizen_storage::LedgerStorage;
use citizen_types::{
    GovernanceProposal, GovernanceVote, ProtocolError, ValidatorSetSnapshot, VoteChoice,
};
use parking_lot::RwLock;
use std::collections::BTreeMap;
use std::sync::Arc;
use tracing::{debug, info};

pub type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Clone, Debug)]
pub enum GovernanceDecision {
    Pending,
    Approved,
    Rejected,
    FailedQuorum,
}

pub struct GovernanceEngine<S: LedgerStorage + 'static> {
    storage: Arc<S>,
    quorum_bps: u32,
    votes: RwLock<BTreeMap<String, BTreeMap<String, VoteChoice>>>,
}

impl<S: LedgerStorage + 'static> GovernanceEngine<S> {
    pub fn new(storage: Arc<S>, quorum_bps: u32) -> Self {
        Self {
            storage,
            quorum_bps,
            votes: RwLock::new(BTreeMap::new()),
        }
    }

    pub fn submit_proposal(&self, proposal: GovernanceProposal) -> Result<()> {
        debug!(id = %proposal.proposal_id, "tracking governance proposal");
        self.storage.track_governance_proposal(proposal)
    }

    pub fn cast_vote(
        &self,
        validator_set: &ValidatorSetSnapshot,
        vote: GovernanceVote,
    ) -> Result<GovernanceDecision> {
        if !validator_set.validators.contains_key(&vote.validator) {
            return Err(ProtocolError::GovernanceError(format!(
                "validator {} not in active set",
                vote.validator
            )));
        }
        if vote.signature.is_empty() {
            return Err(ProtocolError::GovernanceError(
                "vote signature must not be empty".into(),
            ));
        }
        {
            let mut guard = self.votes.write();
            guard
                .entry(vote.proposal_id.clone())
                .or_default()
                .insert(vote.validator.clone(), vote.vote.clone());
        }
        self.evaluate(validator_set, &vote.proposal_id)
    }

    pub fn evaluate(
        &self,
        validator_set: &ValidatorSetSnapshot,
        proposal_id: &str,
    ) -> Result<GovernanceDecision> {
        let votes = self
            .votes
            .read()
            .get(proposal_id)
            .cloned()
            .unwrap_or_default();
        let quorum = quorum_threshold(validator_set.validators.len(), self.quorum_bps);
        if votes.len() < quorum {
            return Ok(GovernanceDecision::Pending);
        }
        let approvals = votes
            .values()
            .filter(|choice| matches!(choice, VoteChoice::Yes))
            .count();
        if approvals >= quorum {
            info!(proposal_id, approvals, quorum, "proposal approved");
            Ok(GovernanceDecision::Approved)
        } else {
            info!(proposal_id, approvals, quorum, "proposal rejected");
            Ok(GovernanceDecision::Rejected)
        }
    }
}
