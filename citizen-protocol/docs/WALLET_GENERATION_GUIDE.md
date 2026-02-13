# Wallet Generation & Key Export Guide

This guide captures the exact CLI flows for generating a wallet key and viewing key material.

> ⚠️ Security warning: `secret_key_hex` is private key material. Do not share it, commit it, or paste it into logs.

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
