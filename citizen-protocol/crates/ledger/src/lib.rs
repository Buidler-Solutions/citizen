use citizen_crypto::{hash_block_header, parse_verifying_key, verify_commit_proof, KeyRegistry};
use citizen_storage::{LedgerStorage, MemoryStorage};
use citizen_types::{
    Block, GovernanceProposal, LedgerEntry, NamespaceId, NamespaceRuleset, ProtocolError,
    ValidatorSetSnapshot,
};
use parking_lot::RwLock;
use serde_json::Value;
use std::collections::HashMap;
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
}
