# Citizen Demo dApp: Blog Article Publishing on a Local Blockchain

This demo is a standalone dApp under `demo/` that implements article publishing with blockchain anchoring.

## What it demonstrates
- Article composition and publishing in a web UI.
- Deterministic article content hashing (`SHA-256`).
- Append-only blockchain ledger with linked block hashes.
- Block receipt returned immediately after publication.

## Run locally

```bash
cd citizen-protocol/demo
npm run start
```

Server starts at:
- `http://localhost:4300`

## API quick examples

Publish an article:

```bash
curl -X POST http://localhost:4300/api/articles \
  -H 'Content-Type: application/json' \
  -d '{
    "author":"did:citizen:writer:alexa",
    "title":"Procurement dashboard now fully auditable",
    "tags":["audit","governance"],
    "content":"This is a long article body with at least one hundred characters so it can be accepted by the validation layer in the demo API."
  }'
```

Read chain state:

```bash
curl http://localhost:4300/api/chain
```

## Files
- `server.js` — HTTP API + static hosting + blockchain append logic.
- `public/` — Browser dApp UI.
- `data/chain.json` — persisted demo blockchain.
- `DESIGN.md` — architecture and design choices.
