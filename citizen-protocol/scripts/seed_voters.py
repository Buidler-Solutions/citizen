#!/usr/bin/env python3
"""Register voters with jurisdictions and CTZN tokens on triolet.

Usage:
    python3 scripts/seed_voters.py [ADMIN_DID]

The admin DID must already be assigned via seed_admin_and_election.py.
"""
import json, sys, time, uuid, urllib.request, urllib.parse, os, base64, hashlib
import nacl.signing
import nacl.encoding
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

BASE = "http://127.0.0.1:8091"
MODULE_ID = "ctzn-token.v1"
ADMIN_DID = sys.argv[1] if len(sys.argv) > 1 else "did:key:ed25519:f0481295842742b61db58ad33c721f7f61c273e58c837804b5126ea4946b40ad"

GOVERNANCE_SEED = b"citizen-gov-bootstrap-key-32b!!!"
governance_key = nacl.signing.SigningKey(GOVERNANCE_SEED)
governance_pub = governance_key.verify_key.encode(encoder=nacl.encoding.RawEncoder)
GOVERNANCE_DID = f"did:key:ed25519:{governance_pub.hex()}"


def canonical_json(obj):
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        entries = [f'{json.dumps(k)}:{canonical_json(obj[k])}' for k in keys]
        return "{" + ",".join(entries) + "}"
    elif isinstance(obj, list):
        return "[" + ",".join(canonical_json(item) for item in obj) + "]"
    else:
        return json.dumps(obj)


def sign_entry(author_did, signing_key, ns, action, obj_id, payload_data):
    entry_id = str(uuid.uuid4())
    timestamp = int(time.time())
    signing_payload = {
        "entry_id": entry_id, "namespace": ns, "action": action,
        "object_id": obj_id, "payload": payload_data,
        "author": author_did, "timestamp": timestamp,
    }
    canonical = canonical_json(signing_payload)
    signed = signing_key.sign(canonical.encode())
    entry = {
        "entry_id": entry_id, "namespace": ns, "action": action,
        "object_id": obj_id, "payload": payload_data,
        "author": author_did, "signature": signed.signature.hex(),
        "timestamp": timestamp, "privacy_flag": False, "privacy_mode": "none",
    }
    data = json.dumps(entry).encode()
    req = urllib.request.Request(f"{BASE}/api/v1/entries/submit", data=data,
        headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req)
        status = "OK" if resp.status == 202 else "ERR"
        print(f"  [{status}] {resp.status} {action:20s} {obj_id}")
        return resp
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  [ERR] {e.code} {action:20s} {obj_id} -- {body[:150]}")
        return e

# Use governance key (signature matches GOVERNANCE_DID public key)
SIGNER_DID = GOVERNANCE_DID
SIGNER_KEY = governance_key

KYC_ADMIN_PRIV_PEM = b"""\
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwjzmRVPeNaiI61UL
rY9yxFMWxJEwOvPtC4Wn5m0vCbChRANCAAT4nqetj6kTvhjtSfyYhcdPMUKeBoqP
6EGz/YG+b1nf3ID37f+KP8Xsh6b4gp+i3vGkj85xVuFu3UrThlZI7xF5
-----END PRIVATE KEY-----
"""

def load_kyc_private_key():
    return serialization.load_pem_private_key(KYC_ADMIN_PRIV_PEM, password=None)

def get_kyc_public_key_b64():
    key = load_kyc_private_key()
    raw = key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return base64.b64encode(raw).decode()

def encrypt_kyc_data(full_name, address, holder_priv_key=None):
    key = load_kyc_private_key()
    admin_pub = key.public_key()

    # Encrypt for admin
    ephemeral = ec.generate_private_key(ec.SECP256R1())
    shared_key = ephemeral.exchange(ec.ECDH(), admin_pub)
    derived = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None,
        info=b"citizen-kyc-encryption",
    ).derive(shared_key)
    nonce = os.urandom(12)
    aesgcm = AESGCM(derived)
    plaintext = json.dumps({"full_name": full_name, "address": address}).encode()
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    ephemeral_pub = ephemeral.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    commitment = hashlib.sha256(plaintext).hexdigest()
    result = {
        "ciphertext_hex": ciphertext.hex(),
        "nonce_hex": nonce.hex(),
        "epk": base64.b64encode(ephemeral_pub).decode(),
        "payload_commitment": f"sha256:{commitment}",
    }

    # Encrypt for holder (if holder key provided)
    if holder_priv_key is not None:
        holder_pub = holder_priv_key.public_key()
        eph2 = ec.generate_private_key(ec.SECP256R1())
        shared2 = eph2.exchange(ec.ECDH(), holder_pub)
        derived2 = HKDF(
            algorithm=hashes.SHA256(), length=32, salt=None,
            info=b"citizen-kyc-encryption",
        ).derive(shared2)
        nonce2 = os.urandom(12)
        aesgcm2 = AESGCM(derived2)
        ct2 = aesgcm2.encrypt(nonce2, plaintext, None)
        eph_pub2 = eph2.public_key().public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        result["holder_ciphertext_hex"] = ct2.hex()
        result["holder_nonce_hex"] = nonce2.hex()
        result["holder_epk"] = base64.b64encode(eph_pub2).decode()

    return result


