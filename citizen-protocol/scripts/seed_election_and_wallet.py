#!/usr/bin/env python3
"""Seed an election and mint a soulbound token for the user's wallet DID."""
import json, time, uuid, urllib.request

BASE = "http://127.0.0.1:8091"
MODULE_ID = "ctzn-token.v1"
WALLET_DID = "did:key:ed25519:16f65ce531f1bbc9b8a9ecf3b075278c96dd69fa6c4108f573f9e6069400b0c2"

def submit(ns, action, obj_id, payload_data, author="governance:vote"):
    payload = {
        "entry_id": str(uuid.uuid4()),
        "namespace": ns,
        "action": action,
        "object_id": obj_id,
        "payload": payload_data,
        "author": author,
        "signature": "placeholder",
        "timestamp": int(time.time()),
        "privacy_flag": False,
        "privacy_mode": "none",
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/entries/submit",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req)
    status = "✓" if resp.status == 202 else "✗"
    print(f"  {status} {resp.status} {action:20s} {obj_id}")
    return resp

# ── 1. Mint soulbound token for wallet DID ──────────────────────────
print("\n1. Minting CTZN soulbound token for wallet DID...")
TID = "tok-wallet-001"
submit("execution.module", "STATE_WRITE", MODULE_ID, {
    "module_id": MODULE_ID,
    "state_key": f"owner:{TID}",
    "state_value": WALLET_DID,
})
submit("execution.module", "STATE_WRITE", MODULE_ID, {
    "module_id": MODULE_ID,
    "state_key": f"owner_lookup:{WALLET_DID}",
    "state_value": TID,
})
submit("execution.module", "STATE_WRITE", MODULE_ID, {
    "module_id": MODULE_ID,
    "state_key": f"schema:{TID}",
    "state_value": "citizenship",
})
submit("execution.module", "STATE_WRITE", MODULE_ID, {
    "module_id": MODULE_ID,
    "state_key": f"tier:{TID}",
    "state_value": "2",
})

# ── 2. Open an election ─────────────────────────────────────────────
print("\n2. Opening election...")
ELECTION_ID = "elec-2028-national"
submit("civic.election", "OPEN_ELECTION", ELECTION_ID, {
    "title": "2028 National and Local Elections",
    "races": [
        {
            "race_id": "president",
            "title": "President",
            "seat_type": "single",
            "max_selections": 1,
            "candidates": [
                {"candidate_id": "pres-alyssa", "name": "Alyssa Ong", "party": "Partido ng Pagbabago"},
                {"candidate_id": "pres-bong", "name": "Bong Revilla Jr.", "party": "Lakas-CMD"},
                {"candidate_id": "pres-leni", "name": "Leni Robredo", "party": "Liberal Party"},
            ],
        },
        {
            "race_id": "senator",
            "title": "Senator (Top 12)",
            "seat_type": "multi",
            "max_selections": 12,
            "candidates": [
                {"candidate_id": "sen-mark", "name": "Mark Villar", "party": "Nacionalista"},
                {"candidate_id": "sen-risa", "name": "Risa Hontiveros", "party": "Akbayan"},
                {"candidate_id": "sen-kiko", "name": "Kiko Pangilinan", "party": "Liberal"},
                {"candidate_id": "sen-chel", "name": "Chel Diokno", "party": "Katropa"},
                {"candidate_id": "sen-grace", "name": "Grace Poe", "party": "Independent"},
            ],
        },
        {
            "race_id": "congress-qc-d1",
            "title": "Congressman, Quezon City District 1",
            "seat_type": "single",
            "max_selections": 1,
            "candidates": [
                {"candidate_id": "qc1-juan", "name": "Juan Dela Cruz", "party": "Independent"},
                {"candidate_id": "qc1-maria", "name": "Maria Santos", "party": "PPP"},
            ],
        },
        {
            "race_id": "mayor-manila",
            "title": "Mayor, City of Manila",
            "seat_type": "single",
            "max_selections": 1,
            "candidates": [
                {"candidate_id": "mnl-isko", "name": "Isko Moreno", "party": "Aksyon"},
                {"candidate_id": "mnl-honey", "name": "Honey Lacuna", "party": "Asenso"},
            ],
        },
    ],
})

# ── 3. Cast some sample ballots so tally isn't empty ────────────────
print("\n3. Casting sample ballots...")
sample_ballots = [
    ("did:citizen:alice", [
        {"race_id": "president", "candidate_ids": ["pres-leni"]},
        {"race_id": "senator", "candidate_ids": ["sen-risa", "sen-kiko", "sen-chel"]},
        {"race_id": "congress-qc-d1", "candidate_ids": ["qc1-maria"]},
        {"race_id": "mayor-manila", "candidate_ids": ["mnl-isko"]},
    ]),
    ("did:citizen:bob", [
        {"race_id": "president", "candidate_ids": ["pres-bong"]},
        {"race_id": "senator", "candidate_ids": ["sen-mark", "sen-grace"]},
        {"race_id": "mayor-manila", "candidate_ids": ["mnl-honey"]},
    ]),
    ("did:citizen:carol", [
        {"race_id": "president", "candidate_ids": ["pres-alyssa"]},
        {"race_id": "senator", "candidate_ids": ["sen-risa", "sen-grace", "sen-mark", "sen-kiko"]},
        {"race_id": "congress-qc-d1", "candidate_ids": ["qc1-juan"]},
    ]),
]

for did, selections in sample_ballots:
    ballot_id = f"ballot-{did.split(':')[-1]}-{ELECTION_ID}"
    submit("civic.election.ballot", "CAST_BALLOT", ballot_id, {
        "election_id": ELECTION_ID,
        "selections": selections,
    }, author=did)

print(f"\n{'='*60}")
print("Done! Verify:")
print(f"  CTZN check : {BASE}/api/v1/ctzn/{MODULE_ID}/check/{WALLET_DID}")
print(f"  Elections  : {BASE}/api/v1/civic/elections")
print(f"  Tally      : {BASE}/api/v1/civic/elections/{ELECTION_ID}/tally")
print(f"{'='*60}")
