use citizen_types::{
    Block, BlockHeight, GovernanceProposal, LedgerEntry, NamespaceDescriptor, NamespaceId,
    ProtocolError, ValidatorId, ValidatorMetadata, ValidatorSetSnapshot,
};
use parking_lot::RwLock;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use rocksdb::{ColumnFamilyDescriptor, Options, WriteBatch, DB};

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

fn serialize<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
    bincode::serialize(value).map_err(ProtocolError::storage)
}

fn deserialize<T: for<'de> serde::Deserialize<'de>>(bytes: &[u8]) -> Result<T> {
    bincode::deserialize(bytes).map_err(ProtocolError::storage)
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

#[derive(Clone)]
pub struct RocksDbStorage {
    db: Arc<DB>,
}

const CF_BLOCKS: &str = "blocks";
const CF_ENTRIES: &str = "entries";
const CF_NAMESPACES: &str = "namespaces";
const CF_VALIDATORS: &str = "validators";
const CF_GOVERNANCE: &str = "governance";

impl RocksDbStorage {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.set_max_open_files(128);
        opts.set_keep_log_file_num(10);
        opts.set_max_manifest_file_size(16 * 1024 * 1024);
        opts.set_info_log_level(rocksdb::LogLevel::Info);
        opts.set_ratelimiter_with_auto_tuned(32 * 1024 * 1024, Duration::from_secs(1))
            .map_err(ProtocolError::storage)?;

        let cf_descriptors = vec![
            ColumnFamilyDescriptor::new(CF_BLOCKS, Options::default()),
            ColumnFamilyDescriptor::new(CF_ENTRIES, Options::default()),
            ColumnFamilyDescriptor::new(CF_NAMESPACES, Options::default()),
            ColumnFamilyDescriptor::new(CF_VALIDATORS, Options::default()),
            ColumnFamilyDescriptor::new(CF_GOVERNANCE, Options::default()),
        ];

        let db =
            DB::open_cf_descriptors(&opts, path, cf_descriptors).map_err(ProtocolError::storage)?;

        Ok(Self { db: Arc::new(db) })
    }

    fn put_cf<T: serde::Serialize>(
        &self,
        cf: &str,
        key: impl AsRef<[u8]>,
        value: &T,
    ) -> Result<()> {
        let cf_handle = self
            .db
            .cf_handle(cf)
            .ok_or_else(|| ProtocolError::storage("missing column family"))?;
        let bytes = serialize(value)?;
        self.db
            .put_cf(cf_handle, key, bytes)
            .map_err(ProtocolError::storage)
    }

    fn get_cf<T: for<'de> serde::Deserialize<'de>>(
        &self,
        cf: &str,
        key: impl AsRef<[u8]>,
    ) -> Result<Option<T>> {
        let cf_handle = self
            .db
            .cf_handle(cf)
            .ok_or_else(|| ProtocolError::storage("missing column family"))?;
        let bytes = self
            .db
            .get_cf(cf_handle, key)
            .map_err(ProtocolError::storage)?;
        bytes.map(|b| deserialize(&b)).transpose()
    }

    fn prefix_scan<T: for<'de> serde::Deserialize<'de>>(
        &self,
        cf: &str,
        prefix: &[u8],
    ) -> Result<Vec<T>> {
        let cf_handle = self
            .db
            .cf_handle(cf)
            .ok_or_else(|| ProtocolError::storage("missing column family"))?;
        let iter = self
            .db
            .prefix_iterator_cf(cf_handle, prefix)
            .map_err(ProtocolError::storage)?;
        let mut out = Vec::new();
        for item in iter {
            let (_, value) = item.map_err(ProtocolError::storage)?;
            out.push(deserialize(&value)?);
        }
        Ok(out)
    }
}

fn height_key(height: BlockHeight) -> [u8; 8] {
    height.to_be_bytes()
}

fn namespaced_entry_key(namespace: &NamespaceId, entry: &LedgerEntry) -> Vec<u8> {
    let mut key = namespace.as_bytes().to_vec();
    key.push(0x1f);
    key.extend(entry.entry_id.as_bytes());
    key
}