def submit_encrypted_kyc(author_did, signing_key, voter_did, full_name, address):
    holder_key = ec.generate_private_key(ec.SECP256R1())
    enc = encrypt_kyc_data(full_name, address, holder_key)
    entry_id = str(uuid.uuid4())
    timestamp = int(time.time())
    entry_payload = {"epk": enc["epk"]}
    if "holder_ciphertext_hex" in enc:
        entry_payload["holder_ciphertext_hex"] = enc["holder_ciphertext_hex"]
        entry_payload["holder_nonce_hex"] = enc["holder_nonce_hex"]
        entry_payload["holder_epk"] = enc["holder_epk"]
    # Signing payload uses the same payload as the entry
    signing_payload = {
        "entry_id": entry_id, "namespace": "identity.kyc", "action": "SUBMIT_KYC",
        "object_id": voter_did, "payload": entry_payload, "author": author_did, "timestamp": timestamp,
    }
    canonical = canonical_json(signing_payload)
    signed = signing_key.sign(canonical.encode())
    entry = {
        "entry_id": entry_id, "namespace": "identity.kyc", "action": "SUBMIT_KYC",
        "object_id": voter_did, "payload": entry_payload, "author": author_did,
        "signature": signed.signature.hex(), "timestamp": timestamp,
        "privacy_flag": True, "privacy_mode": "hybrid",
        "ciphertext_hex": enc["ciphertext_hex"], "nonce_hex": enc["nonce_hex"],
        "payload_commitment": enc["payload_commitment"],
    }
    data = json.dumps(entry).encode()
    req = urllib.request.Request(f"{BASE}/api/v1/entries/submit", data=data,
        headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req)
        status = "OK" if resp.status == 202 else "ERR"
        print(f"  [{status}] {resp.status} SUBMIT_KYC (encrypted)  {voter_did}")
        return resp
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  [ERR] {e.code} SUBMIT_KYC  {voter_did} -- {body[:150]}")
        return e


def publish_kyc_public_key():
    pk_b64 = get_kyc_public_key_b64()
    sign_entry(SIGNER_DID, SIGNER_KEY, "civic.admin", "SET_KYC_PUBLIC_KEY", "kyc-encryption-key", {
        "kyc_encryption_public_key": pk_b64,
    })


def submit_raw(obj_id, payload_data, author="system"):
    entry = {
        "entry_id": str(uuid.uuid4()),
        "namespace": "execution.module",
        "action": "STATE_WRITE",
        "object_id": obj_id,
        "payload": payload_data,
        "author": author,
        "signature": "placeholder",
        "timestamp": int(time.time()),
        "privacy_flag": False,
        "privacy_mode": "none",
    }
    data = json.dumps(entry).encode()
    req = urllib.request.Request(f"{BASE}/api/v1/entries/submit", data=data,
        headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req)
        status = "OK" if resp.status == 202 else "ERR"
        print(f"  [{status}] {resp.status} STATE_WRITE          {obj_id}")
        return resp
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  [ERR] {e.code} STATE_WRITE          {obj_id} -- {body[:120]}")
        return e


# Generate wallet DIDs for voters
voter_keys = {
    "alice-qc": b"voter-alice-qc-seed-32bytes!!!01",
    "bob-manila": b"voter-bob-manila-seed-32bytes!!!",
    "carol-makati": b"voter-carol-makati-32bytes-seed!",
    "dave-unreg": b"voter-dave-unreg-seed-32bytes!!!",
}

print("Voter DIDs:")
voters = {}
for name, seed in voter_keys.items():
    key = nacl.signing.SigningKey(seed)
    pub = key.verify_key.encode(encoder=nacl.encoding.RawEncoder)
    did = f"did:key:ed25519:{pub.hex()}"
    voters[name] = {"did": did, "key": key}
    print(f"  {name}: {did}")

