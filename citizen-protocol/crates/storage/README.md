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

## 2. Benchmark harness

The repository already ships with `crates/storage/benches/rocksdb_adapter.rs`.
It seeds a fresh RocksDB instance, writes 1,000-entry batches, pre-populates a
read namespace, and then benchmarks both write throughput and read latency. If
you need to tune the workload (payload size, batch count, sample size, etc.),
edit this file directly—Criterion configuration for each phase is set near the
top of the benchmark.

## 3. Optional: tweak RocksDB defaults

`RocksDbStorage::open` in `crates/storage/src/lib.rs` now reads a handful of
environment variables so you can experiment without patching code:

| Variable | Example | Effect |
|----------|---------|--------|
| `ROCKSDB_COMPACTION_STYLE` | `universal` | Sets compaction to `level`, `universal`, or `fifo`. |
| `ROCKSDB_WRITE_BUFFER_MB` | `64` | Write buffer size in MiB. |
| `ROCKSDB_MAX_WRITE_BUFFER_NUMBER` | `4` | Number of memtables before flush. |
| `ROCKSDB_MIN_WRITE_BUFFER_NUMBER_TO_MERGE` | `2` | Memtables merged on flush. |
| `ROCKSDB_TARGET_FILE_SIZE_MB` | `64` | SST file target size in MiB. |
| `ROCKSDB_ENABLE_STATISTICS` | `true` | Enables RocksDB statistics collection. |

Set whichever variables you need before running the benchmark. Invalid values
are ignored with a warning so you can iterate quickly. Document any important
tuning choices in this README so the rest of the team can reproduce them.

## 4. Run the benchmarks

From the repository root:

```bash
# Run only the storage benchmarks
cargo bench -p citizen-storage --bench rocksdb_adapter

# To see Criterion reports, open the HTML output in your browser
open target/criterion/rocksdb_write_read/report/index.html   # macOS
xdg-open target/criterion/rocksdb_write_read/report/index.html  # Linux
```

Criterion will emit throughput/latency summaries on STDOUT and store detailed
reports under `target/criterion/`.

## 5. Explore compaction settings

Re-run the benchmark after changing RocksDB options to compare performance. Use
the environment variables listed above (e.g.,
`ROCKSDB_WRITE_BUFFER_MB=64 cargo bench ...`) to record multiple runs. Keep
notes on:

- Write throughput (ops/sec) and p95 latency
- Read throughput and latency
- Compaction style (level vs universal), write buffer size, and number of memtables
- Flush/compaction frequency observed in logs

## 6. Automating comparisons

For repeatable runs, use the helper script:

```bash
./scripts/run_rocksdb_bench.sh universal-64mb -- --sample-size 20
```

Set any tuning environment variables in front of the command (for example,
`ROCKSDB_COMPACTION_STYLE=universal`). The script wipes `target/criterion`, runs
the benchmark, and copies the Criterion output plus a metadata note into
`benchmark-results/<config-name>`. Each run is preserved so you can diff Criterion JSON
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
