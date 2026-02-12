# Local Full-Stack Testing Guide (Node + Demo Blog + Browser Wallet)

This guide runs the three pieces needed for end-to-end manual testing:

1. **Citizen local validator network** (Rust localnode trio)
2. **Demo blog dApp** (`demo/server.js`)
3. **Browser wallet extension** (`wallet/browser`)

It includes both a **recommended three-terminal workflow** and an **optional helper script** that launches the stack together.

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

## 4) Load the wallet extension in browser

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select: `citizen-protocol/wallet/browser/dist`
5. Pin the extension from the browser toolbar

When you make code changes, click **Reload** on the extension card after the watch build completes.

## 5) End-to-end testing flow

1. Ensure localnet is running (Terminal A).
2. Open `http://localhost:4300` (Terminal B output confirms server start).
3. Open the wallet extension popup and create/unlock a wallet.
4. In the demo blog, compose and publish an article.
5. Approve signing in the wallet extension.
6. Verify the resulting block receipt in the demo UI and/or inspect:

```bash
curl http://localhost:4300/api/chain
```

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

Press `Ctrl+C` once to stop all spawned processes.

## 7) Troubleshooting

- **Port 4300 already in use**: stop existing Node process or change demo server port logic.
- **`/health` check fails on `8081`**: localnet may still be compiling on first run; wait for logs to stabilize.
- **Extension fails to load**: ensure `wallet/browser/dist/manifest.json` exists (run build first).
- **Wallet changes not visible**: rebuild/watch then press extension **Reload** in `chrome://extensions`.
- **Rust recompiling too slowly**: keep Terminal A running; iterative restarts are faster with warm target cache.
