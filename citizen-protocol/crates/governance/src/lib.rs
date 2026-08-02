use citizen_crypto::quorum_threshold;
use citizen_storage::LedgerStorage;
use citizen_types::{
    GovernanceProposal, GovernanceVote, NamespaceDescriptor, NamespaceRuleset, ProtocolError,
    ValidatorSetSnapshot, VoteChoice,
};
use parking_lot::RwLock;
use std::collections::{BTreeMap, BTreeSet};
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NamespaceDecision {
    ReuseExisting {
        namespace: String,
        version: u32,
    },
    RequiresGovernance {
        namespace: String,
        previous_version: Option<u32>,
        proposed_version: u32,
    },
}

#[derive(Clone, Debug, Default)]
pub struct NamespaceReadiness {
    pub validator_rules: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamespaceTestReport {
    pub schema_failures: bool,
    pub duplicate_rejections: bool,
    pub replay_rejections: bool,
    pub writer_bypass_rejections: bool,
}

impl NamespaceTestReport {
    pub fn all_passed(&self) -> bool {
        self.schema_failures
            && self.duplicate_rejections
            && self.replay_rejections
            && self.writer_bypass_rejections
    }
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

    pub fn decide_namespace_path(
        &self,
        existing: &[NamespaceDescriptor],
        proposed: &NamespaceRuleset,
    ) -> NamespaceDecision {
        let latest = existing
            .iter()
            .filter(|descriptor| descriptor.namespace == proposed.descriptor.namespace)
            .max_by_key(|descriptor| descriptor.version);

        match latest {
            Some(current)
                if current.rules_hash == proposed.descriptor.rules_hash
                    && current.version == proposed.descriptor.version =>
            {
                NamespaceDecision::ReuseExisting {
                    namespace: current.namespace.clone(),
                    version: current.version,
                }
            }
            Some(current) => NamespaceDecision::RequiresGovernance {
                namespace: proposed.descriptor.namespace.clone(),
                previous_version: Some(current.version),
                proposed_version: proposed.descriptor.version,
            },
            None => NamespaceDecision::RequiresGovernance {
                namespace: proposed.descriptor.namespace.clone(),
                previous_version: None,
                proposed_version: proposed.descriptor.version,
            },
        }
    }

