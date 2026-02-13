# Citizen Demo dApp: Blog Article Publishing on a Local Blockchain

This demo is a standalone dApp under `demo/` that implements article publishing with blockchain anchoring.

> Note: this is a JavaScript demo node used by the DApp publish flow. The Rust validator localnet is run via `scripts/run_localnet.sh` (see `docs/LOCALNET_RUNBOOK.md`).

## What it demonstrates
- Article composition and publishing in a web UI.
- Deterministic article content hashing (`SHA-256`).
- Append-only blockchain ledger with linked block hashes.
- **Node-side wallet signature verification before anchoring transactions.**
- Block receipt returned immediately after publication.

## Run locally

```bash
cd citizen-protocol/demo
npm install
npm run start
```

Server starts at:
- `http://localhost:4300`

## API quick examples

Publish an article (node validates wallet signature + signed message before writing block):

```bash
curl -X POST http://localhost:4300/api/articles \
  -H 'Content-Type: application/json' \
  -d '{
    "author":"0x0000000000000000000000000000000000000000",
    "title":"Procurement dashboard now fully auditable",
    "tags":["audit","governance"],
    "content":"This is a long article body with at least one hundred characters so it can be accepted by the validation layer in the demo API.",
    "signedMessage":"Citizen DApp Article Publish\\nChallenge: ...\\nWallet: 0x0000000000000000000000000000000000000000\\nTitle: Procurement dashboard now fully auditable\\nContent Hash: ...\\nIssued At: ...\\nExpires At: ...",
    "walletSignature":"0x..."
  }'
```

Read chain state:

```bash
curl http://localhost:4300/api/chain
```

## Validation rules for `POST /api/articles`

The node rejects (`422 wallet_validation_failed`) when any of these checks fail:
- `author` is not a valid 20-byte hex wallet address.
- `signedMessage` / `walletSignature` are missing.
- Signed message wallet does not match `author`.
- Signed message content hash does not match submitted content.
- Signature recovery does not resolve back to `author`.

## Files
- `server.js` — HTTP API + static hosting + blockchain append logic.
- `public/` — Browser dApp UI.
- `data/chain.json` — persisted demo blockchain.
- `DESIGN.md` — architecture and design choices.
