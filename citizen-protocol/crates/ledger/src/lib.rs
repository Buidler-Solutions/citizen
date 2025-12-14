use citizen_crypto::{hash_block_header, parse_verifying_key, verify_commit_proof, KeyRegistry};
use citizen_storage::{LedgerStorage, MemoryStorage};
use citizen_types::{
    Block, BlockHeader, CommitProof, GovernanceProposal, LedgerEntry, NamespaceId,
    NamespaceRuleset, ProtocolError, ValidatorSetSnapshot,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::debug;

pub type Result<T> = std::result::Result<T, ProtocolError>;

pub struct Ledger<S: LedgerStorage + 'static> {
    storage: Arc<S>,
    namespace_rules: RwLock<HashMap<NamespaceId, NamespaceRuleset>>,
    key_registry: KeyRegistry,
}

impl<S: LedgerStorage + 'static> Ledger<S> {
    pub fn new(storage: Arc<S>, key_registry: KeyRegistry) -> Self {
        Self {
            storage,
            namespace_rules: RwLock::new(HashMap::new()),
            key_registry,
        }
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
            match rule.name.as_str() {
                "require_signature" => self.require_signature(entry)?,
                "prevent_double_transfer" => {
                    if let Some(object_id) = rule.config.get("object_id") {
                        let object = object_id.as_str().ok_or_else(|| {
                            ProtocolError::ValidationFailed("object id must be string".into())
                        })?;
                        self.ensure_unique_object(entry, object)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn require_signature(&self, entry: &LedgerEntry) -> Result<()> {
        if entry.signature.is_empty() {
            return Err(ProtocolError::ValidationFailed(
                "missing entry signature".into(),
            ));
        }
        Ok(())
    }

    fn ensure_unique_object(&self, entry: &LedgerEntry, object_field: &str) -> Result<()> {
        let entries = self.storage.namespace_entries(&entry.namespace)?;
        for existing in entries {
            if existing.object_id == entry.object_id && existing.entry_id != entry.entry_id {
                return Err(ProtocolError::ValidationFailed(format!(
                    "object {} already referenced in namespace {}",
                    entry.object_id, entry.namespace
                )));
            }
        }
        Ok(())
    }

    pub fn apply_entry(&self, entry: LedgerEntry) -> Result<()> {
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
