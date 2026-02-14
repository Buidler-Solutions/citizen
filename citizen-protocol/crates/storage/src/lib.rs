use citizen_types::{
    Block, BlockHeight, DeterministicReceipt, GovernanceProposal, LedgerEntry, NamespaceDescriptor,
    NamespaceId, ProtocolError, ValidatorId, ValidatorSetSnapshot,
};
use lru::LruCache;
use parking_lot::RwLock;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::num::NonZeroUsize;
use std::str::FromStr;
use std::sync::Arc;
use uuid::Uuid;

use rocksdb::{ColumnFamilyDescriptor, DBCompactionStyle, Options, WriteBatch, DB};

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
    fn store_receipt(&self, receipt: DeterministicReceipt) -> Result<()>;
    fn get_receipt(&self, receipt_id: Uuid) -> Result<Option<DeterministicReceipt>>;
}

fn serialize<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(ProtocolError::storage)
}

fn deserialize<T: for<'de> serde::Deserialize<'de>>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(ProtocolError::storage)
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
    receipts: BTreeMap<Uuid, DeterministicReceipt>,
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

    fn store_receipt(&self, receipt: DeterministicReceipt) -> Result<()> {
        self.inner
            .write()
            .receipts
            .insert(receipt.receipt_id, receipt);
        Ok(())
    }

    fn get_receipt(&self, receipt_id: Uuid) -> Result<Option<DeterministicReceipt>> {
        Ok(self.inner.read().receipts.get(&receipt_id).cloned())
    }
}

#[derive(Clone)]
pub struct RocksDbStorage {
    db: Arc<DB>,
    block_cache: Arc<RwLock<LruCache<BlockHeight, Block>>>,
}

const CF_BLOCKS: &str = "blocks";
const CF_ENTRIES: &str = "entries";
const CF_NAMESPACES: &str = "namespaces";
const CF_VALIDATORS: &str = "validators";
const CF_GOVERNANCE: &str = "governance";
const CF_RECEIPTS: &str = "receipts";

fn parse_env<T>(key: &str) -> Option<T>
where
    T: FromStr,
{
    match env::var(key) {
        Ok(value) => match value.parse::<T>() {
            Ok(parsed) => Some(parsed),
            Err(_) => {
                eprintln!("RocksDB: ignoring invalid value for {}={}", key, value);
                None
            }
        },
        Err(_) => None,
    }
}

fn apply_env_overrides(opts: &mut Options) {
    if let Ok(style_raw) = env::var("ROCKSDB_COMPACTION_STYLE") {
        let style = style_raw.to_ascii_lowercase();
        let compaction = match style.as_str() {
            "level" => Some(DBCompactionStyle::Level),
            "universal" => Some(DBCompactionStyle::Universal),
            "fifo" => Some(DBCompactionStyle::Fifo),
            _ => {
                eprintln!(
                    "RocksDB: unknown compaction style '{}'; expected level|universal|fifo",
                    style_raw
                );
                None
            }
        };
        if let Some(style) = compaction {
            opts.set_compaction_style(style);
        }
    }

    if let Some(write_mb) = parse_env::<u64>("ROCKSDB_WRITE_BUFFER_MB") {
        let bytes = write_mb.saturating_mul(1024 * 1024);
        opts.set_write_buffer_size(bytes as usize);
    }

    if let Some(memtables) = parse_env::<u32>("ROCKSDB_MAX_WRITE_BUFFER_NUMBER") {
        opts.set_max_write_buffer_number(memtables as i32);
    }

    if let Some(target_mb) = parse_env::<u64>("ROCKSDB_TARGET_FILE_SIZE_MB") {
        let bytes = target_mb.saturating_mul(1024 * 1024);
        opts.set_target_file_size_base(bytes);
    }

    if let Some(min_merge) = parse_env::<u32>("ROCKSDB_MIN_WRITE_BUFFER_NUMBER_TO_MERGE") {
        opts.set_min_write_buffer_number_to_merge(min_merge as i32);
    }

    if let Ok(enabled) = env::var("ROCKSDB_ENABLE_STATISTICS") {
        if matches!(enabled.to_ascii_lowercase().as_str(), "1" | "true" | "yes") {
            opts.enable_statistics();
        }
    }
}

