# Citizen BlogChain Demo Design

## Objective
Build a **working demo dApp** that lets users publish blog/news articles and anchor each publication as an immutable ledger event in a blockchain-like append-only chain.

## Product Scope
- Publish article (author, title, tags, body).
- Generate deterministic content hash (`SHA-256`) per article.
- Persist publication as transaction in a new block.
- Expose a publication receipt with:
  - entry ID
  - content hash
  - block height
  - block hash
  - previous hash linkage
- Show recent chain state in UI.

## Architecture

```text
Browser UI (public/index.html + app.js)
        |
        v
Node HTTP API (server.js)
  - Validation
  - Transaction assembly
  - Merkle root + block hash
  - Chain persistence
        |
        v
data/chain.json (append-only demo ledger)
```

## Data Model

### Transaction (`PUBLISH_ARTICLE`)
- `entryId` (UUID)
- `namespace`: `content.blog`
- `action`: `PUBLISH_ARTICLE`
- `author`
- `title`
- `content`
- `contentHash`
- `signature` (demo signature hash)
- `publishedAt`

### Block
- `height`
- `previousHash`
- `timestamp`
- `proposer`
- `transactions[]`
- `merkleRoot`
- `blockHash`

## API Design
- `GET /api/health` → health + block count
- `GET /api/articles` → article summaries
- `GET /api/articles/:id` → full article with chain metadata
- `POST /api/articles` → publish + anchor article
- `GET /api/chain` → full chain inspection

## Validation Rules
- Title min length: 5
- Author min length: 3
- Content min length: 100
- Tags normalized + trimmed

## Security Notes (Demo)
- Not production cryptography/signing.
- No validator networking/quorum simulation.
- Single-node append-only persistence only.

## Migration Path to Full CITIZEN Integration
1. Replace local file persistence with `citizen-node` write API.
2. Replace demo signature hash with wallet/BLS entry signing.
3. Submit ledger entries to `content.blog` namespace.
4. Return on-chain commit proof from consensus layer.
