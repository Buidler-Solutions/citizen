#!/usr/bin/env python3
"""
Generate a Citizen node config for joining an existing network.

Works with any number of existing validators — just provide the network's
current validator set and bootstrap peer list.

Examples:
    # From a network definition file
    python3 scripts/generate_join_config.py \\
        --node-id validator-delta \\
        --signing-key 4f4e4d4c4b4a494847464544434241403f3e3d3c3b3a39383736353433323130 \\
        --api-port 8094 \\
        --bind-addr 0.0.0.0:9213 \\
        --network-file config/triolet/triolet-network.toml \\
        --genesis-ns-file config/triolet/triolet-namespaces.toml \\
        --output config/validator-delta.toml

    # Manually specifying validators and peers
    python3 scripts/generate_join_config.py \\
        --node-id my-validator \\
        --signing-key <hex> \\
        --api-port 9001 \\
        --bind-addr 0.0.0.0:9100 \\
        --existing-validators alpha:abc123:org:alpha beta:def456:org:beta \\
        --bootstrap-peers alpha:192.168.1.1:9200 beta:192.168.1.2:9210 \\
        --genesis-ns-file config/triolet/triolet-namespaces.toml \\
        --output config/my-validator.toml
"""

import argparse
import secrets
import sys
from pathlib import Path


def generate_identity(name: str):
    """Generate a random Ed25519 keypair."""
    import nacl.signing
    import nacl.encoding

    seed = secrets.token_bytes(32)
    sk = nacl.signing.SigningKey(seed)
    pk = sk.verify_key.encode(encoder=nacl.encoding.RawEncoder).hex()
    return seed.hex(), pk


def format_validator_entry(node_id: str, pubkey: str, anchors: str) -> str:
    """Format a [[validators]] TOML entry."""
    anchor_list = ", ".join(f'"{a.strip()}"' for a in anchors.split(","))
    return f"""[[validators]]
validator_id = "{node_id}"
public_key = "{pubkey}"
anchors = [{anchor_list}]"""


def format_peer_entry(node_id: str, address: str) -> str:
    """Format a [[peers]] TOML entry."""
    return f"""[[peers]]
validator_id = "{node_id}"
address = "{address}\""""


def parse_validator_arg(arg: str) -> tuple:
    """Parse 'id:pubkey:anchors' format."""
    parts = arg.split(":")
    if len(parts) < 2:
        raise ValueError(f"Invalid validator format: {arg}. Expected 'id:pubkey[:anchors]'")
    node_id = parts[0]
    pubkey = parts[1]
    anchors = parts[2] if len(parts) > 2 else f"org:{node_id}"
    return node_id, pubkey, anchors


def parse_peer_arg(arg: str) -> tuple:
    """Parse 'id:host:port' or 'id:address' format."""
    parts = arg.split(":")
    if len(parts) == 2:
        return parts[0], parts[1]
    elif len(parts) >= 3:
        # id:host:port
        return parts[0], ":".join(parts[1:])
    raise ValueError(f"Invalid peer format: {arg}. Expected 'id:address'")


def load_network_file(path: str) -> tuple:
    """Load validators and peers from a TOML network definition file."""
    try:
        import tomllib  # Python 3.11+
    except ImportError:
        import tomli as tomllib

    with open(path, "rb") as f:
        data = tomllib.load(f)

    validators = []
    peers = []

    for v in data.get("validators", []):
        anchors = v.get("anchors", [f"org:{v['validator_id']}"])
        if isinstance(anchors, list):
            anchors_str = ", ".join(anchors)
        else:
            anchors_str = str(anchors)
        validators.append((v["validator_id"], v["public_key"], anchors_str))

    for p in data.get("peers", []):
        peers.append((p["validator_id"], p["address"]))

    return validators, peers


def load_namespaces(path: str) -> str:
    """Extract namespace definitions from a TOML file, return as TOML string."""
    with open(path) as f:
        content = f.read()

    # Find all [[namespaces]] blocks
    lines = content.split("\n")
    ns_blocks = []
    in_ns = False
    current_block = []

    for line in lines:
        if line.strip().startswith("[[namespaces]]"):
            if current_block:
                ns_blocks.append("\n".join(current_block))
            current_block = [line]
            in_ns = True
        elif in_ns:
            if line.strip().startswith("[[") or line.strip().startswith("["):
                # End of namespaces block — check if it's another [[namespaces]]
                if line.strip().startswith("[[namespaces]]"):
                    ns_blocks.append("\n".join(current_block))
                    current_block = [line]
                else:
                    ns_blocks.append("\n".join(current_block))
                    in_ns = False
                    current_block = []
            else:
                current_block.append(line)

    if current_block:
        ns_blocks.append("\n".join(current_block))

    return "\n\n".join(ns_blocks)


