# CLI Wallet

The Citizen CLI wallet is a command-line tool for operators and developers.

## Build

```bash
cd citizen-protocol
cargo build --release -p citizen-wallet-cli
```

The binary will be at `target/release/citizen-wallet-cli`.

## Key Lifecycle

### Generate a Wallet

```bash
citizen-wallet-cli generate
```

This generates a BIP39 mnemonic, derives Ed25519/X25519 keys, and stores them locally.

### Import a Wallet

```bash
citizen-wallet-cli import --mnemonic "word1 word2 ... word12"
```

### List Wallets

```bash
citizen-wallet-cli list
```

### Set Active Wallet

```bash
citizen-wallet-cli set-active --id <wallet-id>
```

## Operations

### Sign a Payload

```bash
citizen-wallet-cli sign \
  --namespace default \
  --payload '{"action": "register", "data": "..."}'
```

### Submit an Entry

```bash
citizen-wallet-cli submit \
  --namespace default \
  --payload '{"message": "Hello, Citizen!"}' \
  --network localnet
```

### View a Receipt

```bash
citizen-wallet-cli receipt --hash <entry-hash>
```

### Namespace Signing Helpers

```bash
citizen-wallet-cli namespace-sign \
  --namespace civic-records \
  --operation create \
  --config '{"policies": {...}}'
```

### Builder-Credit Multisig Proof

```bash
citizen-wallet-cli builder-credit \
  --grant-id <grant-id> \
  --signers <signer1>,<signer2>,<signer3> \
  --threshold 3
```

## Network Selection

```bash
# Specify network per command
citizen-wallet-cli --network testnet submit --payload '...'

# Or set default network
citizen-wallet-cli config set network testnet
```

## Deterministic Receipt Validation

The CLI validates receipts deterministically — the receipt hash, signatures, and finality proof are independently verifiable without trusting the node:

```bash
citizen-wallet-cli verify-receipt --hash <entry-hash>
```

This makes the CLI the reference implementation for canonical signing behavior across all wallet surfaces.
