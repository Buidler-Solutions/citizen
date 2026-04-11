# Node Operator Key Generation Runbook (Validator / Observer)

This runbook defines the **first required setup step** before signed admission manifest generation:

1. generate operator cryptographic keys,
2. extract public keys for config + manifest payloads,
3. store private keys securely for runtime use.

If you do not complete this step first, you cannot correctly populate
`validator_allowlist[].public_key` in the admission manifest payload.

---

## 1) Why this comes first

Signed manifest payloads require validator public keys (`validator_id` + `public_key`) in
`validator_allowlist`.

Without operator keys, there is no trustworthy public key material to include in the
manifest payload.

---

## 2) Key roles (do not mix)

Use separate keys for separate responsibilities:

1. **Validator node signing key**
   - Used by the node at runtime (`signing_key_hex` in node config).
   - Public key is placed in the network validator allowlist and manifest payload.

2. **Manifest signer key**
   - Used only to sign the admission manifest artifact.
   - Passed to `scripts/generate_signed_manifest.sh --private-key`.

Do not reuse one key for every function in production environments.

---

## 3) Prerequisites

- `openssl`
- `python3` (optional helper checks)
- secure secret storage process (HSM, KMS, vault, or encrypted offline storage)

Verify tooling:

```bash
openssl version
python3 --version
```

---

## 4) Generate validator node key material (Ed25519)

## 4A) Generate validator node key material with standalone Rust devtool

From `citizen-protocol/` using the dedicated tooling crate (separate from node runtime binaries):

```bash
cargo run -p citizen-validator-keygen -- --validator-id validator-alpha --output-json ./validator-alpha-keys.json
```

The command prints:

- `public_key_hex` (for `validator_allowlist[].public_key`)
- `signing_key_hex` (for node `signing_key_hex`)

And optionally writes JSON at `--output-json` (owner-only permissions on Unix).

> Keep `signing_key_hex` secret and never commit generated key files.

---

Generate a validator private key PEM:

```bash
openssl genpkey -algorithm ED25519 -out ./validator-alpha-ed25519.pem
```

Derive the validator public key (32-byte hex):

```bash
VALIDATOR_PUB_HEX="$(openssl pkey -in ./validator-alpha-ed25519.pem -pubout -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')"
echo "$VALIDATOR_PUB_HEX"
```

Derive validator private key as raw hex for `signing_key_hex` use (if your operator policy allows file export):

```bash
VALIDATOR_PRIV_HEX="$(openssl pkey -in ./validator-alpha-ed25519.pem -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')"
echo "$VALIDATOR_PRIV_HEX"
```

Validation:

```bash
echo "$VALIDATOR_PUB_HEX"  | rg '^[0-9a-f]{64}$'
echo "$VALIDATOR_PRIV_HEX" | rg '^[0-9a-f]{64}$'
```

---

## 5) Put validator keys into node + manifest inputs

### 5.1 Node config (`signing_key_hex`)

In your node config:

```toml
validator_id = "validator-alpha"
signing_key_hex = "<VALIDATOR_PRIV_HEX>"
```

### 5.2 Admission manifest payload (`validator_allowlist`)

In `manifest.payload.json`:

```json
{
  "validator_allowlist": [
    {
      "validator_id": "validator-alpha",
      "public_key": "<VALIDATOR_PUB_HEX>"
    }
  ]
}
```

---

## 6) Generate manifest signer key material

Create a dedicated manifest signer key:

```bash
openssl genpkey -algorithm ED25519 -out ./manifest-signer-ed25519.pem
```

Derive manifest signer key-id (public key hex):

```bash
MANIFEST_KEY_ID="$(openssl pkey -in ./manifest-signer-ed25519.pem -pubout -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')"
echo "$MANIFEST_KEY_ID"
```

This `MANIFEST_KEY_ID` is the value for:

```bash
scripts/generate_signed_manifest.sh ... --key-id "$MANIFEST_KEY_ID"
```

---

## 7) Security handling requirements

- Never commit private keys (`*.pem`, private hex) to git.
- Restrict file permissions:

```bash
chmod 600 ./validator-alpha-ed25519.pem ./manifest-signer-ed25519.pem
```

- Prefer HSM/KMS for production key custody.
- Rotate keys through governance-controlled rollout when policy requires.

---

## 8) Next step (signed manifest generation)

After key generation is complete, continue with:

- `docs/ADMISSION_MANIFEST_GENERATION_HOWTO.md`

You now have the required inputs:

- validator public key(s) for `validator_allowlist`
- manifest signer private key + key id for signed manifest output

---

## 9) Minimal checklist

- [ ] Validator private key generated and stored securely.
- [ ] Validator public key extracted (64-hex) and recorded.
- [ ] Node `signing_key_hex` configured from validator private key material.
- [ ] Manifest signer private key generated (separate from validator key).
- [ ] Manifest signer key-id extracted (64-hex).
- [ ] Proceeded to signed manifest generation runbook.
