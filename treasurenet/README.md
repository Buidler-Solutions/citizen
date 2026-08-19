# TreasureNet Citizen Edition

Real-world GPS treasure hunting on the Citizen Protocol ledger: a faithful
port of the Stellar/Soroban-based TreasureNet system (escrowed on-chain
rewards, sequential encrypted clues, soulbound roles, oracle-verified photo
proofs) onto Citizen namespaces and WASM execution modules.

## What is implemented in this monorepo

| Layer | Location | Status |
|---|---|---|
| Escrow smart contract (Created/Funded/Active/Completed/Refunded/Expired, 2-of-2 multisig claim) | `citizen-protocol/modules/treasure-escrow/` | Ported, all original error cases, WASM built |
| Treasure hunt smart contract (8-status lifecycle, double-claim prevention) | `citizen-protocol/modules/treasure-hunt/` | Ported, all original error cases, WASM built |
| Player registry smart contract (soulbound Player/GameMaster/Auditor roles) | `citizen-protocol/modules/player-registry/` | Ported SBT + registry semantics, WASM built |
| Ported contract test scenarios (41 tests) | `citizen-protocol/crates/execution/tests/treasurenet_test.rs` | All scenarios green |
| Namespace rulesets (game.hunts, game.escrow, identity.roles, game.claims) | `chain/namespaces/*.json` | Defined |
| Chain deployment script (register + activate + configure modules) | `chain/scripts/deploy_treasurenet.py` | Ready for a local node |
| Typed chain SDK (keys, canonical entries, module gateway, mock chain) | `chain/sdk/` | Implemented, dependency-free |
| Backend API on port 7755 | `apps/server/` | All original module boundaries, mock or node chain mode |
| GM console on port 7777 (browser-held keys, WebCrypto Ed25519) | `apps/web/` | Functional scaffold |
| Admin panel on port 7778 | `apps/admin/` | Functional scaffold |
| Flutter player app port plan | `apps/flutter/README.md` | Documented, not yet implemented |
| Shared types + Prisma indexer schema | `packages/shared/` | Defined |

## Quick start (offline, mock chain)

```bash
# terminal 1: backend on :7755 (mock chain, ephemeral dev keys)
cd treasurenet/apps/server && node src/main.ts

# terminal 2: GM console on :7777
cd treasurenet/apps/web && node serve.mjs

# terminal 3: admin panel on :7778
cd treasurenet/apps/admin && node serve.mjs

# end-to-end smoke test (boots its own server)
cd treasurenet && node scripts/smoke.mjs
```

The GM console generates its keypair in the browser, requests the
gamemaster role (dev admin path), and signs hunt lifecycle messages with
WebCrypto Ed25519. The smoke test walks the entire player journey:
roles, hunt creation, funding, activation, consent, GPS check-ins,
oracle-verified photo claim, 2-of-2 multisig payout, balance + receipt.

## Quick start (local Citizen node)

```bash
# 1. build the three WASM modules
cd citizen-protocol/modules/treasure-escrow && RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
cd ../treasure-hunt && RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
cd ../player-registry && RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown

# 2. start a local node (see citizen-protocol/scripts/run_solo.sh)

# 3. deploy modules + namespaces
python3 chain/scripts/deploy_treasurenet.py \
  --node http://127.0.0.1:8091 \
  --signing-key-hex <64-hex> \
  --admin-did did:key:ed25519:<pubhex> \
  --oracle-did did:key:ed25519:<pubhex>

# 4. point the backend at the node
TREASURENET_NODE_URL=http://127.0.0.1:8091 \
TREASURENET_SERVICE_KEY=<64-hex> \
TREASURENET_ORACLE_KEY=<64-hex> \
node apps/server/src/main.ts
```

## API surface (port 7755)

```
GET  /health
POST /auth/challenge            {did}
POST /auth/verify               {did, signature}
POST /wallet/register           {did | public_key_hex}
GET  /wallet/:did/balance
GET  /wallet/:did/receipts
GET  /wallet/:did/notifications
POST /consent/grant             {purposes: [location, photo]}
GET  /consent/status
POST /roles/grant               {did, role}
POST /roles/revoke              {did}
GET  /roles/:did
GET  /games                     POST /games
GET  /games/:id
POST /games/:id/fund            {gm_signature, escrow_gm_signature}
POST /games/:id/activate|pause|resume|cancel   {gm_signature}
POST /games/:id/checkin         {clue_index, latitude, longitude}  (player session)
POST /games/:id/claim           {gm_signature, escrow_gm_signature, photo_b64, latitude, longitude}
POST /games/:id/refund          {gm_signature}
GET  /escrow/:id/status         GET  /escrow/:id/reward
GET  /claims
GET  /oracle/verdicts/:huntId
GET  /leaderboard               GET  /analytics/summary
GET  /admin/overview            GET  /admin/file-alerts
GET  /events                    POST /admin/scheduler/tick
POST /admin/indexer/poll
```

## Documentation

- `docs/MIGRATION_NOTES.md` — every Stellar-to-Citizen deviation and why
- `docs/GAP_ANALYSIS.md` — remaining gaps to full production parity
- `apps/flutter/README.md` — mobile port plan

## Key signing model

Players never hold tokens and never sign chain writes: the service DID
sponsors player actions via builder credits. Game Masters sign hunt
lifecycle messages client-side (browser console or future mobile GM app);
the oracle co-signs every claim; the modules enforce the 2-of-2 policy
on-chain. Canonical message strings live in `chain/sdk/src/modules.ts`
(`claimMessages`) and are shared verbatim by every surface.
