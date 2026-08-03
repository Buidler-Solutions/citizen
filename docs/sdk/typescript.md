# TypeScript SDK

The Citizen TypeScript SDK (`@greenarmor/citizen-sdk`) provides builder-facing integration for applications interacting with the Citizen protocol.

## Installation

```bash
npm install @greenarmor/citizen-sdk
```

## Quick Start

```typescript
import { CitizenClient } from '@greenarmor/citizen-sdk';

const client = new CitizenClient({
  network: 'testnet',
});

// Check node health
const health = await client.healthCheck();
console.log(health.status); // "healthy"

// Submit a signed entry
const receipt = await client.submitEntry({
  namespace: 'default',
  payload: { message: 'Hello, Citizen!' },
  signer: wallet.getSigner(),
});

console.log(receipt.hash);
console.log(receipt.finalized); // true (deterministic finality)
```

## Configuration

```typescript
const client = new CitizenClient({
  network: 'testnet',           // 'mainnet' | 'futurenet' | 'testnet' | 'localnet'
  endpoint: 'http://localhost:7001',  // Override network endpoint
  timeout: 30000,               // Request timeout (ms)
  retries: 3,                   // Retry count for failed requests
});
```

## Core Operations

### Health Check

```typescript
const health = await client.healthCheck();
// { status: "healthy", node_id: "...", head_height: 42 }
```

### Submit Entry

```typescript
const receipt = await client.submitEntry({
  namespace: 'default',
  payload: { ... },
  signer: signer,  // Ed25519 signer instance
});
```

### Get Receipt

```typescript
const receipt = await client.getReceipt('0xabc123...');
// { hash, block_height, signatures, finalized: true }
```

### Query Namespace

```typescript
const ns = await client.getNamespace('civic-records');
// { name, policies, active: true, ... }
```

### Governance Proposals

```typescript
const proposals = await client.getProposals();
const proposal = await client.getProposal('proposal-123');
```

## Direct Submit

The SDK supports direct submit - sending pre-signed entries directly to Citizen network endpoints without going through a relay:

```typescript
const result = await client.directSubmit({
  signedPayload: signedPayload,
  endpoint: 'https://node.citizen.example.com',
});
```

Submit destinations are enforce-allowlisted to Citizen network endpoints only.

## TypeScript Types

The SDK is written in TypeScript and ships with full type definitions:

```typescript
import type {
  CitizenClientConfig,
  EntryPayload,
  Receipt,
  NamespaceConfig,
  Proposal,
  NetworkId,
} from '@greenarmor/citizen-sdk';
```

## Build

```bash
cd sdk/typescript
npm install
npm run build      # Produces dist/esm/ and dist/cjs/
npm test
```

## Package Audit

The SDK includes a packaging audit to ensure the published tarball contains only the necessary files:

```bash
npm run package-audit
```

This validates that the tarball includes `README.md`, `package.json`, and both ESM (`dist/esm/`) and CJS (`dist/cjs/`) outputs, while excluding source files, tests, and configuration.
