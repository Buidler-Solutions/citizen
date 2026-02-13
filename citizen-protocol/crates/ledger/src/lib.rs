use citizen_crypto::{hash_block_header, parse_verifying_key, verify_commit_proof, KeyRegistry};
use citizen_storage::{LedgerStorage, MemoryStorage};
use citizen_types::{
    Block, GovernanceProposal, LedgerEntry, NamespaceId, NamespaceRuleset, ProtocolError,
    ValidatorSetSnapshot,
};
use parking_lot::RwLock;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tracing::debug;

pub type Result<T> = std::result::Result<T, ProtocolError>;
type RuleHandler<S> = dyn Fn(&Ledger<S>, &LedgerEntry, &Value) -> Result<()> + Send + Sync;

pub struct Ledger<S: LedgerStorage + 'static> {
    storage: Arc<S>,
    namespace_rules: RwLock<HashMap<NamespaceId, NamespaceRuleset>>,
    key_registry: KeyRegistry,
    custom_rule_handlers: RwLock<HashMap<String, Arc<RuleHandler<S>>>>,
}

impl<S: LedgerStorage + 'static> Ledger<S> {
    pub fn new(storage: Arc<S>, key_registry: KeyRegistry) -> Self {
        Self {
            storage,
            namespace_rules: RwLock::new(HashMap::new()),
            key_registry,
            custom_rule_handlers: RwLock::new(HashMap::new()),
        }
    }

    pub fn register_rule_handler<F>(&self, rule_name: impl Into<String>, handler: F)
    where
        F: Fn(&Ledger<S>, &LedgerEntry, &Value) -> Result<()> + Send + Sync + 'static,
    {
        self.custom_rule_handlers
            .write()
            .insert(rule_name.into(), Arc::new(handler));
    }

    pub fn bootstrap_namespaces(&self, namespaces: Vec<NamespaceRuleset>) {
        let mut guard = self.namespace_rules.write();
        for ruleset in namespaces {
            guard.insert(ruleset.descriptor.namespace.clone(), ruleset);
        }
    }

    pub fn apply_block(&self, block: Block) -> Result<()> {
        self.validate_block(&block)?;
        for entry in &block.entries {
            self.apply_entry(entry.clone())?;
        }
        self.storage.store_block(block)?;
        Ok(())
    }

    pub fn validate_block(&self, block: &Block) -> Result<()> {
        let header_hash = hash_block_header(&block.header);
        debug!(height = block.header.height, hash = %header_hash, "validating block");
        verify_commit_proof(
            &self.key_registry,
            &block.header,
            &block.header.commit_proof,
        )?;
        for entry in &block.entries {
            self.validate_entry(entry)?;
        }
        Ok(())
    }

    fn validate_entry(&self, entry: &LedgerEntry) -> Result<()> {
        let rules_guard = self.namespace_rules.read();
        let ruleset = rules_guard
            .get(&entry.namespace)
            .ok_or_else(|| ProtocolError::InvalidNamespace(entry.namespace.clone()))?;
        if !ruleset.writers.is_empty() && !ruleset.writers.contains(&entry.author) {
            return Err(ProtocolError::ValidationFailed(format!(
                "author {} is not permitted for namespace {}",
                entry.author, entry.namespace
            )));
        }
        for rule in &ruleset.validators {
            self.validate_rule(entry, &rule.name, &rule.config)?;
        }
        Ok(())
    }

    fn validate_rule(&self, entry: &LedgerEntry, rule_name: &str, config: &Value) -> Result<()> {
        match rule_name {
            "require_signature" => self.require_signature(entry),
            // Backwards-compatible alias for existing configs.
            "prevent_double_transfer" => {
                self.unique_by_field(entry, &Value::String("object_id".into()))
            }
            "unique_by_field" => self.unique_by_field(entry, config),
            "require_payload_fields" => self.require_payload_fields(entry, config),
            "allowed_actions" => self.allowed_actions(entry, config),
            "consent_policy" => self.consent_policy(entry, config),
            "author_matches_object_id" => self.author_matches_object_id(entry),
            "builder_credit_policy" => self.builder_credit_policy(entry, config),
            _ => {
                let handler = self
                    .custom_rule_handlers
                    .read()
                    .get(rule_name)
                    .cloned()
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(format!(
                            "unknown namespace rule '{rule_name}' for namespace {}",
                            entry.namespace
                        ))
                    })?;
                handler(self, entry, config)
            }
        }
    }

    fn require_signature(&self, entry: &LedgerEntry) -> Result<()> {
        if entry.signature.is_empty() {
            return Err(ProtocolError::ValidationFailed(
                "missing entry signature".into(),
            ));
        }
        Ok(())
    }

    fn unique_by_field(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let field_path = if let Some(path) = config.as_str() {
            path
        } else {
            config
                .get("field_path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "unique_by_field requires a string config or { field_path }".into(),
                    )
                })?
        };
        let object_value = self.extract_field(entry, field_path)?;
        let entries = self.storage.namespace_entries(&entry.namespace)?;
        for existing in entries.iter() {
            let existing_value = self.extract_field(existing, field_path)?;
            if existing_value == object_value && existing.entry_id != entry.entry_id {
                return Err(ProtocolError::ValidationFailed(format!(
                    "field '{field_path}' value '{object_value}' already exists in namespace {}",
                    entry.namespace
                )));
            }
        }
        Ok(())
    }

    fn require_payload_fields(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let fields = config
            .get("fields")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "require_payload_fields requires { fields: [..] } config".into(),
                )
            })?;
        for field in fields {
            let field_name = field.as_str().ok_or_else(|| {
                ProtocolError::ValidationFailed("payload field names must be strings".into())
            })?;
            if entry.payload.get(field_name).is_none() {
                return Err(ProtocolError::ValidationFailed(format!(
                    "payload field '{field_name}' is required for namespace {}",
                    entry.namespace
                )));
            }
        }
        Ok(())
    }

    fn allowed_actions(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let actions = config
            .get("actions")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "allowed_actions requires { actions: [..] } config".into(),
                )
            })?;
        if actions
            .iter()
            .any(|action| action.as_str() == Some(entry.action.as_str()))
        {
            Ok(())
        } else {
            Err(ProtocolError::ValidationFailed(format!(
                "action '{}' is not allowed for namespace {}",
                entry.action, entry.namespace
            )))
        }
    }

    fn consent_policy(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let required_fields = config
            .get("required_fields")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "consent_policy requires { required_fields: [..], max_ttl_secs } config".into(),
                )
            })?;
        for field in required_fields {
            let Some(field_name) = field.as_str() else {
                return Err(ProtocolError::ValidationFailed(
                    "consent_policy required_fields must be strings".into(),
                ));
            };
            if entry.payload.get(field_name).is_none() {
                return Err(ProtocolError::ValidationFailed(format!(
                    "consent receipt is missing required payload field '{field_name}'"
                )));
            }
        }

        let expires_at = entry
            .payload
            .get("expires_at")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "consent receipt requires numeric payload.expires_at".into(),
                )
            })?;
        let max_ttl_secs = config
            .get("max_ttl_secs")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed("consent_policy requires max_ttl_secs".into())
            })?;
        let ttl = expires_at - entry.timestamp;
        if ttl <= 0 {
            return Err(ProtocolError::ValidationFailed(
                "consent receipt expires_at must be in the future".into(),
            ));
        }
        if ttl > max_ttl_secs {
            return Err(ProtocolError::ValidationFailed(format!(
                "consent receipt ttl {}s exceeds allowed {}s",
                ttl, max_ttl_secs
            )));
        }
        Ok(())
    }

    fn author_matches_object_id(&self, entry: &LedgerEntry) -> Result<()> {
        if entry.author != entry.object_id {
            return Err(ProtocolError::ValidationFailed(format!(
                "author {} must match object_id {}",
                entry.author, entry.object_id
            )));
        }
        Ok(())
    }

    fn builder_credit_policy(&self, entry: &LedgerEntry, config: &Value) -> Result<()> {
        let amount = entry
            .payload
            .get("amount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(
                    "builder credit entries require numeric payload.amount".into(),
                )
            })?;
        if amount == 0 {
            return Err(ProtocolError::ValidationFailed(
                "builder credit payload.amount must be greater than zero".into(),
            ));
        }

        if entry.action == "TRANSFER_CREDITS" || entry.payload.get("to_builder").is_some() {
            return Err(ProtocolError::ValidationFailed(
                "builder fee credits are non-transferable".into(),
            ));
        }

        if entry.action == "SPONSOR_USAGE" {
            if entry.author != entry.object_id {
                return Err(ProtocolError::ValidationFailed(
                    "sponsored usage requires author to equal builder object_id".into(),
                ));
            }

            let sponsorship_id = entry
                .payload
                .get("sponsorship_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "sponsored usage requires payload.sponsorship_id".into(),
                    )
                })?;

            let entries = self.storage.namespace_entries(&entry.namespace)?;
            if entries.iter().any(|existing| {
                existing
                    .payload
                    .get("sponsorship_id")
                    .and_then(Value::as_str)
                    == Some(sponsorship_id)
            }) {
                return Err(ProtocolError::ValidationFailed(
                    "sponsorship_id has already been used".into(),
                ));
            }

            let current_balance =
                self.compute_builder_credit_balance(&entry.namespace, &entry.object_id)?;
            if current_balance < amount as i128 {
                return Err(ProtocolError::ValidationFailed(format!(
                    "insufficient builder credits: available {current_balance}, requested {amount}"
                )));
            }

            if let Some(max_daily_spend) = config.get("max_daily_spend").and_then(Value::as_u64) {
                let day_start = entry.timestamp - (entry.timestamp.rem_euclid(86_400));
                let daily_spend: u64 = entries
                    .iter()
                    .filter(|existing| {
                        existing.object_id == entry.object_id
                            && existing.action == "SPONSOR_USAGE"
                            && existing.timestamp >= day_start
                            && existing.timestamp <= entry.timestamp
                    })
                    .filter_map(|existing| existing.payload.get("amount").and_then(Value::as_u64))
                    .sum();
                if daily_spend.saturating_add(amount) > max_daily_spend {
                    return Err(ProtocolError::ValidationFailed(format!(
                        "daily sponsored spend limit exceeded: cap {max_daily_spend}, attempted {}",
                        daily_spend.saturating_add(amount)
                    )));
                }
            }
        }

        Ok(())
    }

    fn compute_builder_credit_balance(&self, namespace: &str, builder_id: &str) -> Result<i128> {
        let entries = self.storage.namespace_entries(&namespace.to_string())?;
        let mut seen_sponsorship_ids: HashSet<String> = HashSet::new();
        let mut balance: i128 = 0;

        for entry in entries {
            if entry.object_id != builder_id {
                continue;
            }

            let amount = entry
                .payload
                .get("amount")
                .and_then(Value::as_u64)
                .unwrap_or_default() as i128;
            match entry.action.as_str() {
                "CREDIT_GRANT" => balance += amount,
                "SPONSOR_USAGE" => {
                    let sponsorship_id = entry
                        .payload
                        .get("sponsorship_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if !sponsorship_id.is_empty() && seen_sponsorship_ids.insert(sponsorship_id) {
                        balance -= amount;
                    }
                }
                _ => {}
            }
        }
        Ok(balance)
    }

    fn extract_field<'a>(&self, entry: &'a LedgerEntry, field_path: &str) -> Result<&'a str> {
        match field_path {
            "object_id" => Ok(entry.object_id.as_str()),
            "action" => Ok(entry.action.as_str()),
            "author" => Ok(entry.author.as_str()),
            payload_field if payload_field.starts_with("payload.") => {
                let key = payload_field.trim_start_matches("payload.");
                entry
                    .payload
                    .get(key)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProtocolError::ValidationFailed(format!(
                            "payload field '{key}' must exist and be a string"
                        ))
                    })
            }
            other => Err(ProtocolError::ValidationFailed(format!(
                "unsupported field_path '{other}'"
            ))),
        }
    }

    pub fn validate_entry_submission(&self, entry: &LedgerEntry) -> Result<()> {
        self.validate_entry(entry)
    }

    pub fn apply_entry(&self, entry: LedgerEntry) -> Result<()> {
        self.validate_entry(&entry)?;
        self.storage.store_entry(entry)
    }

    pub fn update_validator_set(&self, snapshot: ValidatorSetSnapshot) -> Result<()> {
        for (validator_id, meta) in &snapshot.validators {
            let key = parse_verifying_key(&meta.public_key)?;
            self.key_registry.insert(validator_id.clone(), key);
        }
        self.storage.store_validator_set(snapshot)
    }

    pub fn track_governance(&self, proposal: GovernanceProposal) -> Result<()> {
        self.storage.track_governance_proposal(proposal)
    }

    pub fn storage(&self) -> Arc<S> {
        Arc::clone(&self.storage)
    }
}

