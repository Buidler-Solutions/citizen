# Citizen Wallet CLI

This folder contains the standalone wallet CLI binary backed by the
`citizen-wallet` library crate.

## Usage
```bash
cargo run -p citizen-wallet-cli -- --help
```

## Run without `cargo run`

If you want to invoke the CLI directly as `citizen-wallet-cli`, install it once
from the workspace (or from the monorepo root with a manifest path):

```bash
# from citizen-protocol/
cargo install --path wallet/cli

# from monorepo root (/workspace/citizen)
cargo install --path wallet/cli --root "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

Then run:

```bash
citizen-wallet-cli --help
```

## Implemented command groups
- Key lifecycle: `init`, `keygen`, `import-key`, `import-mnemonic`, `list-keys`, `public-key`, `export-key`
- Entry signing: `sign-entry`, `sign-identity-register`, `sign-governance-vote`,
  `sign-registry-transfer`, `sign-audit-record`, `sign-builder-credit-grant`,
  `sign-sponsor-usage`
- Verification: `verify-entry`, `verify-receipt`
- Submission + receipts: `submit`, `submit-envelope`, `list-receipts`
- Multisig compose workflow: `compose-envelope-init`, `compose-envelope-sign`,
  `compose-envelope-finalize`
- Governance policy controls: `sign-governance-vote --required-approvals --policy-approver --approval`

## Mnemonic compatibility mode (wallet extension + node runtime CLI)

- `keygen --with-mnemonic` now accepts `--mnemonic-words 12` or `--mnemonic-words 24` only.
- `import-mnemonic` enforces 12-word or 24-word phrases so extension-imported wallets and CLI-created wallets stay aligned.

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
  --endpoint /api/v1/envelopes/submit \
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

## Governance policy-gated vote signing

You can require explicit approvals before the CLI signs a governance vote:

```bash
cargo run -p citizen-wallet-cli -- sign-governance-vote \
  --path ./tmp/wallet.json \
  --key-id <KEY_ID> \
  --proposal-id GOV-042 \
  --vote YES \
  --validator did:ledger:validator:a \
  --author did:ledger:validator:a \
  --required-approvals 2 \
  --policy-approver validator-a \
  --policy-approver validator-b \
  --approval validator-a \
  --approval validator-b
```


## Strict builder-credit helper commands

Create a `builder.credits` grant envelope using strict action naming:

```bash
cargo run -p citizen-wallet-cli -- sign-builder-credit-grant   --path ./tmp/wallet.json   --key-id <KEY_ID>   --grant-id grant:builder:alpha:q1   --amount 1000   --author did:ledger:builder:alpha   --sponsor-builder-id did:ledger:builder:alpha   --target-builder-id did:ledger:builder:alpha   --multisig-proofs-json '[{"approver":"approver-a","public_key":"<HEX>","signature":"<HEX>"}]'
```

Create a sponsorship usage envelope linked to an active grant:

```bash
cargo run -p citizen-wallet-cli -- sign-sponsor-usage   --path ./tmp/wallet.json   --key-id <KEY_ID>   --sponsorship-id spn-2026-03-02-00001   --credit-grant-id grant:builder:alpha:q1   --amount 25   --sponsored-did did:ledger:user:publisher-01   --author did:ledger:builder:alpha   --sponsor-builder-id did:ledger:builder:alpha
```

## Multisigner envelope compose flow

```bash
# 1) Initialize a multisig draft artifact
cargo run -p citizen-wallet-cli -- compose-envelope-init \
  --entry-json "$(cat ./tmp/entry.json)" \
  --path ./tmp/wallet.json \
  --key-id <ALICE_KEY_ID> \
  --signer did:key:alice \
  --threshold 2 \
  --allowed-signer did:key:alice \
  --allowed-signer did:key:bob \
  --output ./tmp/draft.json

# 2) Add co-signature from another signer identity
cargo run -p citizen-wallet-cli -- compose-envelope-sign \
  --draft-json "$(cat ./tmp/draft.json)" \
  --path ./tmp/wallet.json \
  --key-id <BOB_KEY_ID> \
  --as did:key:bob \
  --output ./tmp/draft.json

# 3) Finalize once threshold is met
cargo run -p citizen-wallet-cli -- compose-envelope-finalize \
  --draft-json "$(cat ./tmp/draft.json)" > ./tmp/envelope.json

# 4) Submit finalized envelope
cargo run -p citizen-wallet-cli -- submit-envelope \
  --envelope-json "$(cat ./tmp/envelope.json)" \
  --api-url http://127.0.0.1:8080 \
  --endpoint /api/v1/envelopes/submit \
  --receipts-path ./tmp/wallet-receipts.json
```
