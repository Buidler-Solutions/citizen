# API Consensus Sync Baseline Evidence (20260408T103357Z)

## Mode
- validator configs forced to `api_local_finalize_mode = true` during this run

## Submission
```json
{"entry_id":"8f7fcfe8-4126-4ed3-8afd-25a409ae9604","namespace":"registry.land","action":"TRANSFER_OWNERSHIP","object_id":"LOT-API-CONSENSUS-SYNC-BASELINE-20260408T103357Z","payload":{"from":"did:citizen:alpha","to":"did:citizen:beta","author_public_key":"2b3d71e5a8954922444a2a0bc82cc36d35c745c91dc3550e10b2c50f4589048a"},"author":"registry.land","timestamp":1775644437,"signature":"e2d66fe8aaf9da4ed40b8c510043d38b56fb11746e4f4c5e612fca956f8de04afc5648c332fbf3dcb4b3f881cea0b5c07f1383374d25f1f7419ed46ef14b010b"}
```

### Alpha submit response
```json
{
  "entry_id": "8f7fcfe8-4126-4ed3-8afd-25a409ae9604",
  "namespace": "registry.land",
  "receipt": {
    "envelope_id": "3452b708-597b-42e1-9f57-184a6d07bf2f",
    "finality": {
      "block_hash": "532eef88bafe08f21cc7037363ee32255e1438677cf483391071b6bd515af857",
      "block_height": 2,
      "commit_proof": {
        "aggregated_signature": "local-dev-finality",
        "participant_ids": []
      }
    },
    "receipt_id": "afc650db-4938-4447-80b9-86d161177278",
    "recorded_at": "2026-04-08T10:33:59.220139635Z",
    "status": "Accepted",
    "validation": {
      "action": "TRANSFER_OWNERSHIP",
      "namespace": "registry.land",
      "outcome": "namespace rules accepted and finalized"
    }
  },
  "status": "accepted"
}
```

## Divergence check
- Alpha contains entry: true
- Beta contains entry: false
- Gamma contains entry: false
- Entry counts (alpha/beta/gamma): 2/0/0
- Heights (alpha/beta/gamma): 2/0/0

## API snapshots
### Alpha registry.land entries
```json
[
  {
    "action": "TRANSFER_OWNERSHIP",
    "author": "registry.land",
    "entry_id": "8f7fcfe8-4126-4ed3-8afd-25a409ae9604",
    "namespace": "registry.land",
    "object_id": "LOT-API-CONSENSUS-SYNC-BASELINE-20260408T103357Z",
    "payload": {
      "author_public_key": "2b3d71e5a8954922444a2a0bc82cc36d35c745c91dc3550e10b2c50f4589048a",
      "from": "did:citizen:alpha",
      "to": "did:citizen:beta"
    },
    "privacy_flag": false,
    "privacy_mode": "none",
    "signature": "e2d66fe8aaf9da4ed40b8c510043d38b56fb11746e4f4c5e612fca956f8de04afc5648c332fbf3dcb4b3f881cea0b5c07f1383374d25f1f7419ed46ef14b010b",
    "timestamp": 1775644437
  },
  {
    "action": "TRANSFER_OWNERSHIP",
    "author": "registry.land",
    "entry_id": "ab473373-ab24-4ec2-8a73-39052255b4af",
    "namespace": "registry.land",
    "object_id": "LOT-API-CONSENSUS-SYNC-BASELINE",
    "payload": {
      "author_public_key": "90c2277d74954f7365935f6f436cd6acae446c1160955f731ec812c5b2bff1a9",
      "from": "did:citizen:alpha",
      "to": "did:citizen:beta"
    },
    "privacy_flag": false,
    "privacy_mode": "none",
    "signature": "d5289e199aca9a23e06bbbe325671ae2077f6e97ac46e8f0bd6359756edda9de6eac45885315062dd89e8bff80801d80e97fce36f184b1152c523312f94c7204",
    "timestamp": 1775644279
  }
]
```