impl Ledger<MemoryStorage> {
    pub fn in_memory() -> Self {
        Self::new(Arc::new(MemoryStorage::new()), KeyRegistry::new())
    }
}

#[cfg(test)]
mod tests {
    use super::Ledger;
    use citizen_types::{
        CommitProof, LedgerEntry, NamespaceDescriptor, NamespaceRule, NamespaceRuleset,
    };
    use serde_json::json;
    use std::collections::BTreeSet;
    use uuid::Uuid;

    fn test_entry(namespace: &str) -> LedgerEntry {
        LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: namespace.to_string(),
            action: "RECORD_EVENT".into(),
            object_id: "LOT-239-A".into(),
            payload: json!({"from":"did:a","to":"did:b"}),
            author: "did:a".into(),
            signature: "sig".into(),
            timestamp: 1_736_500_000,
        }
    }

    fn namespace_with_rules(name: &str, rules: Vec<NamespaceRule>) -> NamespaceRuleset {
        NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: name.to_string(),
                version: 1,
                rules_hash: "rules-v1".into(),
                governed_by: "governance".into(),
            },
            writers: BTreeSet::new(),
            validators: rules,
        }
    }

    #[test]
    fn supports_generic_field_uniqueness_on_payload() {
        let ledger = Ledger::in_memory();
        let namespace = "registry.land";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "unique_by_field".into(),
                config: json!({"field_path":"payload.to"}),
            }],
        )]);

        let first = test_entry(namespace);
        let second = test_entry(namespace);

        ledger.apply_entry(first).expect("first entry should store");
        let err = ledger
            .apply_block(citizen_types::Block {
                header: citizen_types::BlockHeader {
                    height: 1,
                    prev_hash: "0x00".into(),
                    entry_root: "root".into(),
                    proposer: "validator-a".into(),
                    timestamp: 1_736_500_001,
                    commit_proof: CommitProof {
                        aggregated_signature: "".into(),
                        participant_ids: BTreeSet::new(),
                    },
                },
                entries: vec![second],
            })
            .expect_err("duplicate payload.to must fail");

        assert!(err.to_string().contains("already exists"));
    }

    #[test]
    fn supports_custom_business_rule_handlers() {
        let ledger = Ledger::in_memory();
        let namespace = "business.custom";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "require_region".into(),
                config: json!({"allowed":["eu-west"]}),
            }],
        )]);
        ledger.register_rule_handler("require_region", |_, entry, config| {
            let allowed = config
                .get("allowed")
                .and_then(|v| v.as_array())
                .ok_or_else(|| {
                    citizen_types::ProtocolError::ValidationFailed(
                        "require_region expects {allowed:[..]}".into(),
                    )
                })?;
            let entry_region = entry
                .payload
                .get("region")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    citizen_types::ProtocolError::ValidationFailed("region is required".into())
                })?;
            if allowed.iter().any(|v| v.as_str() == Some(entry_region)) {
                Ok(())
            } else {
                Err(citizen_types::ProtocolError::ValidationFailed(
                    "region not allowed".into(),
                ))
            }
        });

        let mut entry = test_entry(namespace);
        entry.payload = json!({"region":"eu-west"});

        ledger
            .apply_block(citizen_types::Block {
                header: citizen_types::BlockHeader {
                    height: 1,
                    prev_hash: "0x00".into(),
                    entry_root: "root".into(),
                    proposer: "validator-a".into(),
                    timestamp: 1_736_500_001,
                    commit_proof: CommitProof {
                        aggregated_signature: "".into(),
                        participant_ids: BTreeSet::new(),
                    },
                },
                entries: vec![entry],
            })
            .expect("custom rule should pass");
    }

    #[test]
    fn enforces_identity_allowed_actions() {
        let ledger = Ledger::in_memory();
        let namespace = "identity.citizen";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "allowed_actions".into(),
                config: json!({"actions":["REGISTER_IDENTITY","UPDATE_CLAIM","REVOKE_IDENTITY"]}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.action = "INVALID_ACTION".into();
        let err = ledger
            .apply_entry(entry)
            .expect_err("invalid action must fail");
        assert!(err.to_string().contains("is not allowed"));
    }

    #[test]
    fn enforces_author_matches_object_id_rule() {
        let ledger = Ledger::in_memory();
        let namespace = "identity.citizen";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "author_matches_object_id".into(),
                config: json!({}),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.object_id = "did:ledger:alice".into();
        entry.author = "did:ledger:bob".into();
        let err = ledger
            .apply_entry(entry)
            .expect_err("identity subject mismatch must fail");
        assert!(err.to_string().contains("must match object_id"));
    }

    #[test]
    fn enforces_consent_policy_ttl_checks() {
        let ledger = Ledger::in_memory();
        let namespace = "consent.receipt";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "consent_policy".into(),
                config: json!({
                    "required_fields":["data_hash", "policy_ref", "expires_at"],
                    "max_ttl_secs": 3_600
                }),
            }],
        )]);

        let mut entry = test_entry(namespace);
        entry.payload = json!({
            "data_hash":"0xabc",
            "policy_ref":"policy:v1",
            "expires_at": entry.timestamp + 7_200
        });
        let err = ledger
            .apply_entry(entry)
            .expect_err("ttl above max must fail");
        assert!(err.to_string().contains("exceeds allowed"));
    }

    #[test]
    fn enforces_builder_credit_non_transferability_and_balance() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({"max_daily_spend": 100}),
            }],
        )]);

        let mut grant = test_entry(namespace);
        grant.action = "CREDIT_GRANT".into();
        grant.object_id = "builder:alpha".into();
        grant.author = "governance:ops".into();
        grant.payload = json!({"amount": 50_u64});
        ledger.apply_entry(grant).expect("grant should pass");

        let mut spend = test_entry(namespace);
        spend.action = "SPONSOR_USAGE".into();
        spend.object_id = "builder:alpha".into();
        spend.author = "builder:alpha".into();
        spend.payload =
            json!({"amount": 40_u64, "sponsorship_id":"spn-1", "sponsored_did":"did:ledger:user1"});
        ledger.apply_entry(spend).expect("spend should pass");

        let mut transfer = test_entry(namespace);
        transfer.action = "TRANSFER_CREDITS".into();
        transfer.object_id = "builder:alpha".into();
        transfer.author = "builder:alpha".into();
        transfer.payload = json!({"amount": 1_u64, "to_builder":"builder:beta"});
        let transfer_err = ledger
            .apply_entry(transfer)
            .expect_err("transfers should be rejected");
        assert!(transfer_err.to_string().contains("non-transferable"));

        let mut over_spend = test_entry(namespace);
        over_spend.action = "SPONSOR_USAGE".into();
        over_spend.object_id = "builder:alpha".into();
        over_spend.author = "builder:alpha".into();
        over_spend.payload =
            json!({"amount": 20_u64, "sponsorship_id":"spn-2", "sponsored_did":"did:ledger:user2"});
        let balance_err = ledger
            .apply_entry(over_spend)
            .expect_err("overspend should fail");
        assert!(balance_err
            .to_string()
            .contains("insufficient builder credits"));
    }

    #[test]
    fn enforces_builder_sponsorship_daily_limit_and_unique_sponsorship_id() {
        let ledger = Ledger::in_memory();
        let namespace = "builder.credits";
        ledger.bootstrap_namespaces(vec![namespace_with_rules(
            namespace,
            vec![NamespaceRule {
                name: "builder_credit_policy".into(),
                config: json!({"max_daily_spend": 25}),
            }],
        )]);

        let mut grant = test_entry(namespace);
        grant.action = "CREDIT_GRANT".into();
        grant.object_id = "builder:alpha".into();
        grant.author = "governance:ops".into();
        grant.payload = json!({"amount": 100_u64});
        ledger.apply_entry(grant).expect("grant should pass");

        let mut spend = test_entry(namespace);
        spend.action = "SPONSOR_USAGE".into();
        spend.object_id = "builder:alpha".into();
        spend.author = "builder:alpha".into();
        spend.payload = json!({"amount": 10_u64, "sponsorship_id":"dup-id", "sponsored_did":"did:ledger:user1"});
        ledger
            .apply_entry(spend.clone())
            .expect("first spend should pass");

        let duplicate_err = ledger
            .apply_entry(spend)
            .expect_err("duplicate sponsorship_id should fail");
        assert!(duplicate_err.to_string().contains("already been used"));

        let mut limit_breach = test_entry(namespace);
        limit_breach.action = "SPONSOR_USAGE".into();
        limit_breach.object_id = "builder:alpha".into();
        limit_breach.author = "builder:alpha".into();
        limit_breach.payload =
            json!({"amount": 20_u64, "sponsorship_id":"spn-3", "sponsored_did":"did:ledger:user3"});
        let limit_err = ledger
            .apply_entry(limit_breach)
            .expect_err("daily max spend should fail");
        assert!(limit_err
            .to_string()
            .contains("daily sponsored spend limit exceeded"));
    }
}