impl LedgerStorage for RocksDbStorage {
    fn store_block(&self, block: Block) -> Result<()> {
        self.put_cf(CF_BLOCKS, height_key(block.header.height), &block)
    }

    fn get_block(&self, height: BlockHeight) -> Result<Option<Block>> {
        self.get_cf(CF_BLOCKS, height_key(height))
    }

    fn latest_height(&self) -> Result<BlockHeight> {
        let cf = self
            .db
            .cf_handle(CF_BLOCKS)
            .ok_or_else(|| ProtocolError::storage("missing column family"))?;
        let mut iter = self.db.iterator_cf(cf, rocksdb::IteratorMode::End);
        if let Some(Ok((key, _))) = iter.next() {
            let mut array = [0u8; 8];
            array.copy_from_slice(&key);
            Ok(u64::from_be_bytes(array))
        } else {
            Ok(0)
        }
    }

    fn store_entry(&self, entry: LedgerEntry) -> Result<()> {
        let key = namespaced_entry_key(&entry.namespace, &entry);
        self.put_cf(CF_ENTRIES, key, &entry)
    }

    fn namespace_entries(&self, namespace: &NamespaceId) -> Result<Vec<LedgerEntry>> {
        self.prefix_scan(CF_ENTRIES, namespace.as_bytes())
    }

    fn upsert_namespace(&self, descriptor: NamespaceDescriptor) -> Result<()> {
        self.put_cf(CF_NAMESPACES, descriptor.namespace.as_bytes(), &descriptor)
    }

    fn namespace_registry(&self) -> Result<Vec<NamespaceDescriptor>> {
        let cf = self
            .db
            .cf_handle(CF_NAMESPACES)
            .ok_or_else(|| ProtocolError::storage("missing column family"))?;
        let iter = self
            .db
            .iterator_cf(cf, rocksdb::IteratorMode::Start)
            .map_err(ProtocolError::storage)?;
        let mut out = Vec::new();
        for item in iter {
            let (_, value) = item.map_err(ProtocolError::storage)?;
            out.push(deserialize(&value)?);
        }
        Ok(out)
    }

    fn store_validator_set(&self, snapshot: ValidatorSetSnapshot) -> Result<()> {
        let key = height_key(snapshot.height);
        let mut batch = WriteBatch::default();
        let cf = self
            .db
            .cf_handle(CF_VALIDATORS)
            .ok_or_else(|| ProtocolError::storage("missing column family"))?;
        batch.put_cf(cf, key, serialize(&snapshot)?);
        self.db.write(batch).map_err(ProtocolError::storage)
    }

    fn latest_validator_set(&self) -> Result<Option<ValidatorSetSnapshot>> {
        let cf = self
            .db
            .cf_handle(CF_VALIDATORS)
            .ok_or_else(|| ProtocolError::storage("missing column family"))?;
        let mut iter = self.db.iterator_cf(cf, rocksdb::IteratorMode::End);
        if let Some(Ok((_, value))) = iter.next() {
            Ok(Some(deserialize(&value)?))
        } else {
            Ok(None)
        }
    }

    fn track_governance_proposal(&self, proposal: GovernanceProposal) -> Result<()> {
        self.put_cf(CF_GOVERNANCE, proposal.proposal_id.as_bytes(), &proposal)
    }

    fn governance_proposals(&self) -> Result<Vec<GovernanceProposal>> {
        let cf = self
            .db
            .cf_handle(CF_GOVERNANCE)
            .ok_or_else(|| ProtocolError::storage("missing column family"))?;
        let iter = self
            .db
            .iterator_cf(cf, rocksdb::IteratorMode::Start)
            .map_err(ProtocolError::storage)?;
        let mut out = Vec::new();
        for item in iter {
            let (_, value) = item.map_err(ProtocolError::storage)?;
            out.push(deserialize(&value)?);
        }
        Ok(out)
    }
}
