#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_DIR="${REPO_ROOT}/deploy/runtime-stack"

NODE_CONFIG_DEFAULT="${REPO_ROOT}/config/node.toml"
MANIFEST_DEFAULT="${REPO_ROOT}/config/signed-manifest.json"
CONTAINER_CONFIG_DEFAULT="/etc/citizen/node.toml"
CONTAINER_MANIFEST_DEFAULT="/etc/citizen/signed-manifest.json"
IMAGE_DEFAULT="citizen-node:runtime"
CONTAINER_DEFAULT="citizen-node-runtime"

usage() {
  cat <<'USAGE'
Runbook helper for running Citizen runtime Docker with a signed manifest.

Usage:
  runbook-docker-signed-manifest.sh <command> [options]

Commands:
  compose-up      Start with docker compose (build + up -d)
  compose-down    Stop compose stack
  docker-run      Build image and run a standalone container
  docker-stop     Stop and remove the standalone container

Options:
  --node-config <host_path>            Host path to node.toml
  --manifest <host_path>               Host path to signed-manifest.json
  --container-config-path <path>       Container path for node.toml
  --container-manifest-path <path>     Container path for signed-manifest.json
  --image <name>                       Docker image name for docker-run
  --container <name>                   Container name for docker-run/docker-stop
  --help                               Show this help message

Examples:
  ./deploy/runtime-stack/runbook-docker-signed-manifest.sh compose-up
  ./deploy/runtime-stack/runbook-docker-signed-manifest.sh docker-run \
    --node-config ./config/node.toml \
    --manifest ./config/signed-manifest.json
USAGE
}

COMMAND="${1:-}"
if [[ -z "${COMMAND}" || "${COMMAND}" == "--help" || "${COMMAND}" == "-h" ]]; then
  usage
  exit 0
fi
shift || true

NODE_CONFIG="${NODE_CONFIG_DEFAULT}"
MANIFEST_PATH="${MANIFEST_DEFAULT}"
CONTAINER_CONFIG_PATH="${CONTAINER_CONFIG_DEFAULT}"
CONTAINER_MANIFEST_PATH="${CONTAINER_MANIFEST_DEFAULT}"
IMAGE_NAME="${IMAGE_DEFAULT}"
CONTAINER_NAME="${CONTAINER_DEFAULT}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-config)
      NODE_CONFIG="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST_PATH="$2"
      shift 2
      ;;
    --container-config-path)
      CONTAINER_CONFIG_PATH="$2"
      shift 2
      ;;
    --container-manifest-path)
      CONTAINER_MANIFEST_PATH="$2"
      shift 2
      ;;
    --image)
      IMAGE_NAME="$2"
      shift 2
      ;;
    --container)
      CONTAINER_NAME="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[runbook] unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_file() {
  local file_path="$1"
  local description="$2"
  if [[ ! -f "${file_path}" ]]; then
    echo "[runbook] ${description} not found: ${file_path}" >&2
    exit 1
  fi
}

resolve_abs() {
  local path="$1"
  if [[ "${path}" = /* ]]; then
    printf '%s\n' "${path}"
  else
    printf '%s\n' "$(cd "${PWD}" && realpath "${path}")"
  fi
}

NODE_CONFIG="$(resolve_abs "${NODE_CONFIG}")"
MANIFEST_PATH="$(resolve_abs "${MANIFEST_PATH}")"

case "${COMMAND}" in
  compose-up)
    require_file "${NODE_CONFIG}" "node config"
    require_file "${MANIFEST_PATH}" "signed manifest"

    echo "[runbook] starting docker compose with signed manifest"
    echo "[runbook] node config (host): ${NODE_CONFIG}"
    echo "[runbook] signed manifest (host): ${MANIFEST_PATH}"
    echo "[runbook] node config (container): ${CONTAINER_CONFIG_PATH}"
    echo "[runbook] signed manifest (container): ${CONTAINER_MANIFEST_PATH}"

    (
      cd "${RUNTIME_DIR}"
      NODE_CONFIG_HOST_PATH="${NODE_CONFIG}" \
      SIGNED_MANIFEST_HOST_PATH="${MANIFEST_PATH}" \
      CONTAINER_NODE_CONFIG_PATH="${CONTAINER_CONFIG_PATH}" \
      CONTAINER_MANIFEST_PATH="${CONTAINER_MANIFEST_PATH}" \
      docker compose up --build -d
    )
    ;;

  compose-down)
    echo "[runbook] stopping docker compose stack"
    (
      cd "${RUNTIME_DIR}"
      docker compose down
    )
    ;;

  docker-run)
    require_file "${NODE_CONFIG}" "node config"
    require_file "${MANIFEST_PATH}" "signed manifest"

    echo "[runbook] building image: ${IMAGE_NAME}"
    docker build \
      -f "${RUNTIME_DIR}/Dockerfile" \
      -t "${IMAGE_NAME}" \
      "${REPO_ROOT}"

    echo "[runbook] running container: ${CONTAINER_NAME}"
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    docker run -d \
      --name "${CONTAINER_NAME}" \
      --restart unless-stopped \
      -p 8080:8080 \
      -p 9100:9100 \
      -p 9200:9200 \
      -v "${NODE_CONFIG}:${CONTAINER_CONFIG_PATH}:ro" \
      -v "${MANIFEST_PATH}:${CONTAINER_MANIFEST_PATH}:ro" \
      -v citizen_node_data:/var/lib/citizen \
      "${IMAGE_NAME}" \
      "${CONTAINER_CONFIG_PATH}"

    cat <<INFO
[runbook] container started.
[runbook] ensure node.toml has:
  manifest_enforce = true
  manifest_path = "${CONTAINER_MANIFEST_PATH}"
INFO
    ;;

  docker-stop)
    echo "[runbook] stopping/removing container: ${CONTAINER_NAME}"
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    ;;

  *)
    echo "[runbook] unknown command: ${COMMAND}" >&2
    usage
    exit 1
    ;;
esac
