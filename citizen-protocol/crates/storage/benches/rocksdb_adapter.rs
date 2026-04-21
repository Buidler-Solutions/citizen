use std::env;
use std::time::Duration;

use citizen_types::{LedgerEntry, NamespaceId, PrivacyMode};
use criterion::{criterion_group, criterion_main, BatchSize, Criterion, SamplingMode, Throughput};
use rand::{rngs::StdRng, Rng, SeedableRng};
use serde_json::json;
use uuid::Uuid;

use citizen_storage::{LedgerStorage, RocksDbStorage};

const WRITE_BATCH_SIZE: usize = 1_000;
const READ_PREFILL: usize = 2_000;

fn rand_entry(rng: &mut StdRng, namespace: &NamespaceId) -> LedgerEntry {
    let bytes: Vec<u8> = (0..256).map(|_| rng.gen()).collect();
    LedgerEntry {
        entry_id: Uuid::from_u128(rng.gen()),
        namespace: namespace.clone(),
        action: "WRITE".to_string(),
        object_id: format!("object-{}", rng.gen::<u64>()),
        payload: json!({ "blob": bytes }),
        privacy_flag: false,
        privacy_mode: PrivacyMode::None,
        payload_commitment: None,
        ciphertext_hex: None,
        nonce_hex: None,
        salt_hex: None,
        kdf_params: None,
        consent_receipt: None,
        authorized_readers: Vec::new(),
        custodian_policy_id: None,
        field_reader_acls: Default::default(),
        key_wrapped_secrets: Vec::new(),
        revocation_events: Vec::new(),
        author: format!("did:bench:{}", rng.gen::<u32>()),
        signature: format!("sig-{}", rng.gen::<u64>()),
        timestamp: rng.gen_range(1_700_000_000i64..1_800_000_000i64),
    }
}

fn bench_write_then_read(c: &mut Criterion) {
    let tmpdir = tempfile::tempdir().unwrap();
    let store = RocksDbStorage::open(tmpdir.path()).unwrap();
    let mut rng = StdRng::seed_from_u64(42);

    println!(
        "rocksdb benchmark: style={:?} write_buffer_mb={:?} max_write_buffers={:?} target_file_size_mb={:?}",
        env::var("ROCKSDB_COMPACTION_STYLE").ok(),
        env::var("ROCKSDB_WRITE_BUFFER_MB").ok(),
        env::var("ROCKSDB_MAX_WRITE_BUFFER_NUMBER").ok(),
        env::var("ROCKSDB_TARGET_FILE_SIZE_MB").ok()
    );

    let mut group = c.benchmark_group("rocksdb_write_read");
    group.sample_size(30);
    group.sampling_mode(SamplingMode::Flat);
    group.measurement_time(Duration::from_secs(15));
    group.throughput(Throughput::Elements(WRITE_BATCH_SIZE as u64));

    group.bench_function("write_batch_1k", |b| {
        b.iter_batched(
            || {
                let namespace: NamespaceId = format!("bench-write-{}", rng.gen::<u64>());
                (0..WRITE_BATCH_SIZE)
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

    let read_namespace: NamespaceId = "bench-read".to_string();
    if store.namespace_entries(&read_namespace).unwrap().is_empty() {
        for _ in 0..READ_PREFILL {
            store
                .store_entry(rand_entry(&mut rng, &read_namespace))
                .unwrap();
        }
    }

    group.throughput(Throughput::Elements(READ_PREFILL as u64));
    group.sample_size(25);
    group.measurement_time(Duration::from_secs(8));
    group.bench_function("read_latest", |b| {
        b.iter(|| {
            let _ = store.namespace_entries(&read_namespace).unwrap();
        });
    });

    group.finish();
}

criterion_group!(benches, bench_write_then_read);
criterion_main!(benches);
