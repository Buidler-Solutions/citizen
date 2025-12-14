use citizen_types::{
    Block, BlockHeight, GovernanceProposal, LedgerEntry, NamespaceDescriptor, NamespaceId,
    ProtocolError, ValidatorId, ValidatorMetadata, ValidatorSetSnapshot,
};
use parking_lot::RwLock;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

pub type Result<T> = std::result::Result<T, ProtocolError>;

pub trait LedgerStorage: Send + Sync {
    fn store_block(&self, block: Block) -> Result<()>;
    fn get_block(&self, height: BlockHeight) -> Result<Option<Block>>;
    fn latest_height(&self) -> Result<BlockHeight>;
    fn store_entry(&self, entry: LedgerEntry) -> Result<()>;
    fn namespace_entries(&self, namespace: &NamespaceId) -> Result<Vec<LedgerEntry>>;
    fn upsert_namespace(&self, descriptor: NamespaceDescriptor) -> Result<()>;
    fn namespace_registry(&self) -> Result<Vec<NamespaceDescriptor>>;
    fn store_validator_set(&self, snapshot: ValidatorSetSnapshot) -> Result<()>;
    fn latest_validator_set(&self) -> Result<Option<ValidatorSetSnapshot>>;
    fn track_governance_proposal(&self, proposal: GovernanceProposal) -> Result<()>;
    fn governance_proposals(&self) -> Result<Vec<GovernanceProposal>>;
}

#[derive(Clone, Default)]
pub struct MemoryStorage {
    inner: Arc<RwLock<Inner>>,
}

#[derive(Default)]
struct Inner {
    blocks: BTreeMap<BlockHeight, Block>,
    entries: BTreeMap<NamespaceId, Vec<LedgerEntry>>,
    namespaces: BTreeMap<NamespaceId, NamespaceDescriptor>,
    validator_sets: BTreeMap<BlockHeight, ValidatorSetSnapshot>,
    governance: BTreeMap<String, GovernanceProposal>,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn validator_ids(&self) -> Result<BTreeSet<ValidatorId>> {
        let guard = self.inner.read();
        let mut set = BTreeSet::new();
        if let Some((_, snapshot)) = guard.validator_sets.iter().next_back() {
            for (id, _) in &snapshot.validators {
                set.insert(id.clone());
            }
        }
        Ok(set)
    }
}

impl LedgerStorage for MemoryStorage {
    fn store_block(&self, block: Block) -> Result<()> {
        let height = block.header.height;
        self.inner.write().blocks.insert(height, block);
        Ok(())
    }

    fn get_block(&self, height: BlockHeight) -> Result<Option<Block>> {
        Ok(self.inner.read().blocks.get(&height).cloned())
    }

    fn latest_height(&self) -> Result<BlockHeight> {
        Ok(self
            .inner
            .read()
            .blocks
            .keys()
            .next_back()
            .copied()
            .unwrap_or_default())
    }

    fn store_entry(&self, entry: LedgerEntry) -> Result<()> {
        self.inner
            .write()
            .entries
            .entry(entry.namespace.clone())
            .or_default()
            .push(entry);
        Ok(())
    }

    fn namespace_entries(&self, namespace: &NamespaceId) -> Result<Vec<LedgerEntry>> {
        Ok(self
            .inner
            .read()
            .entries
            .get(namespace)
            .cloned()
            .unwrap_or_default())
    }

    fn upsert_namespace(&self, descriptor: NamespaceDescriptor) -> Result<()> {
        self.inner
            .write()
            .namespaces
            .insert(descriptor.namespace.clone(), descriptor);
        Ok(())
    }

    fn namespace_registry(&self) -> Result<Vec<NamespaceDescriptor>> {
        Ok(self.inner.read().namespaces.values().cloned().collect())
    }

    fn store_validator_set(&self, snapshot: ValidatorSetSnapshot) -> Result<()> {
        self.inner
            .write()
            .validator_sets
            .insert(snapshot.height, snapshot);
        Ok(())
    }

    fn latest_validator_set(&self) -> Result<Option<ValidatorSetSnapshot>> {
        Ok(self
            .inner
            .read()
            .validator_sets
            .iter()
            .next_back()
            .map(|(_, snapshot)| snapshot.clone()))
    }

    fn track_governance_proposal(&self, proposal: GovernanceProposal) -> Result<()> {
        self.inner
            .write()
            .governance
            .insert(proposal.proposal_id.clone(), proposal);
        Ok(())
    }

    fn governance_proposals(&self) -> Result<Vec<GovernanceProposal>> {
        Ok(self.inner.read().governance.values().cloned().collect())
    }
}
