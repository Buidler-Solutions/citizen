use citizen_types::LedgerEntry;
use parking_lot::Mutex;
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct TxPool {
    inner: Arc<Mutex<TxPoolState>>,
    metrics: Arc<TxPoolMetrics>,
    capacity: usize,
}

#[derive(Debug, Default)]
struct TxPoolState {
    queue: VecDeque<LedgerEntry>,
    entry_ids: HashSet<Uuid>,
}

impl TxPool {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TxPoolState::default())),
            metrics: Arc::new(TxPoolMetrics::default()),
            capacity,
        }
    }

    pub fn enqueue(&self, entry: LedgerEntry) -> EnqueueResult {
        let mut state = self.inner.lock();
        if state.queue.len() >= self.capacity {
            self.metrics.enqueue_rejected_full_total.fetch_add(1, Ordering::Relaxed);
            return EnqueueResult::Full {
                entry_id: entry.entry_id,
                capacity: self.capacity,
            };
        }
        if !state.entry_ids.insert(entry.entry_id) {
            self.metrics
                .enqueue_rejected_duplicate_total
                .fetch_add(1, Ordering::Relaxed);
            return EnqueueResult::Duplicate {
                entry_id: entry.entry_id,
            };
        }

        let entry_id = entry.entry_id;
        state.queue.push_back(entry);
        self.metrics.enqueued_total.fetch_add(1, Ordering::Relaxed);
        EnqueueResult::Queued { entry_id }
    }

    pub fn drain(&self, max: usize) -> Vec<LedgerEntry> {
        if max == 0 {
            return Vec::new();
        }

        let mut state = self.inner.lock();
        let mut drained = Vec::with_capacity(max.min(state.queue.len()));
        for _ in 0..max {
            let Some(entry) = state.queue.pop_front() else {
                break;
            };
            state.entry_ids.remove(&entry.entry_id);
            drained.push(entry);
        }
        if !drained.is_empty() {
            self.metrics
                .drained_total
                .fetch_add(drained.len() as u64, Ordering::Relaxed);
        }
        drained
    }

    pub fn len(&self) -> usize {
        self.inner.lock().queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn metrics_snapshot(&self) -> TxPoolMetricsSnapshot {
        TxPoolMetricsSnapshot {
            queue_len: self.len() as u64,
            capacity: self.capacity as u64,
            enqueued_total: self.metrics.enqueued_total.load(Ordering::Relaxed),
            drained_total: self.metrics.drained_total.load(Ordering::Relaxed),
            enqueue_rejected_duplicate_total: self
                .metrics
                .enqueue_rejected_duplicate_total
                .load(Ordering::Relaxed),
            enqueue_rejected_full_total: self
                .metrics
                .enqueue_rejected_full_total
                .load(Ordering::Relaxed),
        }
    }
}

