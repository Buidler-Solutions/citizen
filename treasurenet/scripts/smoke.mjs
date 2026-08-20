#!/usr/bin/env node
/**
 * TreasureNet Citizen Edition — end-to-end smoke test.
 *
 * Boots the backend (mock chain mode), then runs the full player journey:
 *
 *   1. GM + player + admin keypairs generated locally (device-style)
 *   2. Wallet registration + challenge-response auth for both
 *   3. Admin grants gamemaster + player roles (player-registry module)
 *   4. GM creates a hunt (escrow init + hunt creation, GM-signed)
 *   5. GM funds + activates the hunt
 *   6. Player grants consent (location + photo), checks in at clue GPS
 *   7. Claim: photo proof -> oracle verdict -> 2-of-2 multisig (GM + oracle)
 *   8. Escrow + hunt complete; CTZN balance increases; finality receipt exists
 *   9. Double-claim is rejected; leaderboard/analytics reflect the win
 */

import { spawn } from "node:child_process";
import { generateKeyPair, signMessage, claimMessages } from "../chain/sdk/src/index.ts";

/** Generated before the server spawns so its private key can be injected
 *  as TREASURENET_GM_REFUND_KEY for the scheduler self-serve refund check. */
const gmKeyPair = generateKeyPair();

const PORT = 7755;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

async function api(method, path, body, token) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function login(keypair) {
  const challenge = await api("POST", "/auth/challenge", { did: keypair.did });
  check("auth challenge issued", challenge.status === 200 && challenge.json.nonce);
  const signature = signMessage(challenge.json.message, keypair.privateKeyHex);
  const session = await api("POST", "/auth/verify", { did: keypair.did, signature });
  check("auth verify returns token", session.status === 200 && session.json.token);
  return session.json.token;
}

