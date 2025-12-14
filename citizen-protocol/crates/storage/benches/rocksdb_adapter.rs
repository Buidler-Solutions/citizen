use std::sync::Arc;
use std::time::Duration;

use citizen_types::{LedgerEntry, NamespaceId};
use criterion::{criterion_group, criterion_main, BatchSize, Criterion, SamplingMode};
use rand::{rngs::StdRng, Rng, SeedableRng};

use storage::RocksDbStorage;

fn rand_entry(rng: &mut StdRng, namespace: &NamespaceId) -> LedgerEntry {
    let bytes: Vec<u8> = (0..256).map(|_| rng.gen()).collect();
    LedgerEntry {
        namespace: namespace.clone(),
        entry_id: format!("entry-{}", rng.gen::<u64>()),
        payload: bytes,
    }
}

fn bench_write_then_read(c: &mut Criterion) {
    let tmpdir = tempfile::tempdir().unwrap();
    let store = RocksDbStorage::open(tmpdir.path()).unwrap();
    let namespace = NamespaceId::from("bench-namespace");
    let mut rng = StdRng::seed_from_u64(42);

    let mut group = c.benchmark_group("rocksdb_write_read");
    group.sampling_mode(SamplingMode::Flat);
    group.measurement_time(Duration::from_secs(20));

    group.bench_function("write_batch_1k", |b| {
        b.iter_batched(
            || {
                (0..1000)
                    .map(|_| rand_entry(&mut rng, &namespace))
                    .collect::<Vec<_>>()
            },
            |entries| {
                for entry in entries {
                    store.store_entry(entry).unwrap();
                }
            },
            BatchSize::SmallInput,
        );
    });

    group.bench_function("read_latest", |b| {
        b.iter(|| {
            let _ = store.namespace_entries(&namespace).unwrap();
        });
    });

    group.finish();
}

criterion_group!(benches, bench_write_then_read);
criterion_main!(benches);
