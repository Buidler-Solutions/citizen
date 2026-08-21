#!/usr/bin/env python3
"""Generate a Citizen node identity (Ed25519 keypair) for joining a network."""

import argparse
import secrets
import nacl.signing
import nacl.encoding


def generate_identity(name: str):
    """Generate a random Ed25519 keypair and print identity information."""
    seed = secrets.token_bytes(32)
    sk = nacl.signing.SigningKey(seed)
    pk = sk.verify_key
    pk_hex = pk.encode(encoder=nacl.encoding.RawEncoder).hex()
    seed_hex = seed.hex()

    print()
    print("=" * 72)
    print("  NODE IDENTITY GENERATED")
    print("=" * 72)
    print()
    print(f"  Node ID:            {name}")
    print(f"  Signing key (hex):  {seed_hex}")
    print(f"  Public key (hex):   {pk_hex}")
    print(f"  Validator DID:      did:key:ed25519:{pk_hex}")
    print()
    print("  ═══ SAVE THESE VALUES ═══")
    print()
    print(f"  For your config:")
    print(f"    validator_id  = \"{name}\"")
    print(f"    signing_key_hex = \"{seed_hex}\"")
    print()
    print(f"  Share with network operators (public key only):")
    print(f"    [[validators]]")
    print(f"    validator_id = \"{name}\"")
    print(f"    public_key   = \"{pk_hex}\"")
    print(f"    anchors      = [\"org:{name}\"]")
    print()
    print(f"  Add to your peer list:")
    print(f"    [[peers]]")
    print(f"    validator_id = \"{name}\"")
    print(f"    address      = \"<your-ip>:<your-quic-port>\"")
    print()
    print("=" * 72)
    print()

    return {
        "node_id": name,
        "signing_key_hex": seed_hex,
        "public_key_hex": pk_hex,
        "did": f"did:key:ed25519:{pk_hex}",
    }


def main():
    parser = argparse.ArgumentParser(
        description="Generate a Citizen node identity for joining a network"
    )
    parser.add_argument(
        "--name",
        required=True,
        help="Node identifier (e.g. validator-delta)",
    )
    args = parser.parse_args()
    generate_identity(args.name)


if __name__ == "__main__":
    main()
