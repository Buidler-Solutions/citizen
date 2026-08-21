# Citizen Node Join Kit

A reusable kit for generating a new validator node that syncs with and joins an existing Citizen network.

## Quick Start

```bash
cd citizen-protocol

# 1. Build the node binary
cargo build --release

# 2. Generate your node identity
python3 scripts/generate_node_identity.py --name my-validator

# 3. Fill in the template
cp config/join-kit/node-template.toml config/my-validator.toml
# Edit: replace {{PLACEHOLDER}} values with your generated identity
#       and the network's existing validator set + genesis namespaces

# 4. Start your node
./target/release/citizen-node --config config/my-validator.toml
```

## What Happens on Join

```
Your Node                          Existing Network (alpha, beta, gamma)
─────────                          ─────────────────────────────────────
1. Loads config + identity
2. Contacts bootstrap peers (QUIC)
3. Sends SyncRequest(from=1)  ──►  Receives request
                                  ◄──  Responds with blocks 1..50 (SyncResponse)
4. Verifies commit proofs
5. Requests next batch         ──►  Responds with blocks 51..100
   ... repeats until caught up ...
6. Enters consensus event loop ──►  Now voting on new blocks
```

Block sync happens automatically over QUIC — no manual intervention needed. Each block is verified with its BFT commit proof (>2/3 validator signatures).

## Generating Node Identity

Run the identity generator to produce a signing key and public key:

```bash
python3 scripts/generate_node_identity.py --name validator-delta
```

Output:

```
Node identity generated:
  Node ID:        validator-delta
  Signing key:    4f4e4d4c4b4a494847...  (keep this secret!)
  Public key:     d18363b47a874457...    (share this with network operators)
  Validator DID:  did:key:ed25519:d18363b47a874457...
```

## Template Placeholders

| Placeholder | Description | Example |
|---|---|---|
| `{{NODE_ID}}` | Your validator's unique ID | `validator-delta` |
| `{{SIGNING_KEY_HEX}}` | 64-char Ed25519 seed hex | `4f4e4d4c...3130` |
| `{{API_PORT}}` | HTTP API port | `8094` |
| `{{BIND_ADDR}}` | QUIC P2P bind address | `0.0.0.0:9213` |
| `{{MANIFEST_ENFORCE}}` | Require admission manifest | `false` (dev) / `true` (prod) |
| `{{CA_CERT_PATH}}` | TLS CA certificate | `config/certs/ca.der` |
| `{{CERT_CHAIN_PATH}}` | Your TLS certificate | `config/certs/my-node.der` |
| `{{PRIVATE_KEY_PATH}}` | Your TLS private key | `config/certs/my-node.key.der` |
| `{{NAMESPACES}}` | Genesis namespace definitions | Copy from existing node config |
| `{{VALIDATOR_SET}}` | All validators (existing + you) | See example below |
| `{{BOOTSTRAP_PEERS}}` | Initial peer QUIC addresses | See example below |

## Example: Joining a Triolet Network

If the existing network runs alpha (`127.0.0.1:9210`), beta (`127.0.0.1:9211`), gamma (`127.0.0.1:9212`):

```toml
# {{VALIDATOR_SET}}
[[validators]]
validator_id = "validator-alpha"
public_key = "4620ab7d0e5873a7afccdb514af28a3aa7b9b1b62694b1e3f568d38a6c4a17c2"
anchors = ["org:alpha"]

[[validators]]
validator_id = "validator-beta"
public_key = "dcb38143815f465d8d8d262812260ade8e721b3fe15da833ad477dd711ebc10f"
anchors = ["org:beta"]

[[validators]]
validator_id = "validator-gamma"
public_key = "1482e33d057c573003b7a18e1318c8eb12b847850b450e34a776fef7193a8739"
anchors = ["org:gamma"]

[[validators]]
validator_id = "validator-delta"
public_key = "d18363b47a874457bb0e5a2219af68190f9af942dd85c90a82814d36133f7125"
anchors = ["org:delta"]

# {{BOOTSTRAP_PEERS}}
[[peers]]
validator_id = "validator-alpha"
address = "127.0.0.1:9210"

[[peers]]
validator_id = "validator-beta"
address = "127.0.0.1:9211"

[[peers]]
validator_id = "validator-gamma"
address = "127.0.0.1:9212"
```

## TLS Certificates

Generate TLS certificates signed by the network's CA:

```bash
# Generate a new certificate signed by the existing CA
./scripts/generate_quic_cert.sh \
  --ca-cert config/certs/ca.der \
  --ca-key config/certs/ca.key.der \
  --name validator-delta \
  --output config/certs/
```

## Production: Governance-Gated Admission

For production networks, new validators require governance approval:

1. Generate node identity (as above)
2. Submit your public key as a validator admission proposal:
   ```bash
   citizen-wallet-cli propose-validator-admission \
     --validator-id validator-delta \
     --public-key d18363b47a874457... \
     --anchors org:delta
   ```
3. Existing validators vote on the proposal
4. Once approved (>2/3 quorum), start your node
5. The node syncs all blocks and joins consensus automatically

## Files

```
config/join-kit/
├── README.md              # This file
├── node-template.toml     # Template config with placeholders
└── examples/
    └── validator-delta.toml  # Complete example for triolet join
```
