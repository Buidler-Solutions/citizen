# API Reference

The Citizen node exposes an HTTP REST API for builders, wallets, and explorers.

## Base URL

```
http://<node-host>:<api-port>
```

Default API port: `7001` (localnet validator-alpha)

## Health

### `GET /health`

Check node health and status.

**Response:**
```json
{
  "status": "healthy",
  "node_id": "validator-alpha",
  "role": "validator",
  "head_height": 42,
  "peers": 4
}
```

## Entries

### `POST /entries`

Submit a signed entry to the ledger.

**Request:**
```json
{
  "namespace": "default",
  "payload": { ... },
  "signature": "<hex-signature>",
  "signer": "<did:key:ed25519:...>"
}
```

**Response:**
```json
{
  "hash": "0xabc123...",
  "status": "accepted",
  "block_height": 43
}
```

### `GET /entries/{hash}`

Retrieve an entry and its receipt by hash.

**Response:**
```json
{
  "hash": "0xabc123...",
  "namespace": "default",
  "payload": { ... },
  "block_height": 43,
  "finalized": true,
  "receipt": {
    "signatures": [...],
    "quorum_achieved": true
  }
}
```

## Namespaces

### `GET /namespaces`

List all active namespaces.

### `GET /namespaces/{name}`

Get namespace configuration and policies.

**Response:**
```json
{
  "name": "civic-records",
  "active": true,
  "policies": {
    "signature": "ed25519",
    "consent": "required",
    "privacy": { ... }
  }
}
```

## Governance

### `GET /proposals`

List governance proposals.

### `GET /proposals/{id}`

Get a specific proposal and its voting status.

**Response:**
```json
{
  "id": "proposal-123",
  "type": "namespace_creation",
  "status": "active",
  "votes_for": 4,
  "votes_against": 0,
  "quorum_required": 4,
  "voting_ends_at": "2026-08-10T00:00:00Z"
}
```

## Consensus

### `GET /consensus/status`

Get consensus status including online validators and current view.

**Response:**
```json
{
  "view": 42,
  "leader": "validator-alpha",
  "validators": {
    "total": 5,
    "online": 5
  },
  "quorum_threshold": 0.8
}
```

## Off-Chain Encrypted Files

When enabled (`api_offchain_encrypted_files_v1_enabled`), the API supports encrypted file workflows:

### `POST /offchain-encrypted-files`

Upload an encrypted file with its commitment.

### `GET /offchain-encrypted-files/{id}`

Retrieve an encrypted file by ID.

!!! note
    Off-chain encrypted file support is deployment-optional. Production object-store wiring depends on operator configuration (e.g., MinIO).
