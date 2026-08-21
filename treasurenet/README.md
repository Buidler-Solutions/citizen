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
| GM console on port 7777 (browser-held keys, WebCrypto Ed25519, claim approvals) | `apps/web/` | Functional scaffold |
| Admin panel on port 7778 | `apps/admin/` | Functional scaffold |
| Flutter player app (device wallet, GPS clue flow, photo claims, finality receipts) | `apps/flutter/` | Implemented, analyzer clean, tests green, debug APK builds |
| Shared types + Prisma indexer schema | `packages/shared/` | Defined |

## Quick start (offline, mock chain)

```bash
# terminal 1: backend on :7755 (mock chain, ephemeral dev keys)
cd treasurenet/apps/server && node src/main.ts

# terminal 2: GM console on :7777
cd treasurenet/apps/web && node serve.mjs

# terminal 3: admin panel on :7778
cd treasurenet/apps/admin && node serve.mjs

# terminal 4: player app on a device or emulator
cd treasurenet/apps/flutter && flutter run \
  --dart-define=TREASURENET_API=http://10.0.2.2:7755   # Android emulator

# end-to-end smoke test (boots its own server, covers both claim paths)
cd treasurenet && node scripts/smoke.mjs

# same smoke with durable persistence (Postgres projection, Redis event
# stream, server-restart rehydration): DATABASE_URL required, REDIS_URL optional
cd treasurenet && DATABASE_URL=postgresql://tata@localhost:5432/treasurenet_citizen \
  REDIS_URL=redis://127.0.0.1:6379 node scripts/smoke.mjs
```

The GM console generates its keypair in the browser, requests the
gamemaster role (dev admin path), and signs hunt lifecycle messages with
WebCrypto Ed25519. Players use the Flutter app: onboarding generates the
device Ed25519 identity, login signs the `treasurenet-login:<nonce>`
challenge, check-ins submit live GPS fixes, and claims submit photo proof.
The smoke test walks the entire player journey both ways: direct GM-signed
claim and the mobile claim request plus GM web-console approval.

## Quick start (local Citizen node)

```bash
# 0. workspace install (pnpm; Prisma is pinned to 6.x)
cd treasurenet && pnpm install --no-frozen-lockfile

# 1. build the WASM modules (escrow, hunt, registry, ctzn-token, citizen-asset)
cd citizen-protocol/modules/treasure-escrow && RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
cd ../treasure-hunt && RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
cd ../player-registry && RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
cd ../ctzn-token && RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown
cd ../citizen-asset && RUSTFLAGS="-C link-arg=--allow-undefined" cargo build --release --target wasm32-unknown-unknown

# 2. build + start a solo node (single validator, mock network, advancing blocks)
cd citizen-protocol && cargo build -p citizen-node --release
./target/release/citizen-node config/solo/validator-solo-tn.toml   # api on :8081
#   (note: the config path is positional — a `--config` flag is silently
#    treated as the path itself and the node falls back to defaults)
#   for the encrypted-clue files flow use the files-enabled profile instead:
#   ./target/release/citizen-node config/solo/validator-solo-tn-files.toml   # api on :8185

# 3. deploy: governance approvals + module registration + configuration
python3 chain/scripts/deploy_treasurenet.py \
  --node http://127.0.0.1:8081 \
  --bootstrap-governance \
  --signing-key-hex <64-hex> \
  --admin-did did:key:ed25519:<pubhex> \
  --oracle-did did:key:ed25519:<pubhex>

# 4. point the backend at the node (scheduler self-serve refunds need the
#    GM refund key; rate limits and oracle mode have env toggles too)
TREASURENET_NODE_URL=http://127.0.0.1:8081 \
TREASURENET_SERVICE_KEY=<64-hex> \
TREASURENET_ORACLE_KEY=<64-hex> \
TREASURENET_GM_REFUND_KEY=<gm-64-hex> \
node apps/server/src/main.ts

# 5. full node-mode smoke against the live chain
cd treasurenet && TREASURENET_NODE_URL=http://127.0.0.1:8081 \
  TREASURENET_SERVICE_KEY=<64-hex> TREASURENET_ORACLE_KEY=<64-hex> \
  node scripts/smoke.mjs
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
POST /games/:id/fund            {gm_signature, escrow_gm_signature, asset_gm_signature?}
POST /games/:id/activate|pause|resume|cancel   {gm_signature}
POST /games/:id/checkin         {clue_index, latitude, longitude}  (player session)
GET  /games/:id/progress        (player session; unlocked clue chain)
POST /games/:id/claim/request   {photo_b64, latitude, longitude}   (player session; GM approves from web)
POST /games/:id/claim           {gm_signature, escrow_gm_signature, asset_gm_signature?, photo_b64, latitude, longitude}
                                or {request_id, gm_signature, escrow_gm_signature, asset_gm_signature?} (GM approval)
GET  /claims/pending            POST /claims/:requestId/deny
POST /games/:id/refund          {gm_signature, escrow_gm_signature?, asset_gm_signature?}
GET  /escrow/:id/status         GET  /escrow/:id/reward
GET  /claims
GET  /oracle/verdicts/:huntId
GET  /leaderboard               GET  /analytics/summary
GET  /admin/overview            GET  /admin/file-alerts
GET  /events                    POST /admin/scheduler/tick
POST /admin/indexer/poll
POST /files/clue                (GM sig; encrypts+commits an AES-GCM clue via the node files API)
POST /files/clue/key            (GM sig; attaches the wrapped content key)
POST /files/clue/read           (player session; consent+unlock gated)
POST /files/clue/revoke         (GM sig; ENCRYPTED_FILE_REVOKE on chain)
GET  /admin/governance/proposals
POST /admin/governance/proposals             {title, parameters}
POST /admin/governance/proposals/:id/decision  {decision: approved|rejected}
```

