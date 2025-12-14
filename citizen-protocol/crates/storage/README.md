# RocksDB benchmarking guide

This guide explains how to benchmark the `RocksDbStorage` adapter located in
`crates/storage/src/lib.rs` using Criterion on your own machine. It assumes you
have a working Rust toolchain (Rust 1.74+ recommended) and RocksDB development
headers available.

## 1. Install prerequisites

- **Rust toolchain**: Install via `rustup` if not already available.
- **RocksDB dependencies**: On Debian/Ubuntu, install build tooling and
  compression libraries that the `rocksdb` crate links against:

  ```bash
  sudo apt-get update
  sudo apt-get install -y build-essential libclang-dev clang pkg-config \
      libssl-dev zlib1g-dev libsnappy-dev liblz4-dev libzstd-dev
  ```

  macOS users can install RocksDB and compression libraries with Homebrew:

  ```bash
  brew install rocksdb snappy lz4 zstd
  ```

## 2. Add the benchmark harness

1. Create a new Criterion benchmark target in `crates/storage/benches/` called
   `rocksdb_adapter.rs`:

   ```rust
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
   ```

   This harness writes batches of 1,000 entries and measures both write and read
   performance. Adjust `measurement_time` and payload size to match your
   workloads.

2. Add Criterion and rand to `crates/storage/Cargo.toml` under `[dev-dependencies]`:

   ```toml
   [dev-dependencies]
   criterion = { version = "0.5", default-features = false, features = ["cargo_bench_support"] }
   rand = { version = "0.8", features = ["std", "std_rng"] }
   tempfile = "3"
   ```

3. Tell Cargo about the benchmark target by appending to `crates/storage/Cargo.toml`:

   ```toml
   [[bench]]
   name = "rocksdb_adapter"
   harness = false
   ```

## 3. Optional: tweak RocksDB defaults

`RocksDbStorage::open` in `crates/storage/src/lib.rs` currently sets a few
baseline options. You can experiment with compaction and write-buffer tuning by
adding options before opening the database, for example:

```rust
opts.set_compaction_style(rocksdb::DBCompactionStyle::Universal);
opts.set_write_buffer_size(64 * 1024 * 1024); // 64 MiB
opts.set_max_write_buffer_number(4);
opts.set_target_file_size_base(64 * 1024 * 1024);
```

Document any changes you keep in this file or in `crates/storage/README.md` so
team members know the defaults you picked.

## 4. Run the benchmarks

From the repository root:

```bash
# Run only the storage benchmarks
cargo bench -p storage --bench rocksdb_adapter

# To see Criterion reports, open the HTML output in your browser
open target/criterion/rocksdb_write_read/report/index.html  # macOS
xdg-open target/criterion/rocksdb_write_read/report/index.html  # Linux
```

Criterion will emit throughput/latency summaries on STDOUT and store detailed
reports under `target/criterion/`.

## 5. Explore compaction settings

Re-run the benchmark after changing RocksDB options to compare performance. You
can use environment variables or simple CLI flags (e.g., `WRITE_BUFFER_MB=64
cargo bench ...`) to record multiple runs. Keep notes on:

- Write throughput (ops/sec) and p95 latency
- Read throughput and latency
- Compaction style (level vs universal), write buffer size, and number of memtables
- Flush/compaction frequency observed in logs

## 6. Automating comparisons

For repeatable runs, script the benchmark with a small helper such as:

```bash
#!/usr/bin/env bash
set -euo pipefail
cfg="$1"  # e.g., level-default or universal-64mb
export ROCKSDB_WRITE_BUFFER_MB=64
cargo bench -p storage --bench rocksdb_adapter -- --sample-size 15
cp -r target/criterion "benchmark-results/${cfg}"
```

Each run is preserved under `benchmark-results/` so you can diff Criterion JSON
reports or HTML outputs.

## 7. Cleaning up

Temporary RocksDB data lives in `/tmp` when using `tempfile::tempdir()`. Criterion
artifacts accumulate in `target/criterion/`; remove them between runs if you need
fresh measurements:

```bash
rm -rf target/criterion
```

Following these steps will give you reproducible RocksDB read/write benchmarks
and a clear place to record the settings that work best for your environment.
