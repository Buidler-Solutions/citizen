# Local Full-Stack Testing Guide (Node + Demo Blog + Browser Wallet + Explorer)

This guide runs the full local testing stack:

1. **Citizen local validator network** (Rust localnode trio)
2. **Demo blog dApp** (`demo/server.js`)
3. **Browser wallet extension** (`wallet/browser`)
4. **Blockchain explorer backend** (`explorer/backend`)
5. **Blockchain explorer frontend** (`explorer/frontend`)

It includes both a **recommended five-terminal workflow** and an **optional helper script** that launches the stack together.

## 1) Prerequisites

Install the following on your machine:

- Rust stable toolchain (`cargo`, `rustup`)
- Node.js 20+ and npm
- Chromium-based browser (Chrome, Brave, Edge) for extension loading

Verify tooling:

```bash
cargo --version
node --version
npm --version
```

## 2) One-time dependency install

From repository root:

```bash
cd citizen-protocol
npm --prefix demo install
npm --prefix wallet/browser install
npm --prefix explorer/backend install
npm --prefix explorer/frontend install
```

## 3) Recommended: run each service in its own terminal

### Terminal A — local validator network

```bash
cd citizen-protocol
scripts/run_localnet.sh
```

What you get:

- QUIC peers: `127.0.0.1:9100-9102`
- Node APIs: `http://127.0.0.1:8081`, `:8082`, `:8083`
- Logs: `data/validator-alpha.log`, `data/validator-beta.log`, `data/validator-gamma.log`

Quick health check:

```bash
curl http://127.0.0.1:8081/health
```

### Terminal B — demo blog backend + web UI

```bash
cd citizen-protocol/demo
npm run start
```

What you get:

- Demo app + API: `http://localhost:4300`
- Publish endpoint: `POST http://localhost:4300/api/articles`
- Chain endpoint: `GET http://localhost:4300/api/chain`

### Terminal C — wallet extension build/watch

For extension loading in browser, keep an incremental build running:

```bash
cd citizen-protocol/wallet/browser
npm run build -- --watch
```

This writes extension assets into `wallet/browser/dist/` whenever files change.

### Terminal D — explorer backend (NestJS)

Run explorer API on a dedicated port and point it at the local validator node API:

```bash
cd citizen-protocol/explorer/backend
PORT=4010 CITIZEN_NODE_URL=http://127.0.0.1:8081 npm run start:dev
```

What you get:

- Explorer backend API: `http://127.0.0.1:4010`
- Backend status endpoint: `GET http://127.0.0.1:4010/status`
- Backend block proxy endpoint: `GET http://127.0.0.1:4010/blocks`

### Terminal E — explorer frontend (Next.js)

Point the UI to the explorer backend API:

```bash
cd citizen-protocol/explorer/frontend
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4010 npm run dev -- --port 4020
```

What you get:

- Explorer web UI: `http://127.0.0.1:4020`
- Frontend calls explorer backend using `NEXT_PUBLIC_API_BASE_URL`

## 4) Load the wallet extension in browser

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select: `citizen-protocol/wallet/browser/dist`
5. Pin the extension from the browser toolbar

When you make code changes, click **Reload** on the extension card after the watch build completes.

## 5) End-to-end testing flow

1. Ensure localnet is running (Terminal A).
2. Confirm explorer backend is reachable:

```bash
curl http://127.0.0.1:4010/status
curl http://127.0.0.1:4010/blocks
```

3. Open `http://localhost:4300` (Terminal B output confirms server start).
4. Open the wallet extension popup and create/unlock a wallet.
5. In the demo blog, compose and publish an article.
6. Approve signing in the wallet extension.
7. Verify the resulting block receipt in the demo UI and inspect both chain APIs:

```bash
curl http://localhost:4300/api/chain
curl http://127.0.0.1:4010/blocks
```

8. Open the explorer UI at `http://127.0.0.1:4020` and confirm latest blocks/entries are visible.

## 6) Optional: launch everything with one script

Use the helper launcher (still opens services in one shell and handles clean shutdown):

```bash
cd citizen-protocol
scripts/run_local_test_stack.sh
```

The script starts:

- `scripts/run_localnet.sh`
- `demo` server (`npm run start`)
- wallet extension watch build (`npm run build -- --watch`)
- explorer backend (`PORT=4010 CITIZEN_NODE_URL=http://127.0.0.1:8081 npm run start:dev`)
- explorer frontend (`NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4010 npm run dev -- --port 4020`)

Press `Ctrl+C` once to stop all spawned processes.

## 7) Troubleshooting

- **Port 4300 already in use**: stop existing Node process or change demo server port logic.
- **`/health` check fails on `8081`**: localnet may still be compiling on first run; wait for logs to stabilize.
- **Extension fails to load**: ensure `wallet/browser/dist/manifest.json` exists (run build first).
- **Wallet changes not visible**: rebuild/watch then press extension **Reload** in `chrome://extensions`.
- **Rust recompiling too slowly**: keep Terminal A running; iterative restarts are faster with warm target cache.
- **Explorer backend cannot reach node**: verify `CITIZEN_NODE_URL` points to a live node API (recommended: `http://127.0.0.1:8081`).
- **Explorer UI empty or stale**: verify `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4010` and that Terminal D is running.
