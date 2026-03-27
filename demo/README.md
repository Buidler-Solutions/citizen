# Citizen Demo Blog: Wallet + Real Node Runtime Publishing

This demo under `demo/` now runs as a **real node-runtime client**:

- Browser wallet signs challenge messages.
- Demo backend verifies signatures.
- Backend submits signed envelopes to the Rust node runtime (`/api/v1/envelopes/submit`).
- Reads published content from runtime namespace entries (`/entries/content.article`).

## Prerequisites

1. Run the validator runtime first (for localnet use `scripts/run_localnet.sh`).
2. Ensure the target node API is reachable.

## Run locally

```bash
cd demo
npm install
CITIZEN_NODE_URL=http://127.0.0.1:8081 CITIZEN_CONTENT_NAMESPACE=content.article npm run start
```

Server starts at:

- `http://localhost:4300`

## Runtime-backed API endpoints

- `GET /api/health` — reports runtime URL and runtime health (`ok`/`unreachable`).
- `GET /api/articles` — loads published article entries from runtime namespace.
- `GET /api/chain` — runtime summary (`/health`, `/namespaces`, `/blocks/0`).
- `POST /api/wallet/challenge` — creates wallet signing challenge.
- `POST /api/articles` — verifies signature and submits envelope to runtime.

## End-to-end flow

1. Open `http://localhost:4300`.
2. Connect the browser wallet extension.
3. Publish article draft (client asks `/api/wallet/challenge`).
4. Sign challenge with wallet (`personal_sign`).
5. Demo backend verifies signature and calls node runtime envelope submit.
6. UI reloads from node runtime entries.

## Quick runtime verification

```bash
curl http://localhost:4300/api/health
curl http://localhost:4300/api/articles
curl http://localhost:4300/api/chain
curl http://127.0.0.1:8081/entries/content.article
```