const server = spawn(process.execPath, ["src/main.ts"], {
  cwd: new URL("../apps/server/", import.meta.url).pathname,
  env: { ...process.env, TREASURENET_GM_REFUND_KEY: gmKeyPair.privateKeyHex },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`  [server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`  [server:err] ${d}`));

const serverCwd = new URL("../apps/server/", import.meta.url).pathname;

/** Unique per run so a durable projection from a previous run cannot
 *  collide with this run's fixed test identities (HuntExists on rehydrate). */
const runSuffix = String(Date.now() % 1_000_000);

async function waitForBoot(base, path = "/health", attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`${base}${path}`);
      if (response.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  // Wait for boot
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const health = await api("GET", "/health");
      if (health.status === 200) { up = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  check("server healthy on 7755", up);

  const gm = gmKeyPair;
  const player = generateKeyPair();

  // 1-2: registration + auth
  await api("POST", "/wallet/register", { did: gm.did });
  await api("POST", "/wallet/register", { did: player.did });
  const gmToken = await login(gm);
  const playerToken = await login(player);

  // 3: roles
  const grantGm = await api("POST", "/roles/grant", { did: gm.did, role: "gamemaster" });
  check("gamemaster role granted", grantGm.status === 200 && grantGm.json.ok === true);
  const grantPlayer = await api("POST", "/roles/grant", { did: player.did, role: "player" });
  check("player role granted", grantPlayer.status === 200 && grantPlayer.json.ok === true);
  const roleOf = await api("GET", `/roles/${encodeURIComponent(player.did)}`);
  check("role_of returns player", roleOf.json?.role === "player", JSON.stringify(roleOf.json));

  // 4: hunt creation (GM signs client-side)
  const huntId = `hunt-smoke-${runSuffix}-1`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const createSig = signMessage(claimMessages.createHunt(huntId, gm.did), gm.privateKeyHex);
  const hunt = await api("POST", "/games", {
    hunt_id: huntId,
    gm_did: gm.did,
    gm_signature: createSig,
    title: "Harbor Beacon",
    reward_amount: 500,
    reward_token: "CTZN",
    expires_at: expiresAt,
    clues: [
      { index: 0, manifest_id: "manifest-clue-0", latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
      { index: 1, manifest_id: "manifest-clue-1", latitude: 10.3172, longitude: 123.8912, radius_meters: 50 },
    ],
  });
  check("hunt created", hunt.status === 200 && hunt.json.status === "created", JSON.stringify(hunt.json));
  check("escrow linked", hunt.json.escrow_id === `esc-${huntId}`);

  const escrowStatus = await api("GET", `/escrow/${hunt.json.escrow_id}/status`);
  check("escrow status Created", escrowStatus.json?.status === "Created");

  // 5: fund + activate
  const fundSig = signMessage(claimMessages.fundHunt(huntId, gm.did), gm.privateKeyHex);
  const escrowFundSig = signMessage(claimMessages.fundEscrow(`esc-${huntId}`), gm.privateKeyHex);
  const funded = await api("POST", `/games/${huntId}/fund`, {
    gm_signature: fundSig,
    escrow_gm_signature: escrowFundSig,
  });
  check("hunt funded", funded.status === 200 && funded.json.status === "funded");
  const escrowFunded = await api("GET", `/escrow/${hunt.json.escrow_id}/status`);
  check("escrow status Active after fund", escrowFunded.json?.status === "Active", JSON.stringify(escrowFunded.json));

  const activateSig = signMessage(claimMessages.activate(huntId, gm.did), gm.privateKeyHex);
  const activated = await api("POST", `/games/${huntId}/activate`, { gm_signature: activateSig });
  check("hunt activated", activated.status === 200 && activated.json.status === "active", JSON.stringify(activated.json));

  // 6: consent + check-ins
  const consent = await api("POST", "/consent/grant", { purposes: ["location", "photo"] }, playerToken);
  check("consent receipt granted", consent.status === 200 && consent.json.receipt_id);

  const tooFar = await api("POST", `/games/${huntId}/checkin`, { clue_index: 0, latitude: 10.5, longitude: 124.0 }, playerToken);
  check("distant check-in rejected", tooFar.status === 400 && tooFar.json.code === "NotAtLocation", JSON.stringify(tooFar.json));

  const checkin0 = await api("POST", `/games/${huntId}/checkin`, { clue_index: 0, latitude: 10.31672, longitude: 123.89081 }, playerToken);
  check("clue 0 unlocked", checkin0.status === 200 && checkin0.json.unlocked === true);
  check("clue 0 manifest served", checkin0.json.manifest_id === "manifest-clue-0");

  const checkin1 = await api("POST", `/games/${huntId}/checkin`, { clue_index: 1, latitude: 10.31721, longitude: 123.89119 }, playerToken);
  check("final clue unlocked", checkin1.status === 200 && checkin1.json.is_final_clue === true);

  // 7: claim with photo proof (GM pre-authorizes winner claim, oracle co-signs)
  const gmClaimSig = signMessage(claimMessages.hunt(huntId, player.did), gm.privateKeyHex);
  const escrowClaimSig = signMessage(claimMessages.escrow(`esc-${huntId}`, player.did), gm.privateKeyHex);
  const claim = await api(
    "POST",
    `/games/${huntId}/claim`,
    { gm_signature: gmClaimSig, escrow_gm_signature: escrowClaimSig, photo_b64: "cGhvdG8tcHJvb2YtZGVtbwo=".repeat(4), latitude: 10.3172, longitude: 123.8912 },
    playerToken
  );
  check("claim confirmed", claim.status === 200 && claim.json.status === "confirmed", JSON.stringify(claim.json));
  check("claim has receipt", typeof claim.json.receipt_id === "string");
  check("claim has block height", typeof claim.json.block_height === "number");

  // 8: balance + hunt state
  const balance = await api("GET", `/wallet/${encodeURIComponent(player.did)}/balance`);
  check("CTZN balance credited", balance.json?.balance === 500 || balance.json?.balance === 1, JSON.stringify(balance.json));
  const huntAfter = await api("GET", `/games/${huntId}`);
  check("hunt completed on-chain", huntAfter.json.status === "completed");
  check("winner recorded", huntAfter.json.winner_did === player.did);

  // 9: double-claim rejected
  const replay = await api(
    "POST",
    `/games/${huntId}/claim`,
    { gm_signature: gmClaimSig, escrow_gm_signature: escrowClaimSig, photo_b64: "cGhvdG8tcHJvb2YtZGVtbwo=".repeat(4), latitude: 10.3172, longitude: 123.8912 },
    playerToken
  );
  check("double claim rejected", replay.status === 400, JSON.stringify(replay.json));

  const leaderboard = await api("GET", "/leaderboard");
  check(
    "leaderboard has winner",
    leaderboard.json?.some((entry) => entry.player_did === player.did && entry.hunts_won === 1)
  );
  const analytics = await api("GET", "/analytics/summary");
  check("analytics recorded claim", analytics.json?.claims_confirmed === 1);
  const notifications = await api("GET", `/wallet/${encodeURIComponent(player.did)}/notifications`);
  check("winner notified", notifications.json?.some((n) => n.type === "claim.confirmed"));
  const admin = await api("GET", "/admin/overview");
  check("admin overview lists namespaces", Array.isArray(admin.json?.namespaces) && admin.json.namespaces.length === 4);

  // 10: mobile-app claim path — player requests, GM approves from the web console
  const huntId2 = `hunt-smoke-${runSuffix}-2`;
  const player2 = generateKeyPair();
  await api("POST", "/wallet/register", { did: player2.did });
  const player2Token = await login(player2);
  await api("POST", "/roles/grant", { did: player2.did, role: "player" });
  const createSig2 = signMessage(claimMessages.createHunt(huntId2, gm.did), gm.privateKeyHex);
  const hunt2 = await api("POST", "/games", {
    hunt_id: huntId2,
    gm_did: gm.did,
    gm_signature: createSig2,
    title: "Mobile Beacon",
    reward_amount: 250,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    clues: [
      { index: 0, manifest_id: "manifest-m-0", latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
      { index: 1, manifest_id: "manifest-m-1", latitude: 10.3172, longitude: 123.8912, radius_meters: 50 },
    ],
  });
  check("mobile-path hunt created", hunt2.status === 200 && hunt2.json.escrow_id === `esc-${huntId2}`);
  await api("POST", `/games/${huntId2}/fund`, {
    gm_signature: signMessage(claimMessages.fundHunt(huntId2, gm.did), gm.privateKeyHex),
    escrow_gm_signature: signMessage(claimMessages.fundEscrow(`esc-${huntId2}`), gm.privateKeyHex),
  });
  await api("POST", `/games/${huntId2}/activate`, {
    gm_signature: signMessage(claimMessages.activate(huntId2, gm.did), gm.privateKeyHex),
  });
  await api("POST", "/consent/grant", { purposes: ["location", "photo"] }, player2Token);
  const progress0 = await api("GET", `/games/${huntId2}/progress`, undefined, player2Token);
  check("progress starts empty", (progress0.json?.unlocked_clues?.length ?? 0) === 0 && progress0.json.next_clue_index === 0);
  await api("POST", `/games/${huntId2}/checkin`, { clue_index: 0, latitude: 10.31672, longitude: 123.89081 }, player2Token);
  await api("POST", `/games/${huntId2}/checkin`, { clue_index: 1, latitude: 10.31721, longitude: 123.89119 }, player2Token);
  const progress1 = await api("GET", `/games/${huntId2}/progress`, undefined, player2Token);
  check("progress shows all clues", (progress1.json?.unlocked_clues?.length ?? -1) === 2 && progress1.json.next_clue_index === null);

  const dupRequest = await api("POST", `/games/${huntId2}/claim/request`, {
    photo_b64: "cGhvdG8tcHJvb2YtZGVtbwo=".repeat(4),
    latitude: 10.3172,
    longitude: 123.8912,
  }, player2Token);
  check("claim request accepted", dupRequest.status === 200 && dupRequest.json.request_id);
  check("claim request pending", dupRequest.json.status === "pending");
  const dupAgain = await api("POST", `/games/${huntId2}/claim/request`, {
    photo_b64: "cGhvdG8tcHJvb2YtZGVtbwo=".repeat(4),
    latitude: 10.3172,
    longitude: 123.8912,
  }, player2Token);
  check("duplicate claim request rejected", dupAgain.status === 400 && dupAgain.json.code === "ClaimAlreadyRequested");

  const pending = await api("GET", "/claims/pending");
  check("GM console sees pending claim", pending.json?.some((r) => r.request_id === dupRequest.json.request_id));

  const gmClaimSig2 = signMessage(claimMessages.hunt(huntId2, player2.did), gm.privateKeyHex);
  const escrowClaimSig2 = signMessage(claimMessages.escrow(`esc-${huntId2}`, player2.did), gm.privateKeyHex);
  const approved = await api("POST", `/games/${huntId2}/claim`, {
    request_id: dupRequest.json.request_id,
    gm_signature: gmClaimSig2,
    escrow_gm_signature: escrowClaimSig2,
  });
  check("GM approval confirms claim", approved.status === 200 && approved.json.status === "confirmed", JSON.stringify(approved.json));
  const balance2 = await api("GET", `/wallet/${encodeURIComponent(player2.did)}/balance`);
  check("mobile player balance credited", balance2.json?.balance === 250 || balance2.json?.balance === 1, JSON.stringify(balance2.json));
  const pendingAfter = await api("GET", "/claims/pending");
  check("pending list drained", !pendingAfter.json?.some((r) => r.request_id === dupRequest.json.request_id));
  const notified = await api("GET", `/wallet/${encodeURIComponent(player2.did)}/notifications`);
  check("mobile player notified", notified.json?.some((n) => n.type === "claim.confirmed"));

  // 11: admin surface for the persistence/retry/rate-limit wiring
  const persistenceStatus = await api("GET", "/admin/persistence");
  check(
    "admin persistence status",
    persistenceStatus.status === 200 && typeof persistenceStatus.json.retries_pending === "number" && typeof persistenceStatus.json.rate_limiter_buckets === "number",
    JSON.stringify(persistenceStatus.json)
  );
  const flush = await api("POST", "/admin/flush-retries");
  check("retry flush endpoint", flush.status === 200 && flush.json.flushed === true);

  // 12: orgs CRUD with owner checks
  const org = await api("POST", "/orgs", { owner_did: gm.did, name: "Harbor Ops" });
  check("org created", org.status === 200 && typeof org.json.org_id === "string" && org.json.org_id.startsWith("org-"));
  const orgMember = generateKeyPair();
  const memberAdded = await api("POST", `/orgs/${org.json.org_id}/members`, {
    requester_did: gm.did,
    did: orgMember.did,
    role: "gamemaster",
  });
  check(
    "org member added",
    memberAdded.status === 200 && memberAdded.json.members?.some((m) => m.did === orgMember.did && m.role === "gamemaster")
  );
  const rogueAdd = await api("POST", `/orgs/${org.json.org_id}/members`, {
    requester_did: orgMember.did,
    did: generateKeyPair().did,
  });
  check("non-owner member add rejected", rogueAdd.status === 401 && rogueAdd.json.code === "NotOrgOwner");
  const orgsList = await api("GET", "/orgs");
  check("org listed", Array.isArray(orgsList.json) && orgsList.json.some((o) => o.org_id === org.json.org_id));
  const memberRemoved = await api("DELETE", `/orgs/${org.json.org_id}/members/${encodeURIComponent(orgMember.did)}`, {
    requester_did: gm.did,
  });
  check(
    "org member removed",
    memberRemoved.status === 200 && !memberRemoved.json.members?.some((m) => m.did === orgMember.did)
  );

  // 13: refund after expiry — scheduler self-serve with the configured GM
  // refund key (dual signatures over refund:<escrow_id> and refund:<hunt>:<gm>)
  const refundHuntId = `hunt-smoke-refund-${Date.now() % 100000}`;
  const refundCreate = await api("POST", "/games", {
    hunt_id: refundHuntId,
    gm_did: gm.did,
    gm_signature: signMessage(claimMessages.createHunt(refundHuntId, gm.did), gm.privateKeyHex),
    title: "Sunset Refund",
    reward_amount: 120,
    reward_token: "CTZN",
    expires_at: new Date(Date.now() + 4_000).toISOString(),
    clues: [
      { index: 0, manifest_id: "manifest-r-0", latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
    ],
  });
  check("refund-path hunt created", refundCreate.status === 200, JSON.stringify(refundCreate.json));
  await api("POST", `/games/${refundHuntId}/fund`, {
    gm_signature: signMessage(claimMessages.fundHunt(refundHuntId, gm.did), gm.privateKeyHex),
    escrow_gm_signature: signMessage(claimMessages.fundEscrow(`esc-${refundHuntId}`), gm.privateKeyHex),
  });
  await api("POST", `/games/${refundHuntId}/activate`, {
    gm_signature: signMessage(claimMessages.activate(refundHuntId, gm.did), gm.privateKeyHex),
  });
  let refunded = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 750));
    await api("POST", "/admin/scheduler/tick");
    const state = await api("GET", `/games/${refundHuntId}`);
    if (state.json?.status === "refunded") { refunded = true; break; }
  }
  check("expired hunt auto-refunded by scheduler", refunded);
  const escrowRefunded = await api("GET", `/escrow/esc-${refundHuntId}/status`);
  check("escrow shows Refunded", escrowRefunded.json?.status === "Refunded", JSON.stringify(escrowRefunded.json));

  // 14: rate limiting — a second server with a tiny general bucket
  const rateBase = "http://127.0.0.1:7756";
  const rateServer = spawn(process.execPath, ["src/main.ts"], {
    cwd: serverCwd,
    env: { ...process.env, TREASURENET_PORT: "7756", TREASURENET_RATE_LIMIT_PER_MIN: "3" },
    stdio: "ignore",
  });
  try {
    const rateUp = await waitForBoot(rateBase);
    check("rate-limit server healthy", rateUp);
    let limited = null;
    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${rateBase}/health`);
      if (response.status === 429) { limited = response; break; }
    }
    check("burst limited with 429", limited !== null);
    check(
      "429 carries Retry-After",
      limited !== null && Number(limited.headers.get("retry-after")) > 0
    );
  } finally {
    rateServer.kill("SIGTERM");
  }

  // 15: durable projection — create a hunt, restart the backend, verify the
  // projection was rehydrated (only meaningful with DATABASE_URL set)
  if (process.env.DATABASE_URL) {
    const dbPort = 7757;
    const dbBase = `http://127.0.0.1:${dbPort}`;
    const dbHuntId = `hunt-smoke-db-${Date.now() % 100000}`;
    const dbEnv = {
      ...process.env,
      TREASURENET_PORT: String(dbPort),
      TREASURENET_GM_REFUND_KEY: "",
    };
    const first = spawn(process.execPath, ["src/main.ts"], {
      cwd: serverCwd,
      env: dbEnv,
      stdio: "ignore",
    });
    try {
      check("persistence server boots", await waitForBoot(dbBase));
      await fetch(`${dbBase}/wallet/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did: gm.did }),
      });
      await fetch(`${dbBase}/roles/grant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did: gm.did, role: "gamemaster" }),
      });
      const dbCreate = await fetch(`${dbBase}/games`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hunt_id: dbHuntId,
          gm_did: gm.did,
          gm_signature: signMessage(claimMessages.createHunt(dbHuntId, gm.did), gm.privateKeyHex),
          title: "Durable Beacon",
          reward_amount: 80,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          clues: [
            { index: 0, manifest_id: "manifest-db-0", latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
          ],
        }),
      });
      check("persistence hunt created", dbCreate.status === 200);
    } finally {
      first.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const second = spawn(process.execPath, ["src/main.ts"], {
      cwd: serverCwd,
      env: dbEnv,
      stdio: "ignore",
    });
    try {
      check("persistence server restarts", await waitForBoot(dbBase));
      const rehydrated = await fetch(`${dbBase}/games/${dbHuntId}`);
      const huntJson = await rehydrated.json();
      check(
        "hunt rehydrated from projection after restart",
        rehydrated.status === 200 && huntJson.hunt_id === dbHuntId && huntJson.title === "Durable Beacon",
        JSON.stringify(huntJson).slice(0, 200)
      );
    } finally {
      second.kill("SIGTERM");
    }
  } else {
    console.log("  skip  persistence restart scenario (DATABASE_URL unset)");
  }
} finally {
  server.kill("SIGTERM");
}

console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
