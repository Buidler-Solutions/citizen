# TreasureNet Reference External Oracle

Reference deployment of the external AI-oracle service described in the gap
analysis (gap 10). The backend oracle module (`TREASURENET_ORACLE_MODE=external`)
POSTs proof bundles here and only accepts verdicts signed by the pinned
`TREASURENET_ORACLE_VERIFIER_DID`.

## Run

```bash
ORACLE_KEY_HEX=<32-byte-hex> ORACLE_PORT=7760 node service.mjs
```

Defaults: port 7760, the shared development oracle key. Health: `GET /health`.
Verdicts: `POST /verdict` with `{ hunt_id, player_did, clue_index, photo_b64, geo_ok }`
returning `{ passed, confidence, reason, verdict_signature, oracle_did }` where
the signature is Ed25519 over `verdict:<hunt_id>:<player_did>:<clue_index>:<pass|fail>`.

## Backend wiring

```bash
TREASURENET_ORACLE_MODE=external \
TREASURENET_ORACLE_URL=http://127.0.0.1:7760/verdict \
TREASURENET_ORACLE_VERIFIER_DID=did:key:ed25519:<public-hex-of-ORACLE_KEY_HEX> \
node apps/server/src/main.ts
```

The verdict policy in `evaluate()` is the same deterministic heuristic as the
in-process oracle; production swaps that one function for the real model. The
smoke suite exercises both acceptance (pinned did matches) and rejection
(foreign verifier did) paths in `scripts/smoke.mjs` sections 16 and 17.