impl RocksDbStorage {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.create_missing_column_families(true);
        opts.set_max_open_files(128);
        opts.set_keep_log_file_num(10);
        opts.set_max_manifest_file_size(16 * 1024 * 1024);
        opts.set_log_level(rocksdb::LogLevel::Info);
        opts.set_ratelimiter(32 * 1024 * 1024, 1_000_000, 10);
        apply_env_overrides(&mut opts);

        let cf_descriptors = vec![
            ColumnFamilyDescriptor::new(CF_BLOCKS, Options::default()),
            ColumnFamilyDescriptor::new(CF_ENTRIES, Options::default()),
            ColumnFamilyDescriptor::new(CF_NAMESPACES, Options::default()),
            ColumnFamilyDescriptor::new(CF_VALIDATORS, Options::default()),
            ColumnFamilyDescriptor::new(CF_GOVERNANCE, Options::default()),
            ColumnFamilyDescriptor::new(CF_RECEIPTS, Options::default()),
        ];

        let db =
            DB::open_cf_descriptors(&opts, path, cf_descriptors).map_err(ProtocolError::storage)?;

        let block_cache = LruCache::new(block_cache_capacity());
        Ok(Self {
            db: Arc::new(db),
            block_cache: Arc::new(RwLock::new(block_cache)),
        })
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
        let iter = self.db.prefix_iterator_cf(cf_handle, prefix);
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

fn block_cache_capacity() -> NonZeroUsize {
    const DEFAULT_CAPACITY: usize = 1_024;
    let fallback = NonZeroUsize::new(DEFAULT_CAPACITY).expect("DEFAULT_CAPACITY must be non-zero");
    match parse_env::<usize>("ROCKSDB_BLOCK_CACHE_SIZE") {
        Some(value) => {
            if let Some(non_zero) = NonZeroUsize::new(value) {
                non_zero
            } else {
                eprintln!(
                    "RocksDB: ignoring invalid value for ROCKSDB_BLOCK_CACHE_SIZE={}",
                    value
                );
                fallback
            }
        }
        None => fallback,
    }
}

fn namespaced_entry_key(namespace: &NamespaceId, entry: &LedgerEntry) -> Vec<u8> {
    let mut key = namespace.as_bytes().to_vec();
    key.push(0x1f);
    key.extend(entry.entry_id.as_bytes());
    key
}

impl LedgerStorage for RocksDbStorage {
    fn store_block(&self, block: Block) -> Result<()> {
        let height = block.header.height;
        self.put_cf(CF_BLOCKS, height_key(height), &block)?;
        self.block_cache.write().put(height, block);
        Ok(())
    }

    fn get_block(&self, height: BlockHeight) -> Result<Option<Block>> {
        if let Some(block) = self.block_cache.write().get(&height).cloned() {
            return Ok(Some(block));
        }
        let block: Option<Block> = self.get_cf(CF_BLOCKS, height_key(height))?;
        if let Some(ref block) = block {
            self.block_cache.write().put(height, block.clone());
        }
        Ok(block)
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
        let iter = self.db.iterator_cf(cf, rocksdb::IteratorMode::Start);
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
        let iter = self.db.iterator_cf(cf, rocksdb::IteratorMode::Start);
        let mut out = Vec::new();
        for item in iter {
            let (_, value) = item.map_err(ProtocolError::storage)?;
            out.push(deserialize(&value)?);
        }
        Ok(out)
    }

    fn store_receipt(&self, receipt: DeterministicReceipt) -> Result<()> {
        self.put_cf(CF_RECEIPTS, receipt.receipt_id.as_bytes(), &receipt)
    }

    fn get_receipt(&self, receipt_id: Uuid) -> Result<Option<DeterministicReceipt>> {
        self.get_cf(CF_RECEIPTS, receipt_id.as_bytes())
    }
}
