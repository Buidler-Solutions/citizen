# Explorer

The Citizen explorer provides a web interface for browsing blocks, transactions, entries, and receipts on the Citizen network.

## Running the Explorer

### Backend

```bash
cd explorer/backend
npm install
npm start
```

The backend API serves on `http://localhost:3001` by default.

### Frontend

```bash
cd explorer/frontend
npm install
npm run dev
```

The frontend dev server runs on `http://localhost:5173`.

## Features

### Dashboard
- Network overview (block height, validator count, entry count)
- Recent blocks list
- Network status indicators

### Block Browser
- Paginated block list sorted by height
- Block detail view with entries and signatures
- Finality status for each block

### Transaction Search
- Search by entry hash
- View receipt details (signatures, finality proof)
- View entry payload and namespace

### Metrics
- Indexer metrics (block processing rate, indexing lag)
- Consensus metrics (voting participation, view changes)

## Architecture

```
explorer/
  backend/          # API server (Node.js)
  frontend/         # Web UI (React + Vite)
  infra/            # Docker and deployment configs
```

The explorer backend indexes blocks and entries from a Citizen node's API and serves them through a query-optimized REST interface.
