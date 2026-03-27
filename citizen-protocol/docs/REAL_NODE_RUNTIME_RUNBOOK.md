# Real Node Runtime Integration Runbook (Wallet + Explorer + Demo Blog)

This runbook describes how to run the full Citizen local stack so that:

- Browser wallet signs real publish payloads.
- Demo Blog submits to the Rust node runtime (not local dummy JSON chain).
- Explorer backend/frontend read from the same runtime.

## 1. Architecture (local stack)

```text
Browser Wallet Extension
   └─ signs challenge (personal_sign)
Demo Blog UI (localhost:4300)
   └─ POST /api/articles (demo backend)
Demo Backend (localhost:4300)
   └─ POST /api/v1/envelopes/submit -> Citizen Node Runtime (8081)
Citizen Node Runtime (8081/8082/8083)
   ├─ stores entry in namespace content.article
   └─ serves /entries/content.article and /blocks/*
Explorer Backend (4010)
   └─ proxies runtime APIs from 8081
Explorer Frontend (4020)
   └─ visualizes runtime data
```

## 2. Prerequisites

- Rust stable + cargo
- Node.js 20+
- npm
- Chromium browser (for extension)

## 3. One-time setup

```bash
cd citizen-protocol
npm --prefix demo install
npm --prefix wallet/browser install
npm --prefix explorer/backend install
npm --prefix explorer/frontend install
```

## 4. Launch sequence (recommended)

### Terminal A: Citizen validator localnet

```bash
cd citizen-protocol
scripts/run_localnet.sh
```

### Terminal B: Demo Blog (runtime-backed mode)

```bash
cd demo
CITIZEN_NODE_URL=http://127.0.0.1:8081 CITIZEN_CONTENT_NAMESPACE=content.article npm run start
```

### Terminal C: Browser wallet extension build/watch

```bash
cd wallet/browser
npm run build -- --watch
```

### Terminal D: Explorer backend

```bash
cd explorer/backend
PORT=4010 CITIZEN_NODE_URL=http://127.0.0.1:8081 npm run start:dev
```

### Terminal E: Explorer frontend

```bash
cd explorer/frontend
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4010 npm run dev -- --port 4020
```

## 5. Wallet extension load

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `wallet/browser/dist`.

## 6. Validation checks (must pass)

```bash
curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8081/entries/content.article
curl http://localhost:4300/api/health
curl http://localhost:4300/api/articles
curl http://127.0.0.1:4010/status
curl http://127.0.0.1:4010/entries/content.article
```

## 7. Publish flow test

1. Open demo blog: `http://localhost:4300`.
2. Connect wallet.
3. Submit article with valid content.
4. Approve signature request.
5. Confirm accepted receipt appears in UI.
6. Confirm explorer reflects new entry:
   - API: `http://127.0.0.1:4010/entries/content.article`
   - UI: `http://127.0.0.1:4020`

## 8. Troubleshooting

- `node_runtime_unavailable` from demo backend:
  - check localnet process is running
  - verify `CITIZEN_NODE_URL`
- wallet not detected in demo UI:
  - reload extension in `chrome://extensions`
  - refresh demo page
- explorer empty:
  - verify explorer backend has correct `CITIZEN_NODE_URL`
  - verify localnet has `content.article` namespace bootstrapped

## 9. Optional smoke command

After all services are running:

```bash
cd citizen-protocol
scripts/stack_runtime_smoke_test.sh
```

