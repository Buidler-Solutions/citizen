#!/bin/bash
# =============================================================================
# run_triolet_join_delta.sh
# =============================================================================
# Starts the existing triolet network (alpha, beta, gamma) and joins a
# new validator (delta) that syncs from genesis and enters consensus.
#
# Prerequisites:
#   cd citizen-protocol && cargo build --release
#
# Usage:
#   Run in 4 separate terminals:
#     Terminal 1: ./scripts/run_triolet_join_delta.sh alpha
#     Terminal 2: ./scripts/run_triolet_join_delta.sh beta
#     Terminal 3: ./scripts/run_triolet_join_delta.sh gamma
#     Terminal 4: ./scripts/run_triolet_join_delta.sh delta
#
# After all 4 are running, the network operates with 4 validators.
# Quorum with 4 validators at 6667 bps: ceiling(4 * 6667/10000) = 3 votes.
# The network tolerates 1 faulty node.
#
# Health checks:
#   curl http://localhost:8091/health   # alpha
#   curl http://localhost:8092/health   # beta
#   curl http://localhost:8093/health   # gamma
#   curl http://localhost:8094/health   # delta (joining)
# =============================================================================

set -euo pipefail

NODE="${1:-alpha}"

case "$NODE" in
  alpha)
    CONFIG="config/triolet/validator-alpha.toml"
    ;;
  beta)
    CONFIG="config/triolet/validator-beta.toml"
    ;;
  gamma)
    CONFIG="config/triolet/validator-gamma.toml"
    ;;
  delta)
    CONFIG="config/triolet/validator-delta.toml"
    ;;
  *)
    echo "Usage: $0 {alpha|beta|gamma|delta}"
    exit 1
    ;;
esac

echo "=== Starting validator: $NODE ==="
echo "Config: $CONFIG"
echo ""

./target/release/citizen-node --config "$CONFIG"
