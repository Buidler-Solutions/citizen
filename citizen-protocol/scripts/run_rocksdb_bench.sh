#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <config-name> [-- <extra cargo bench args>]" >&2
  exit 1
fi

cfg="$1"
shift || true

extra_args=()
if [[ $# -gt 0 ]]; then
  if [[ "$1" == "--" ]]; then
    shift
  fi
  if [[ $# -gt 0 ]]; then
    extra_args=("$@")
  fi
fi

results_dir="benchmark-results/${cfg}"

echo "==> Running RocksDB benchmark for config '${cfg}'"
echo "    ROCKSDB_COMPACTION_STYLE=${ROCKSDB_COMPACTION_STYLE:-}"
echo "    ROCKSDB_WRITE_BUFFER_MB=${ROCKSDB_WRITE_BUFFER_MB:-}"
echo "    ROCKSDB_MAX_WRITE_BUFFER_NUMBER=${ROCKSDB_MAX_WRITE_BUFFER_NUMBER:-}"
echo "    ROCKSDB_TARGET_FILE_SIZE_MB=${ROCKSDB_TARGET_FILE_SIZE_MB:-}"

rm -rf target/criterion

if [[ ${#extra_args[@]} -gt 0 ]]; then
  cargo bench -p citizen-storage --bench rocksdb_adapter -- "${extra_args[@]}"
else
  cargo bench -p citizen-storage --bench rocksdb_adapter
fi

mkdir -p "$(dirname "${results_dir}")"
rm -rf "${results_dir}"
cp -r target/criterion "${results_dir}"

metadata_file="${results_dir}/metadata.txt"
{
  echo "config=${cfg}"
  echo "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "rocksdb_compaction_style=${ROCKSDB_COMPACTION_STYLE:-}"
  echo "rocksdb_write_buffer_mb=${ROCKSDB_WRITE_BUFFER_MB:-}"
  echo "rocksdb_max_write_buffer_number=${ROCKSDB_MAX_WRITE_BUFFER_NUMBER:-}"
  echo "rocksdb_target_file_size_mb=${ROCKSDB_TARGET_FILE_SIZE_MB:-}"
  if [[ ${#extra_args[@]} -gt 0 ]]; then
    printf "cargo_bench_args="
    printf "%s " "${extra_args[@]}"
    printf "\n"
  else
    echo "cargo_bench_args="
  fi
} > "${metadata_file}"

echo "==> Results copied to ${results_dir}"