# ── 1. Mint CTZN tokens for voters ──────────────────────────────────
print("\n1. Minting CTZN soulbound tokens...")
for name, v in voters.items():
    tid = f"tok-{name}"
    for key, val in [
        ("owner", tid),
        ("schema", "citizenship"),
        ("tier", "2"),
        ("held", v["did"]),
    ]:
        submit_raw(MODULE_ID, {
            "module_id": MODULE_ID,
            "state_key": f"{key}:{tid if key != 'held' else v['did']}",
            "state_value": val,
        })

# Jurisdiction map for voters
voter_jurisdictions = {
    "alice-qc": ["PH", "NCR", "Quezon City", "District 1"],
    "bob-manila": ["PH", "NCR", "Manila", "District 2"],
    "carol-makati": ["PH", "NCR", "Makati"],
}

# ── 2. Submit encrypted KYC (admin must publish key first via console) ─
print("\n2. Submitting encrypted KYC and approving...")
for name, v in voters.items():
    if name not in voter_jurisdictions:
        print(f"  [SKIP] {name}: no jurisdiction (unregistered)")
        continue
    # Voter signs SUBMIT_KYC — cleartext for seed data
    sign_entry(v["did"], v["key"], "identity.kyc", "SUBMIT_KYC", v["did"], {
        "full_name": f"{name.title().replace('-', ' ')} Citizen",
        "address": f"123 {name.title().replace('-', ' ')} St",
    })
    time.sleep(2)
    # Admin approves KYC
    sign_entry(SIGNER_DID, SIGNER_KEY, "identity.kyc", "APPROVE_KYC", v["did"], {
        "jurisdiction_path": voter_jurisdictions[name],
    })
    time.sleep(1)

# ── 3. Open election and verify eligibility ──────────────────────────
# Note: KYC approval (step 2) IS voter registration. No separate REGISTER_VOTER needed.
print("\n3. Opening mixed-jurisdiction election...")
ELECTION_ID = "elec-2028-jurisdictional"
sign_entry(
    SIGNER_DID, SIGNER_KEY,
    "civic.election", "OPEN_ELECTION", ELECTION_ID,
    {
        "title": "2028 National and Local Elections",
        "races": [
            {
                "race_id": "president",
                "title": "President",
                "seat_type": "single",
                "max_selections": 1,
                "jurisdiction": ["PH"],
                "candidates": [
                    {"candidate_id": "p1", "name": "A. President", "party": "Party A"},
                    {"candidate_id": "p2", "name": "B. President", "party": "Party B"},
                ],
            },
            {
                "race_id": "mayor-qc",
                "title": "Mayor, Quezon City",
                "seat_type": "single",
                "max_selections": 1,
                "jurisdiction": ["PH", "NCR", "Quezon City"],
                "candidates": [
                    {"candidate_id": "qc1", "name": "QC Mayor A", "party": "Party A"},
                    {"candidate_id": "qc2", "name": "QC Mayor B", "party": "Party B"},
                ],
            },
            {
                "race_id": "mayor-manila",
                "title": "Mayor, Manila",
                "seat_type": "single",
                "max_selections": 1,
                "jurisdiction": ["PH", "NCR", "Manila"],
                "candidates": [
                    {"candidate_id": "mn1", "name": "Manila Mayor A", "party": "Party A"},
                    {"candidate_id": "mn2", "name": "Manila Mayor B", "party": "Party B"},
                ],
            },
        ],
    },
)

# ── 4. Verify eligibility for each voter ───────────────────────────
print("\n4. Verifying voter eligibility...")
for name, v in voters.items():
    did = v["did"]
    safe_did = urllib.parse.quote(did, safe='')
    try:
        req = urllib.request.Request(
            f"{BASE}/api/v1/civic/elections/{ELECTION_ID}/eligibility/{safe_did}"
        )
        resp = urllib.request.urlopen(req)
        data = json.loads(resp.read())
        eligible = [r["race_id"] for r in data.get("eligible_races", [])]
        ineligible = [r["race_id"] for r in data.get("ineligible_races", [])]
        print(f"  {name}: registered={data.get('is_registered')} eligible={eligible} ineligible={ineligible}")
    except Exception as e:
        print(f"  {name}: [ERR] {e}")

print(f"\nDone. Voter eligibility for election '{ELECTION_ID}':")
print(f"  alice-qc  (QC D1):    president + mayor-qc")
print(f"  bob-manila (Manila D2): president + mayor-manila")
print(f"  carol-makati:           president only")
print(f"  dave-unreg:             NONE (not registered, no CTZN token → fails both checks)")
