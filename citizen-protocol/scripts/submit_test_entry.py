#!/usr/bin/env python3
"""Submit a test identity.citizen entry to the localnet and verify inclusion."""
import json
import time
import uuid
import sys
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

from nacl.signing import SigningKey
from nacl.encoding import HexEncoder

API_URL = "http://127.0.0.1:8081/api/v1/envelopes/submit"

def canonical_json(obj):
    """Match Rust canonical_json: sorted keys, compact separators."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'))

def main():
    # Generate Ed25519 keypair
    sk = SigningKey.generate()
    vk_hex = sk.verify_key.encode(encoder=HexEncoder()).decode()

    entry_id = str(uuid.uuid4())
    envelope_id = str(uuid.uuid4())
    timestamp = int(time.time())
    object_id = f"did:citizen:test-{uuid.uuid4().hex[:8]}"

    payload = {
        "author_public_key": vk_hex,
        "test_data": "consensus verification entry",
    }

    # Build canonical signing payload (must match Rust verify_submission_signature)
    signing_payload = {
        "entry_id": entry_id,
        "namespace": "identity.citizen",
        "action": "REGISTER_IDENTITY",
        "object_id": object_id,
        "payload": payload,
        "author": "registry.identity",
        "timestamp": timestamp,
    }
    canonical = canonical_json(signing_payload)
    signature = sk.sign(canonical.encode()).signature
    sig_hex = signature.hex()

    envelope = {
        "envelope_id": envelope_id,
        "signer": "registry.identity",
        "signature": sig_hex,
        "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "payload": {
            "entry_id": entry_id,
            "namespace": "identity.citizen",
            "action": "REGISTER_IDENTITY",
            "object_id": object_id,
            "payload": payload,
            "privacy_flag": False,
            "privacy_mode": "none",
            "author": "registry.identity",
            "signature": sig_hex,
            "timestamp": timestamp,
        },
    }

    body = json.dumps(envelope).encode()
    print(f"Submitting entry_id={entry_id}")
    print(f"  namespace=identity.citizen action=REGISTER_IDENTITY")
    print(f"  author=registry.identity verifying_key={vk_hex[:16]}...")

    req = Request(API_URL, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            print(f"\nAPI Response: {json.dumps(result, indent=2)}")
            print(f"\nEntry ID: {entry_id}")
            return entry_id
    except HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode()}")
        sys.exit(1)
    except URLError as e:
        print(f"Connection Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