Reference oracle service (`apps/oracle/service.mjs`, port 7760 by default):

```
GET  /health
POST /verdict    {hunt_id, player_did, clue_index, photo_b64, geo_ok}
                -> {passed, confidence, reason, verdict_signature, oracle_did}
```

## Reward custody (citizen-asset.v1)

Hunts default to the transferable reward asset (`treasurenet.gold`, TNG,
2 decimals) issued on the generic `citizen-asset.v1` module — not the
soulbound CTZN identity token. Custody flow per hunt:

1. **create** — service opens a timed vault `esc-<huntId>` (approvers
   GM + oracle, threshold 2, fallback owner GM, expiry = hunt deadline).
2. **fund** — issuers mint the reward to the GM (threshold-2 signatures),
   then the GM deposits it into the vault account `vault:esc-<huntId>`
   (GM signs `transfer:<token>:<gm>:vault:<escrow>:<amount>:deposit-<hunt>`).
3. **claim** — GM + oracle co-sign `vt:<escrow>:<winner>:<amount>:claim-<hunt>`
   and the vault pays the winner real tokens; wallet balances read the asset module.
4. **refund after expiry** — only the fallback owner (GM) can move the
   vault balance back (`vt:<escrow>:<gm>:<amount>:refund-<hunt>`).

Hunts created with an explicit non-default `reward_token` keep the legacy
escrow-only settlement. Env knobs: `TREASURENET_ASSET_MODULE`
(default `citizen-asset.v1`) and `TREASURENET_REWARD_ASSET`
(default `treasurenet.gold`); message formats live in `assetMessages`
(`chain/sdk/src/modules.ts`) shared by backend, console, and smoke.

## Documentation

- `docs/MIGRATION_NOTES.md` - every Stellar-to-Citizen deviation and why
- `docs/GAP_ANALYSIS.md` - remaining gaps to full production parity
- `apps/flutter/README.md` - mobile app implementation and port notes

## Key signing model

Players never hold tokens and never sign chain writes: the service DID
sponsors player actions via builder credits. Players use the native
mobile app; Game Masters use the web console and sign hunt lifecycle
messages client-side (WebCrypto Ed25519). Claims work in both directions:
the GM can pre-sign a claim directly, or the player submits a claim
request from the app (photo + geo proof) and the GM approves it from the
console, which produces the two GM claim signatures bound to the player's
DID. The oracle co-signs every claim; the modules enforce the 2-of-2
policy on-chain. Canonical message strings live in
`chain/sdk/src/modules.ts` (`claimMessages`) and are shared verbatim by
every surface.