### Beta registry.land entries
```json
[]
```

### Gamma registry.land entries
```json
[]
```

## Node log tails
```text
2026-04-08T10:33:57.507043Z  INFO validator_id=validator-alpha block_time_ms=1000 quorum_bps=8000 loaded_config=/tmp/tmp.cggNZIB1fd/validator-alpha.toml
2026-04-08T10:33:57.707804Z  INFO admission preflight passed network_id=citizen-localnet genesis_hash=66729876a187b18fa68c7bb08cd3622455416107adf99ca9b64def6f746ed934 manifest_digest=manifest-not-enforced manifest_version=None
2026-04-08T10:33:57.708579Z  INFO initialized shared txpool and api write mode mode=Validator standby_only=false write_enabled=true local_finalize_mode=true txpool_len=0
2026-04-08T10:33:57.710433Z  INFO starting API server addr=127.0.0.1:8081
2026-04-08T10:33:57.711190Z  INFO verifying_key=712651f450ba05b63898b99ef5f7ba45632e8e2527f7f715cd671ec4024cc51e note="share this key for validator admission"
2026-04-08T10:33:57.716632Z  INFO msg="node running" api_port=8081
2026-04-08T10:33:57.718321Z  INFO broadcasting proposal height=2 proposer=validator-alpha
2026-04-08T10:33:58.737150Z ERROR consensus error err=StorageError("the cryptographic handshake failed: error 51: invalid peer certificate: BadSignature")
2026-04-08T10:33:57.547960Z  INFO validator_id=validator-beta block_time_ms=1000 quorum_bps=8000 loaded_config=/tmp/tmp.cggNZIB1fd/validator-beta.toml
2026-04-08T10:33:57.748699Z  INFO admission preflight passed network_id=citizen-localnet genesis_hash=49fa21fc0f98730f35807fb4824d3c34b64a7a1b279366931aca97ce08cb7f5d manifest_digest=manifest-not-enforced manifest_version=None
2026-04-08T10:33:57.750257Z  INFO initialized shared txpool and api write mode mode=Validator standby_only=false write_enabled=true local_finalize_mode=true txpool_len=0
2026-04-08T10:33:57.753318Z  INFO starting API server addr=127.0.0.1:8082
2026-04-08T10:33:57.756107Z  INFO verifying_key=dcb38143815f465d8d8d262812260ade8e721b3fe15da833ad477dd711ebc10f note="share this key for validator admission"
2026-04-08T10:33:57.769058Z  INFO broadcasting proposal height=1 proposer=validator-beta
2026-04-08T10:33:57.797891Z  INFO msg="node running" api_port=8082
2026-04-08T10:33:57.814496Z ERROR consensus error err=StorageError("the cryptographic handshake failed: error 51: invalid peer certificate: BadSignature")
2026-04-08T10:33:57.663760Z  INFO validator_id=validator-gamma block_time_ms=1000 quorum_bps=8000 loaded_config=/tmp/tmp.cggNZIB1fd/validator-gamma.toml
2026-04-08T10:33:57.853589Z  INFO admission preflight passed network_id=citizen-localnet genesis_hash=49fa21fc0f98730f35807fb4824d3c34b64a7a1b279366931aca97ce08cb7f5d manifest_digest=manifest-not-enforced manifest_version=None
2026-04-08T10:33:57.854524Z  INFO initialized shared txpool and api write mode mode=Validator standby_only=false write_enabled=true local_finalize_mode=true txpool_len=0
2026-04-08T10:33:57.856446Z  INFO starting API server addr=127.0.0.1:8083
2026-04-08T10:33:57.857649Z  INFO verifying_key=1482e33d057c573003b7a18e1318c8eb12b847850b450e34a776fef7193a8739 note="share this key for validator admission"
2026-04-08T10:33:57.865247Z  INFO msg="node running" api_port=8083
```
