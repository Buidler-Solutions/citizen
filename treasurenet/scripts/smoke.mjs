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
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`  [server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`  [server:err] ${d}`));

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

  const gm = generateKeyPair();
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
  const huntId = "hunt-smoke-001";
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
  check("hunt activated", activated.status === 200 && activated.json.status === "active");

  // 6: consent + check-ins
  const consent = await api("POST", "/consent/grant", { purposes: ["location", "photo"] }, playerToken);
  check("consent receipt granted", consent.status === 200 && consent.json.receipt_id);

  const tooFar = await api("POST", `/games/${huntId}/checkin`, { clue_index: 0, latitude: 10.5, longitude: 124.0 }, playerToken);
  check("distant check-in rejected", tooFar.status === 400 && tooFar.json.code === "NotAtLocation");

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
  check("CTZN balance credited", balance.json?.balance === 500, JSON.stringify(balance.json));
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
  check("leaderboard has winner", leaderboard.json?.[0]?.player_did === player.did && leaderboard.json[0].hunts_won === 1);
  const analytics = await api("GET", "/analytics/summary");
  check("analytics recorded claim", analytics.json?.claims_confirmed === 1);
  const notifications = await api("GET", `/wallet/${encodeURIComponent(player.did)}/notifications`);
  check("winner notified", notifications.json?.some((n) => n.type === "claim.confirmed"));
  const admin = await api("GET", "/admin/overview");
  check("admin overview lists namespaces", Array.isArray(admin.json?.namespaces) && admin.json.namespaces.length === 4);
} finally {
  server.kill("SIGTERM");
}

console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
