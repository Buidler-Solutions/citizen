# Quick Start

Get a local Citizen network running in under 5 minutes.

## 1. Build the Node

```bash
cd citizen-protocol
cargo build --release
```

## 2. Start a Local Validator Set

The project ships with pre-configured localnet validator configs:

```bash
# Terminal 1 — Validator Alpha (leader)
./target/release/citizen-node --config config/localnet/validator-alpha.toml

# Terminal 2 — Validator Beta
./target/release/citizen-node --config config/localnet/validator-beta.toml

# Terminal 3 — Validator Gamma
./target/release/citizen-node --config config/localnet/validator-gamma.toml
```

A minimum of 3 validators is required for >2/3 BFT quorum. The localnet configs use 5 validators (alpha through epsilon) for a comfortable margin.

## 3. Verify the Network

Check that the API is responding:

```bash
curl http://localhost:7001/health
```

Expected response:

```json
{
  "status": "healthy",
  "node_id": "...",
  "head_height": 0
}
```

## 4. Submit Your First Entry

Using the CLI wallet:

```bash
# Generate a wallet (if you don't have one)
./target/release/citizen-wallet-cli generate

# Submit a test entry
./target/release/citizen-wallet-cli submit \
  --namespace default \
  --payload '{"message": "Hello, Citizen!"}'
```

## 5. Check the Receipt

```bash
./target/release/citizen-wallet-cli receipt --hash <entry-hash>
```

The receipt confirms deterministic finality — the entry is permanently committed.

## 6. Explore with the Explorer

```bash
cd explorer/frontend
npm install
npm run dev
```

Open `http://localhost:5173` to browse blocks, entries, and receipts.

## Using the TypeScript SDK

```typescript
import { CitizenClient } from '@greenarmor/citizen-sdk';

const client = new CitizenClient({
  network: 'localnet',
  endpoint: 'http://localhost:7001',
});

const health = await client.healthCheck();
console.log(health);
```

## Next Steps

- [Read about the consensus model](../protocol/consensus.md)
- [Set up a wallet](../wallets/overview.md)
- [Learn about namespaces](../protocol/namespaces.md)
- [Run a full validator node](../node-operators/running-a-node.md)