impl Default for TxPool {
    fn default() -> Self {
        Self::with_capacity(10_000)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnqueueResult {
    Queued { entry_id: Uuid },
    Duplicate { entry_id: Uuid },
    Full { entry_id: Uuid, capacity: usize },
}

#[derive(Debug, Default)]
struct TxPoolMetrics {
    enqueued_total: AtomicU64,
    drained_total: AtomicU64,
    enqueue_rejected_duplicate_total: AtomicU64,
    enqueue_rejected_full_total: AtomicU64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TxPoolMetricsSnapshot {
    pub queue_len: u64,
    pub capacity: u64,
    pub enqueued_total: u64,
    pub drained_total: u64,
    pub enqueue_rejected_duplicate_total: u64,
    pub enqueue_rejected_full_total: u64,
}

#[cfg(test)]
mod tests {
    use super::{EnqueueResult, TxPool};
    use citizen_types::LedgerEntry;
    use serde_json::json;
    use uuid::Uuid;

    fn fixture_entry(id: Uuid) -> LedgerEntry {
        serde_json::from_value(json!({
            "entry_id": id,
            "namespace": "registry.land",
            "action": "TRANSFER_OWNERSHIP",
            "object_id": format!("LOT-{id}"),
            "payload": {"from":"did:A","to":"did:B"},
            "author": "did:A",
            "signature": "sig",
            "timestamp": 1736500000
        }))
        .expect("valid entry fixture")
    }

    #[test]
    fn enqueue_then_drain_preserves_fifo_order() {
        let pool = TxPool::default();
        let first = fixture_entry(Uuid::new_v4());
        let second = fixture_entry(Uuid::new_v4());

        assert_eq!(
            pool.enqueue(first.clone()),
            EnqueueResult::Queued {
                entry_id: first.entry_id
            }
        );
        assert_eq!(
            pool.enqueue(second.clone()),
            EnqueueResult::Queued {
                entry_id: second.entry_id
            }
        );

        let drained = pool.drain(10);
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].entry_id, first.entry_id);
        assert_eq!(drained[1].entry_id, second.entry_id);
    }

    #[test]
    fn duplicate_entry_ids_are_rejected_until_drained() {
        let pool = TxPool::default();
        let entry = fixture_entry(Uuid::new_v4());

        assert_eq!(
            pool.enqueue(entry.clone()),
            EnqueueResult::Queued {
                entry_id: entry.entry_id
            }
        );
        assert_eq!(
            pool.enqueue(entry.clone()),
            EnqueueResult::Duplicate {
                entry_id: entry.entry_id
            }
        );

        let drained = pool.drain(1);
        assert_eq!(drained.len(), 1);
        assert_eq!(
            pool.enqueue(entry.clone()),
            EnqueueResult::Queued {
                entry_id: entry.entry_id
            }
        );
    }

    #[test]
    fn drain_respects_max_batch_size() {
        let pool = TxPool::default();
        let entries = vec![
            fixture_entry(Uuid::new_v4()),
            fixture_entry(Uuid::new_v4()),
            fixture_entry(Uuid::new_v4()),
        ];

        for entry in &entries {
            assert_eq!(
                pool.enqueue(entry.clone()),
                EnqueueResult::Queued {
                    entry_id: entry.entry_id
                }
            );
        }

        let first_batch = pool.drain(2);
        assert_eq!(first_batch.len(), 2);
        assert_eq!(first_batch[0].entry_id, entries[0].entry_id);
        assert_eq!(first_batch[1].entry_id, entries[1].entry_id);
        assert_eq!(pool.len(), 1);

        let second_batch = pool.drain(2);
        assert_eq!(second_batch.len(), 1);
        assert_eq!(second_batch[0].entry_id, entries[2].entry_id);
        assert!(pool.is_empty());
    }

    #[test]
    fn enqueue_rejects_when_pool_is_full() {
        let pool = TxPool::with_capacity(1);
        let first = fixture_entry(Uuid::new_v4());
        let second = fixture_entry(Uuid::new_v4());

        assert_eq!(
            pool.enqueue(first.clone()),
            EnqueueResult::Queued {
                entry_id: first.entry_id
            }
        );
        assert_eq!(
            pool.enqueue(second.clone()),
            EnqueueResult::Full {
                entry_id: second.entry_id,
                capacity: 1
            }
        );
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn metrics_track_enqueue_drain_and_rejections() {
        let pool = TxPool::with_capacity(2);
        let first = fixture_entry(Uuid::new_v4());
        let second = fixture_entry(Uuid::new_v4());
        let third = fixture_entry(Uuid::new_v4());

        assert_eq!(
            pool.enqueue(first.clone()),
            EnqueueResult::Queued {
                entry_id: first.entry_id
            }
        );
        assert_eq!(
            pool.enqueue(first.clone()),
            EnqueueResult::Duplicate {
                entry_id: first.entry_id
            }
        );
        assert_eq!(
            pool.enqueue(second.clone()),
            EnqueueResult::Queued {
                entry_id: second.entry_id
            }
        );
        assert_eq!(
            pool.enqueue(third.clone()),
            EnqueueResult::Full {
                entry_id: third.entry_id,
                capacity: 2
            }
        );

        let drained = pool.drain(2);
        assert_eq!(drained.len(), 2);

        let metrics = pool.metrics_snapshot();
        assert_eq!(metrics.queue_len, 0);
        assert_eq!(metrics.capacity, 2);
        assert_eq!(metrics.enqueued_total, 2);
        assert_eq!(metrics.drained_total, 2);
        assert_eq!(metrics.enqueue_rejected_duplicate_total, 1);
        assert_eq!(metrics.enqueue_rejected_full_total, 1);
    }
}