    pub fn validate_namespace_activation(
        &self,
        validator_set: &ValidatorSetSnapshot,
        proposed: &NamespaceRuleset,
        readiness: &NamespaceReadiness,
        test_report: &NamespaceTestReport,
    ) -> Result<()> {
        if !test_report.all_passed() {
            return Err(ProtocolError::GovernanceError(
                "namespace activation blocked: mandatory adversarial tests have not all passed"
                    .into(),
            ));
        }

        let required_rules: BTreeSet<String> = proposed
            .validators
            .iter()
            .map(|rule| rule.name.clone())
            .collect();

        for validator_id in validator_set.validators.keys() {
            let Some(supported_rules) = readiness.validator_rules.get(validator_id) else {
                return Err(ProtocolError::GovernanceError(format!(
                    "namespace activation blocked: validator {} missing readiness attestation",
                    validator_id
                )));
            };
            let missing: Vec<String> = required_rules
                .difference(supported_rules)
                .cloned()
                .collect();
            if !missing.is_empty() {
                return Err(ProtocolError::GovernanceError(format!(
                    "namespace activation blocked: validator {} missing handlers for rules {:?}",
                    validator_id, missing
                )));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{GovernanceEngine, NamespaceDecision, NamespaceReadiness, NamespaceTestReport};
    use citizen_storage::MemoryStorage;
    use citizen_types::{
        EpochState, NamespaceDescriptor, NamespaceRule, NamespaceRuleset, ValidatorMetadata,
        ValidatorPerformance, ValidatorSetSnapshot, ValidatorStatus,
    };
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::Arc;

    fn engine() -> GovernanceEngine<MemoryStorage> {
        GovernanceEngine::new(Arc::new(MemoryStorage::new()), 6_667)
    }

    fn proposed_ruleset() -> NamespaceRuleset {
        NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "audit.procurement".into(),
                version: 2,
                rules_hash: "sha256:new".into(),
                governed_by: "governance".into(),
            },
            writers: BTreeSet::new(),
            validators: vec![
                NamespaceRule {
                    name: "require_signature".into(),
                    config: serde_json::json!({}),
                },
                NamespaceRule {
                    name: "require_region".into(),
                    config: serde_json::json!({"allowed":["eu-west"]}),
                },
            ],
        }
    }

    fn validator_snapshot() -> ValidatorSetSnapshot {
        let mut validators = BTreeMap::new();
        validators.insert(
            "validator-a".into(),
            ValidatorMetadata {
                validator_id: "validator-a".into(),
                public_key: "pk-a".into(),
                anchors: vec!["anchor-a".into()],
                joined_at: chrono::Utc::now(),
                status: ValidatorStatus::Active,
                performance: ValidatorPerformance {
                    uptime_bps: 10_000,
                    missed_prevotes: 0,
                },
            },
        );
        validators.insert(
            "validator-b".into(),
            ValidatorMetadata {
                validator_id: "validator-b".into(),
                public_key: "pk-b".into(),
                anchors: vec!["anchor-b".into()],
                joined_at: chrono::Utc::now(),
                status: ValidatorStatus::Active,
                performance: ValidatorPerformance {
                    uptime_bps: 10_000,
                    missed_prevotes: 0,
                },
            },
        );
        ValidatorSetSnapshot {
            height: 10,
            validators,
            quorum_bps: 6_667,
            epoch_state: EpochState {
                epoch: 0,
                epoch_length_blocks: 100,
                promotion_limit: 10,
                pending_replacements: Vec::new(),
                scheduled_rotation: None,
                manifest_digest: "manifest-digest".into(),
                last_seed: "genesis".into(),
            },
        }
    }

    #[test]
    fn namespace_decision_prefers_reuse_for_identical_ruleset() {
        let engine = engine();
        let proposed = proposed_ruleset();
        let existing = vec![NamespaceDescriptor {
            namespace: proposed.descriptor.namespace.clone(),
            version: proposed.descriptor.version,
            rules_hash: proposed.descriptor.rules_hash.clone(),
            governed_by: "governance".into(),
        }];

        let decision = engine.decide_namespace_path(&existing, &proposed);
        assert_eq!(
            decision,
            NamespaceDecision::ReuseExisting {
                namespace: "audit.procurement".into(),
                version: 2
            }
        );
    }

    #[test]
    fn namespace_activation_requires_full_validator_readiness() {
        let engine = engine();
        let proposed = proposed_ruleset();
        let validators = validator_snapshot();
        let mut readiness = NamespaceReadiness::default();
        readiness.validator_rules.insert(
            "validator-a".into(),
            ["require_signature", "require_region"]
                .into_iter()
                .map(str::to_string)
                .collect(),
        );

        let test_report = NamespaceTestReport {
            schema_failures: true,
            duplicate_rejections: true,
            replay_rejections: true,
            writer_bypass_rejections: true,
        };

        let err = engine
            .validate_namespace_activation(&validators, &proposed, &readiness, &test_report)
            .expect_err("activation must fail when any validator lacks readiness");
        assert!(err
            .to_string()
            .contains("validator validator-b missing readiness attestation"));
    }

    #[test]
    fn namespace_activation_requires_mandatory_tests() {
        let engine = engine();
        let proposed = proposed_ruleset();
        let validators = validator_snapshot();
        let mut readiness = NamespaceReadiness::default();
        for validator_id in validators.validators.keys() {
            readiness.validator_rules.insert(
                validator_id.clone(),
                ["require_signature", "require_region"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            );
        }

        let test_report = NamespaceTestReport {
            schema_failures: true,
            duplicate_rejections: true,
            replay_rejections: false,
            writer_bypass_rejections: true,
        };

        let err = engine
            .validate_namespace_activation(&validators, &proposed, &readiness, &test_report)
            .expect_err("activation must fail if adversarial tests are incomplete");
        assert!(err.to_string().contains("mandatory adversarial tests"));
    }
}
