#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== CITIZEN LOCAL STACK ==="
echo ""

# ── 1. Kill existing processes ──
echo "[1/7] stopping existing services..."
pkill -f citizen-node 2>/dev/null || true
pkill -f "pnpm.*dev" 2>/dev/null || true
pkill -f "nest start" 2>/dev/null || true
pkill -f "tsx watch" 2>/dev/null || true
sleep 1

# ── 2. Reset triolet from genesis ──
echo "[2/7] resetting triolet from genesis..."
rm -rf citizen-protocol/data/triolet-*

# ── 3. Start triolet nodes ──
echo "[3/7] starting triolet nodes (ports 8091-8093)..."
cd citizen-protocol
bash scripts/run_triolet.sh &
TRIOLET_PID=$!
cd "$ROOT_DIR"

# Wait for triolet health
for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:8091/health" >/dev/null 2>&1; then
        echo "       triolet healthy"
        break
    fi
    sleep 2
done

# ── 4. Start landing page (onboarding site) ──
echo "[4/7] starting onboarding site (ports 3000/3001)..."
cd landing-page/backend && pnpm run start:dev &
cd "$ROOT_DIR"
cd landing-page/frontend && pnpm dev &
cd "$ROOT_DIR"

# ── 5. Start ctzn-token (soulbound token) ──
echo "[5/7] starting soulbound token (port 5175)..."
cd ctzn-token && pnpm dev &
cd "$ROOT_DIR"

# ── 6. Start election admin console ──
echo "[6/7] starting election admin (port 5177)..."
cd election-admin && pnpm dev &
cd "$ROOT_DIR"

# ── 7. Start explorer ──
echo "[7/7] starting explorer (ports 4444/8885)..."
cd explorer/backend && pnpm run start:dev &
cd "$ROOT_DIR"
cd explorer/frontend && pnpm dev &
cd "$ROOT_DIR"

echo ""
echo "=== ALL SERVICES STARTING ==="
echo ""
echo "  Triolet α             http://localhost:8091"
echo "  Triolet β             http://localhost:8092"
echo "  Triolet γ             http://localhost:8093"
echo "  Onboarding backend    http://localhost:3001"
echo "  Onboarding frontend   http://localhost:3000"
echo "  Soulbound token       http://localhost:5175"
echo "  Election admin        http://localhost:5177"
echo "  Explorer backend      http://localhost:4444"
echo "  Explorer frontend     http://localhost:8885"
echo ""
echo "Press Ctrl+C to stop everything."

wait
