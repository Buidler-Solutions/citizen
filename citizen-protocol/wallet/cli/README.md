# Citizen Wallet CLI

This folder contains the standalone wallet CLI binary backed by the
`citizen-wallet` library crate.

## Usage
```bash
cargo run -p citizen-wallet-cli -- --help
```

## Implemented command groups
- Key lifecycle: `init`, `keygen`, `import-key`, `list-keys`, `public-key`, `export-key`
- Entry signing: `sign-entry`, `sign-identity-register`, `sign-governance-vote`,
  `sign-registry-transfer`, `sign-audit-record`
- Verification: `verify-entry`, `verify-receipt`
- Submission + receipts: `submit`, `list-receipts`

## Localnet example flow

1. Initialize a keystore and create a key:
```bash
export CITIZEN_WALLET_PASSWORD='localnet-password'
cargo run -p citizen-wallet-cli -- init --path ./tmp/wallet.json
cargo run -p citizen-wallet-cli -- keygen --path ./tmp/wallet.json --label localnet
```

2. List keys and copy the generated `key_id`:
```bash
cargo run -p citizen-wallet-cli -- list-keys --path ./tmp/wallet.json
```

3. Sign an entry:
```bash
cargo run -p citizen-wallet-cli -- sign-audit-record \
  --path ./tmp/wallet.json \
  --key-id <KEY_ID> \
  --event BID_OPENED \
  --document-hash 0xabc123 \
  --audit-id AUD-001 \
  --author did:ledger:operator > ./tmp/entry.json
```

4. Submit to a node API and persist receipt:
```bash
cargo run -p citizen-wallet-cli -- submit \
  --entry-json "$(cat ./tmp/entry.json)" \
  --api-url http://127.0.0.1:8080 \
  --endpoint /api/v1/entries/submit \
  --receipts-path ./tmp/wallet-receipts.json
```

5. Verify inclusion using the returned receipt and the signed entry:
```bash
cargo run -p citizen-wallet-cli -- verify-receipt \
  --receipt-json "$(cat ./tmp/receipt.json)" \
  --entry-json "$(cat ./tmp/entry.json)"
```


## E2E smoke test

```bash
./scripts/run_wallet_cli_e2e.sh
```