def build_config(
    node_id: str,
    signing_key_hex: str,
    api_port: int,
    bind_addr: str,
    validators: list,
    peers: list,
    namespaces_toml: str,
    manifest_enforce: bool = False,
    data_dir: str = None,
    ca_cert: str = "config/certs/ca.der",
    cert_chain: str = None,
    private_key: str = None,
) -> str:
    """Build the complete TOML config string."""

    if data_dir is None:
        data_dir = f"data/{node_id}"
    if cert_chain is None:
        cert_chain = f"config/certs/{node_id}.der"
    if private_key is None:
        private_key = f"config/certs/{node_id}.key.der"

    config = f"""# =============================================================================
# Citizen Validator Config — {node_id}
# Generated: join-kit
# =============================================================================

validator_id = "{node_id}"
block_time_millis = 1000
quorum_bps = 6667
signing_key_hex = "{signing_key_hex}"
manifest_enforce = {str(manifest_enforce).lower()}
api_port = {api_port}
data_dir = "{data_dir}"
bind_addr = "{bind_addr}"
network_key_rotation_secs = 3600

[quic_tls]
ca_cert_path = "{ca_cert}"
cert_chain_path = "{cert_chain}"
private_key_path = "{private_key}"

# ═══════════════════════════════════════════════════════════════════════════
# NAMESPACE RATE LIMITS
# ═══════════════════════════════════════════════════════════════════════════
[namespace_rate_limits]
"governance.vote" = 50
"civic.proposal" = 50
"civic.ballot" = 100
"audit.procurement" = 60
"builder.credits" = 20

# ═══════════════════════════════════════════════════════════════════════════
# APPLICATION NAMESPACES (from genesis)
# ═══════════════════════════════════════════════════════════════════════════

{namespaces_toml}

# ═══════════════════════════════════════════════════════════════════════════
# VALIDATOR SET ({len(validators)} validators: {len(validators) - 1} existing + this node)
# ═══════════════════════════════════════════════════════════════════════════

"""
    for node_id_v, pubkey, anchors in validators:
        config += format_validator_entry(node_id_v, pubkey, anchors) + "\n\n"

    config += f"""# ═══════════════════════════════════════════════════════════════════════════
# BOOTSTRAP PEERS ({len(peers)} peers)
# ═══════════════════════════════════════════════════════════════════════════

"""
    for node_id_p, addr in peers:
        config += format_peer_entry(node_id_p, addr) + "\n\n"

    return config


def main():
    parser = argparse.ArgumentParser(
        description="Generate a Citizen node config for joining an existing network",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--node-id", required=True, help="Your validator ID")
    parser.add_argument(
        "--signing-key",
        help="64-char Ed25519 seed hex (omit to auto-generate)",
    )
    parser.add_argument("--api-port", type=int, required=True, help="HTTP API port")
    parser.add_argument("--bind-addr", required=True, help="QUIC bind address (e.g. 0.0.0.0:9213)")
    parser.add_argument("--output", required=True, help="Output TOML file path")

    # Network definition
    parser.add_argument(
        "--network-file",
        help="TOML file with [[validators]] and [[peers]] from existing network",
    )
    parser.add_argument(
        "--existing-validators",
        nargs="+",
        help="Space-separated list: 'id:pubkey[:anchors] id:pubkey[:anchors] ...'",
    )
    parser.add_argument(
        "--bootstrap-peers",
        nargs="+",
        help="Space-separated list: 'id:address id:address ...'",
    )

    # Namespaces (genesis)
    parser.add_argument(
        "--genesis-ns-file",
        required=True,
        help="TOML file containing [[namespaces]] definitions from genesis",
    )

    # Optional
    parser.add_argument("--manifest-enforce", action="store_true", help="Require admission manifest")
    parser.add_argument("--data-dir", help="Custom data directory")
    parser.add_argument("--ca-cert", default="config/certs/ca.der")
    parser.add_argument("--tls-cert", help="TLS certificate path")
    parser.add_argument("--tls-key", help="TLS private key path")

    args = parser.parse_args()

    # Resolve validators and peers
    validators = []
    peers = []

    if args.network_file:
        validators, peers = load_network_file(args.network_file)

    if args.existing_validators:
        for v in args.existing_validators:
            validators.append(parse_validator_arg(v))

    if args.bootstrap_peers:
        for p in args.bootstrap_peers:
            peers.append(parse_peer_arg(p))

    if not validators:
        print("ERROR: No validators specified. Use --network-file or --existing-validators.")
        sys.exit(1)

    if not peers:
        print("WARNING: No bootstrap peers specified. Node will have no one to contact.")

    # Resolve signing key
    signing_key = args.signing_key
    if not signing_key:
        signing_key, pubkey = generate_identity(args.node_id)
        print(f"\n  Auto-generated signing key: {signing_key}")
        print(f"  Public key:                {pubkey}")
        print(f"  Share this public key with existing operators.\n")
    else:
        try:
            import nacl.signing
            import nacl.encoding
            sk = nacl.signing.SigningKey(bytes.fromhex(signing_key))
            pubkey = sk.verify_key.encode(encoder=nacl.encoding.RawEncoder).hex()
        except ImportError:
            pubkey = "<install pynacl to derive>"

    # Add this node to the validator set
    anchors = f"org:{args.node_id}"
    validators.append((args.node_id, pubkey, anchors))

    # Load namespaces
    namespaces_toml = load_namespaces(args.genesis_ns_file)

    # Build and write config
    config = build_config(
        node_id=args.node_id,
        signing_key_hex=signing_key,
        api_port=args.api_port,
        bind_addr=args.bind_addr,
        validators=validators,
        peers=peers,
        namespaces_toml=namespaces_toml,
        manifest_enforce=args.manifest_enforce,
        data_dir=args.data_dir,
        ca_cert=args.ca_cert,
        cert_chain=args.tls_cert,
        private_key=args.tls_key,
    )

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w") as f:
        f.write(config)

    print(f"\n  ✓ Config written to: {args.output}")
    print(f"  ✓ Validators in set: {len(validators)}")
    print(f"  ✓ Bootstrap peers:   {len(peers)}")
    print(f"\n  Start your node:")
    print(f"    ./target/release/citizen-node --config {args.output}")


if __name__ == "__main__":
    main()
