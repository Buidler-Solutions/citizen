# Wallet Generation & Key Export Guide

This guide captures the exact CLI flows for generating a wallet key and viewing key material.

> ⚠️ Security warning: `secret_key_hex` is private key material. Do not share it, commit it, or paste it into logs.

## Seed phrase support

Wallet CLI now supports mnemonic-aware key flows:

- `keygen --with-mnemonic` generates a BIP-39 mnemonic, derives an Ed25519 key using hardened-path derivation, stores the encrypted secret key in the keystore, and prints the mnemonic once.
- `import-mnemonic` derives and imports a key from an existing mnemonic.
- `--mnemonic-passphrase` is optional for both flows.
- `--derivation-path` defaults to `m/44'/930'/0'/0'/0'` and accepts hardened segments only.

## 1) Generate a wallet key

```bash
cd citizen-protocol
export CITIZEN_WALLET_PASSWORD='change-me'
cargo run -p citizen-wallet --bin wallet -- keygen --path /tmp/citizen-wallet-test.json --label test
```

Expected output:

```text
Generated key <KEY_ID>
```

- `<KEY_ID>` is the wallet key identifier (`key_id`).
- The keystore file is written at `/tmp/citizen-wallet-test.json`.

### Mnemonic-backed key generation

```bash
cd citizen-protocol
export CITIZEN_WALLET_PASSWORD='change-me'
cargo run -p citizen-wallet --bin wallet -- keygen \
  --path /tmp/citizen-wallet-test.json \
  --label seed-backed \
  --with-mnemonic \
  --mnemonic-words 24 \
  --mnemonic-passphrase 'optional-passphrase' \
  --derivation-path "m/44'/930'/0'/0'/0'"
```

The CLI prints the mnemonic phrase once; store it securely offline.

### Import from existing mnemonic

```bash
cd citizen-protocol
export CITIZEN_WALLET_PASSWORD='change-me'
export CITIZEN_WALLET_MNEMONIC='<YOUR BIP39 PHRASE>'
cargo run -p citizen-wallet --bin wallet -- import-mnemonic \
  --path /tmp/citizen-wallet-test.json \
  --label recovered \
  --mnemonic-passphrase 'optional-passphrase' \
  --derivation-path "m/44'/930'/0'/0'/0'"
```

## 2) Show only wallet key (public key) and secret key in plain text

Replace `<KEY_ID>` with the generated key id:

```bash
cd citizen-protocol
cargo run -p citizen-wallet --bin wallet -- export-key \
  --path /tmp/citizen-wallet-test.json \
  --key-id <KEY_ID> \
  --include-secret \
  --password 'change-me' \
| jq -r '"wallet_key=" + .public_key_hex + "\nsecret_key=" + .secret_key_hex'
```

Expected output shape:

```text
wallet_key=<PUBLIC_KEY_HEX>
secret_key=<SECRET_KEY_HEX>
```

## 3) Alternative without `jq`

```bash
cd citizen-protocol
cargo run -p citizen-wallet --bin wallet -- export-key \
  --path /tmp/citizen-wallet-test.json \
  --key-id <KEY_ID> \
  --include-secret \
  --password 'change-me'
```

Read these two JSON fields:

- `public_key_hex` → wallet public key
- `secret_key_hex` → private/secret key in plaintext

## 4) Show public key only (safer default)

```bash
cd citizen-protocol
cargo run -p citizen-wallet --bin wallet -- public-key \
  --path /tmp/citizen-wallet-test.json \
  --key-id <KEY_ID>
```

This prints only `public_key_hex` and does not decrypt/export the secret key.
