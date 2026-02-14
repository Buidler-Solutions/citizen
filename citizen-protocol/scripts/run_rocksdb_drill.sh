#!/usr/bin/env bash
set -euo pipefail

# Disaster-recovery drill helper for validator/observer operators.
# 1) snapshot: create compressed archive + sha256 manifest
# 2) verify: validate checksum for an existing snapshot archive
# 3) restore: expand archive into a target data directory

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") snapshot --source <data_dir> --out-dir <backup_dir> --node-id <operator_id>
  $(basename "$0") verify --archive <archive.tar.gz> --manifest <archive.sha256>
  $(basename "$0") restore --archive <archive.tar.gz> --manifest <archive.sha256> --target <restore_dir>

Examples:
  $(basename "$0") snapshot --source data/validator-alpha --out-dir backups --node-id validator-alpha
  $(basename "$0") verify --archive backups/validator-alpha-20260214T120000Z.tar.gz --manifest backups/validator-alpha-20260214T120000Z.sha256
  $(basename "$0") restore --archive backups/validator-alpha-20260214T120000Z.tar.gz --manifest backups/validator-alpha-20260214T120000Z.sha256 --target drills/validator-alpha-restore
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[drill] missing required command: $1" >&2
    exit 1
  }
}

require_cmd tar
require_cmd sha256sum

MODE="${1:-}"
if [[ -z "${MODE}" ]]; then
  usage
  exit 1
fi
shift || true

SOURCE=""
OUT_DIR=""
NODE_ID=""
ARCHIVE=""
MANIFEST=""
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE="$2"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --node-id)
      NODE_ID="$2"
      shift 2
      ;;
    --archive)
      ARCHIVE="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST="$2"
      shift 2
      ;;
    --target)
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[drill] unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

case "${MODE}" in
  snapshot)
    [[ -n "${SOURCE}" && -n "${OUT_DIR}" && -n "${NODE_ID}" ]] || {
      echo "[drill] snapshot mode requires --source, --out-dir, --node-id" >&2
      exit 1
    }
    [[ -d "${SOURCE}" ]] || {
      echo "[drill] source directory not found: ${SOURCE}" >&2
      exit 1
    }

    mkdir -p "${OUT_DIR}"
    TS="$(date -u +%Y%m%dT%H%M%SZ)"
    BASENAME="${NODE_ID}-${TS}"
    ARCHIVE_PATH="${OUT_DIR}/${BASENAME}.tar.gz"
    MANIFEST_PATH="${OUT_DIR}/${BASENAME}.sha256"

    tar -czf "${ARCHIVE_PATH}" -C "$(dirname "${SOURCE}")" "$(basename "${SOURCE}")"
    sha256sum "${ARCHIVE_PATH}" > "${MANIFEST_PATH}"

    echo "[drill] snapshot archive: ${ARCHIVE_PATH}"
    echo "[drill] checksum manifest: ${MANIFEST_PATH}"
    ;;

  verify)
    [[ -n "${ARCHIVE}" && -n "${MANIFEST}" ]] || {
      echo "[drill] verify mode requires --archive and --manifest" >&2
      exit 1
    }
    [[ -f "${ARCHIVE}" && -f "${MANIFEST}" ]] || {
      echo "[drill] archive/manifest missing" >&2
      exit 1
    }

    (cd "$(dirname "${ARCHIVE}")" && sha256sum --check "$(realpath --relative-to="$(dirname "${ARCHIVE}")" "${MANIFEST}")")
    echo "[drill] checksum verified: ${ARCHIVE}"
    ;;

  restore)
    [[ -n "${ARCHIVE}" && -n "${MANIFEST}" && -n "${TARGET}" ]] || {
      echo "[drill] restore mode requires --archive, --manifest, --target" >&2
      exit 1
    }
    [[ -f "${ARCHIVE}" && -f "${MANIFEST}" ]] || {
      echo "[drill] archive/manifest missing" >&2
      exit 1
    }

    mkdir -p "${TARGET}"
    (cd "$(dirname "${ARCHIVE}")" && sha256sum --check "$(realpath --relative-to="$(dirname "${ARCHIVE}")" "${MANIFEST}")")
    tar -xzf "${ARCHIVE}" -C "${TARGET}"
    echo "[drill] restored into: ${TARGET}"
    ;;

  *)
    echo "[drill] unsupported mode: ${MODE}" >&2
    usage
    exit 1
    ;;
esac
