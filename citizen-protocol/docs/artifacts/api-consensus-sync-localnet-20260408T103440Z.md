# API Consensus Sync Localnet Evidence (20260408T103440Z)

## Submission
```json
{"entry_id":"d4371a63-a469-4997-9f98-8beb22bfef48","namespace":"registry.land","action":"TRANSFER_OWNERSHIP","object_id":"LOT-API-CONSENSUS-SYNC-20260408T103440Z","payload":{"from":"did:citizen:alpha","to":"did:citizen:beta","author_public_key":"28a5208bd1745a895b89e110c9e648231579e64c8872ad9b48c2145635090f98"},"author":"registry.land","timestamp":1775644482,"signature":"d013764a8dcdcbdb84ff67f1ed1d825d9cd799febbc9d422756fc2c1e2eb3d7e11627faf0c81a693f45c98fa224cd0e47173a797ebecf85ae53cd211964d8b02"}
```

### Alpha submit response
```json
{
  "entry_id": "d4371a63-a469-4997-9f98-8beb22bfef48",
  "envelope_id": "a17bd917-665a-4a8a-9167-cd642f6f1bab",
  "local_finalize_mode": false,
  "namespace": "registry.land",
  "queue_capacity": 10000,
  "queue_drained_total": 0,
  "queue_enqueued_total": 1,
  "queue_len": 1,
  "status": "queued"
}
```

## Convergence check
- Alpha contains entry: false
- Beta contains entry: false
- Gamma contains entry: false
- Entry counts (alpha/beta/gamma): 0/0/0
- Heights (alpha/beta/gamma): 0/0/0

## API snapshots
### Alpha registry.land entries
```json
[]
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
2026-04-08T10:34:40.940435Z  INFO validator_id=validator-alpha block_time_ms=1000 quorum_bps=8000 loaded_config=config/localnet/validator-alpha.toml
2026-04-08T10:34:41.205159Z  INFO admission preflight passed network_id=citizen-localnet genesis_hash=49fa21fc0f98730f35807fb4824d3c34b64a7a1b279366931aca97ce08cb7f5d manifest_digest=manifest-not-enforced manifest_version=None
2026-04-08T10:34:41.208132Z  INFO initialized shared txpool and api write mode mode=Validator standby_only=false write_enabled=true local_finalize_mode=false txpool_len=0
2026-04-08T10:34:41.209908Z  INFO starting API server addr=127.0.0.1:8081
2026-04-08T10:34:41.211552Z  INFO verifying_key=712651f450ba05b63898b99ef5f7ba45632e8e2527f7f715cd671ec4024cc51e note="share this key for validator admission"
2026-04-08T10:34:41.217421Z  INFO msg="node running" api_port=8081
2026-04-08T10:34:42.232524Z ERROR consensus error err=StorageError("the cryptographic handshake failed: error 51: invalid peer certificate: BadSignature")
2026-04-08T10:34:40.968114Z  INFO validator_id=validator-beta block_time_ms=1000 quorum_bps=8000 loaded_config=config/localnet/validator-beta.toml
2026-04-08T10:34:41.217303Z  INFO admission preflight passed network_id=citizen-localnet genesis_hash=49fa21fc0f98730f35807fb4824d3c34b64a7a1b279366931aca97ce08cb7f5d manifest_digest=manifest-not-enforced manifest_version=None
2026-04-08T10:34:41.221513Z  INFO initialized shared txpool and api write mode mode=Validator standby_only=false write_enabled=true local_finalize_mode=false txpool_len=0
2026-04-08T10:34:41.223382Z  INFO starting API server addr=127.0.0.1:8082
2026-04-08T10:34:41.224217Z  INFO verifying_key=dcb38143815f465d8d8d262812260ade8e721b3fe15da833ad477dd711ebc10f note="share this key for validator admission"
2026-04-08T10:34:41.230269Z  INFO msg="node running" api_port=8082
2026-04-08T10:34:42.243038Z ERROR consensus error err=StorageError("the cryptographic handshake failed: error 51: invalid peer certificate: BadSignature")
2026-04-08T10:34:41.023321Z  INFO validator_id=validator-gamma block_time_ms=1000 quorum_bps=8000 loaded_config=config/localnet/validator-gamma.toml
2026-04-08T10:34:41.239140Z  INFO admission preflight passed network_id=citizen-localnet genesis_hash=49fa21fc0f98730f35807fb4824d3c34b64a7a1b279366931aca97ce08cb7f5d manifest_digest=manifest-not-enforced manifest_version=None
2026-04-08T10:34:41.239628Z  INFO initialized shared txpool and api write mode mode=Validator standby_only=false write_enabled=true local_finalize_mode=false txpool_len=0
2026-04-08T10:34:41.241290Z  INFO starting API server addr=127.0.0.1:8083
2026-04-08T10:34:41.242164Z  INFO verifying_key=1482e33d057c573003b7a18e1318c8eb12b847850b450e34a776fef7193a8739 note="share this key for validator admission"
2026-04-08T10:34:41.246579Z  INFO msg="node running" api_port=8083
```
