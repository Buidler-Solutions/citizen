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
 *   5. GM funds + activates the hunt (activation is impossible before funding)
 *   6. Player joins (free or paid admission), grants consent, checks in at
 *      clue GPS positions strictly in clue-chain order
 *   7. Claim: photo proof -> oracle verdict -> 2-of-2 multisig (GM + oracle)
 *   8. Escrow + hunt complete; reward-asset balance increases; finality receipt exists
 *   9. Double-claim is rejected; leaderboard/analytics reflect the win
 *  13c. Full game-design flow: paid admission, riddle-decrypted sequential
 *       clues, and instant claim via GM-delegated service settlement
 */

import { spawn } from "node:child_process";
import { generateKeyPair, didFromPrivateKeyHex, signMessage, claimMessages, assetMessages } from "../chain/sdk/src/index.ts";

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

  // 4: hunt creation (GM signs client-side). No explicit reward_token means
  // the default transferable reward asset: escrow backed by vault custody.
  const huntId = `hunt-smoke-${runSuffix}-1`;
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const createSig = signMessage(claimMessages.createHunt(huntId, gm.did), gm.privateKeyHex);
  const hunt = await api("POST", "/games", {
    hunt_id: huntId,
    gm_did: gm.did,
    gm_signature: createSig,
    title: "Harbor Beacon",
    reward_amount: 500,
    expires_at: expiresAt,
    clues: [
      { index: 0, manifest_id: "manifest-clue-0", latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
      { index: 1, manifest_id: "manifest-clue-1", latitude: 10.3172, longitude: 123.8912, radius_meters: 50 },
    ],
  });
  check("hunt created", hunt.status === 200 && hunt.json.status === "created", JSON.stringify(hunt.json));
  check("escrow linked", hunt.json.escrow_id === `esc-${huntId}`);
  check("default reward is the transferable asset", hunt.json.reward_token === "treasurenet.gold", hunt.json.reward_token);
  const rewardToken = hunt.json.reward_token;
  const vaultAccount = assetMessages.vaultAccount(`esc-${huntId}`);

  const escrowStatus = await api("GET", `/escrow/${hunt.json.escrow_id}/status`);
  check("escrow status Created", escrowStatus.json?.status === "Created");

  // 5: fund + activate (the asset signature deposits real tokens into the vault)
  const fundSig = signMessage(claimMessages.fundHunt(huntId, gm.did), gm.privateKeyHex);
  const escrowFundSig = signMessage(claimMessages.fundEscrow(`esc-${huntId}`), gm.privateKeyHex);
  const depositSig = signMessage(
    assetMessages.transfer(rewardToken, gm.did, vaultAccount, 500, `deposit-${huntId}`),
    gm.privateKeyHex
  );
  const funded = await api("POST", `/games/${huntId}/fund`, {
    gm_signature: fundSig,
    escrow_gm_signature: escrowFundSig,
    asset_gm_signature: depositSig,
  });
  check("hunt funded", funded.status === 200 && funded.json.status === "funded");
  const escrowFunded = await api("GET", `/escrow/${hunt.json.escrow_id}/status`);
  check("escrow status Active after fund", escrowFunded.json?.status === "Active", JSON.stringify(escrowFunded.json));

  const activateSig = signMessage(claimMessages.activate(huntId, gm.did), gm.privateKeyHex);
  const activated = await api("POST", `/games/${huntId}/activate`, { gm_signature: activateSig });
  check("hunt activated", activated.status === 200 && activated.json.status === "active", JSON.stringify(activated.json));

  // 6: consent + admission + check-ins
  const consent = await api("POST", "/consent/grant", { purposes: ["location", "photo"] }, playerToken);
  check("consent receipt granted", consent.status === 200 && consent.json.receipt_id);

  const outsiderCheck = await api("POST", `/games/${huntId}/checkin`, { clue_index: 0, latitude: 10.31672, longitude: 123.89081 }, playerToken);
  check(
    "non-participant check-in rejected",
    outsiderCheck.status === 400 && outsiderCheck.json.code === "NotParticipant",
    JSON.stringify(outsiderCheck.json)
  );

  const join1 = await api("POST", `/games/${huntId}/join`, undefined, playerToken);
  check("free admission join accepted", join1.status === 200 && join1.json.joined === true, JSON.stringify(join1.json));
  check("join reports mode + count", join1.json.mode === "free" && join1.json.player_count === 1);
  const rejoin = await api("POST", `/games/${huntId}/join`, undefined, playerToken);
  check("double join rejected", rejoin.status === 400 && rejoin.json.code === "AlreadyJoined");
  const roster = await api("GET", `/games/${huntId}/players`);
  check(
    "players roster lists participant",
    roster.json?.player_count === 1 && roster.json.players?.some((p) => p.did === player.did && p.fee_paid === 0),
    JSON.stringify(roster.json)
  );

  const tooFar = await api("POST", `/games/${huntId}/checkin`, { clue_index: 0, latitude: 10.5, longitude: 124.0 }, playerToken);
  check("distant check-in rejected", tooFar.status === 400 && tooFar.json.code === "NotAtLocation", JSON.stringify(tooFar.json));

  const outOfOrder = await api("POST", `/games/${huntId}/checkin`, { clue_index: 1, latitude: 10.31721, longitude: 123.89119 }, playerToken);
  check(
    "out-of-order clue rejected",
    outOfOrder.status === 400 && outOfOrder.json.code === "OutOfOrderClue",
    JSON.stringify(outOfOrder.json)
  );

  const checkin0 = await api("POST", `/games/${huntId}/checkin`, { clue_index: 0, latitude: 10.31672, longitude: 123.89081 }, playerToken);
  check("clue 0 unlocked", checkin0.status === 200 && checkin0.json.unlocked === true);
  check("clue 0 manifest served", checkin0.json.manifest_id === "manifest-clue-0");

  const checkin1 = await api("POST", `/games/${huntId}/checkin`, { clue_index: 1, latitude: 10.31721, longitude: 123.89119 }, playerToken);
  check("final clue unlocked", checkin1.status === 200 && checkin1.json.is_final_clue === true);

  // 7: claim with photo proof (GM pre-authorizes winner claim, oracle co-signs)
  const gmClaimSig = signMessage(claimMessages.hunt(huntId, player.did), gm.privateKeyHex);
  const escrowClaimSig = signMessage(claimMessages.escrow(`esc-${huntId}`, player.did), gm.privateKeyHex);
  const assetClaimSig = signMessage(
    assetMessages.vaultTransfer(`esc-${huntId}`, player.did, 500, `claim-${huntId}`),
    gm.privateKeyHex
  );
  const claim = await api(
    "POST",
    `/games/${huntId}/claim`,
    { gm_signature: gmClaimSig, escrow_gm_signature: escrowClaimSig, asset_gm_signature: assetClaimSig, photo_b64: "cGhvdG8tcHJvb2YtZGVtbwo=".repeat(4), latitude: 10.3172, longitude: 123.8912 },
    playerToken
  );
  check("claim confirmed", claim.status === 200 && claim.json.status === "confirmed", JSON.stringify(claim.json));
  check("claim has receipt", typeof claim.json.receipt_id === "string");
  check("claim has block height", typeof claim.json.block_height === "number");

  // 8: balance + hunt state — the vault payout moved real tokens
  const balance = await api("GET", `/wallet/${encodeURIComponent(player.did)}/balance`);
  check("reward-asset balance credited", balance.json?.balance === 500, JSON.stringify(balance.json));
  const huntAfter = await api("GET", `/games/${huntId}`);
  check("hunt completed on-chain", huntAfter.json.status === "completed");
  check("winner recorded", huntAfter.json.winner_did === player.did);

  // 9: double-claim rejected
  const replay = await api(
    "POST",
    `/games/${huntId}/claim`,
    { gm_signature: gmClaimSig, escrow_gm_signature: escrowClaimSig, asset_gm_signature: assetClaimSig, photo_b64: "cGhvdG8tcHJvb2YtZGVtbwo=".repeat(4), latitude: 10.3172, longitude: 123.8912 },
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
    asset_gm_signature: signMessage(
      assetMessages.transfer("treasurenet.gold", gm.did, assetMessages.vaultAccount(`esc-${huntId2}`), 250, `deposit-${huntId2}`),
      gm.privateKeyHex
    ),
  });
  await api("POST", `/games/${huntId2}/activate`, {
    gm_signature: signMessage(claimMessages.activate(huntId2, gm.did), gm.privateKeyHex),
  });
  await api("POST", "/consent/grant", { purposes: ["location", "photo"] }, player2Token);
  await api("POST", `/games/${huntId2}/join`, undefined, player2Token);
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
  const assetClaimSig2 = signMessage(
    assetMessages.vaultTransfer(`esc-${huntId2}`, player2.did, 250, `claim-${huntId2}`),
    gm.privateKeyHex
  );
  const approved = await api("POST", `/games/${huntId2}/claim`, {
    request_id: dupRequest.json.request_id,
    gm_signature: gmClaimSig2,
    escrow_gm_signature: escrowClaimSig2,
    asset_gm_signature: assetClaimSig2,
  });
  check("GM approval confirms claim", approved.status === 200 && approved.json.status === "confirmed", JSON.stringify(approved.json));
  const balance2 = await api("GET", `/wallet/${encodeURIComponent(player2.did)}/balance`);
  check("mobile player balance credited", balance2.json?.balance === 250, JSON.stringify(balance2.json));
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

  // 13: governance proposals — civic surface for parameter changes
  const govProposal = await api("POST", "/admin/governance/proposals", {
    title: "Rotate oracle verifier",
    parameters: { oracle_did: "did:key:ed25519:rotate-smoke" },
  });
  check(
    "governance proposal created",
    govProposal.status === 200 && govProposal.json.status === "proposed",
    JSON.stringify(govProposal.json)
  );
  let govListed = null;
  for (let i = 0; i < 10 && !govListed; i++) {
    const list = await api("GET", "/admin/governance/proposals");
    govListed =
      list.json?.find(
        (p) => p.proposal_id === govProposal.json.proposal_id && p.status === "proposed"
      ) ?? null;
    if (!govListed) await new Promise((r) => setTimeout(r, 500));
  }
  check("governance proposal listed", govListed !== null);
  const govDecide = await api(
    "POST",
    `/admin/governance/proposals/${govProposal.json.proposal_id}/decision`,
    { decision: "approved" }
  );
  check(
    "governance proposal approved",
    govDecide.status === 200 && govDecide.json.status === "approved",
    JSON.stringify(govDecide.json)
  );
  let govApproved = null;
  for (let i = 0; i < 10 && !govApproved; i++) {
    const list = await api("GET", "/admin/governance/proposals");
    govApproved =
      list.json?.find(
        (p) => p.proposal_id === govProposal.json.proposal_id && p.status === "approved"
      ) ?? null;
    if (!govApproved) await new Promise((r) => setTimeout(r, 500));
  }
  check("governance decision visible in list", govApproved !== null);
  const govReDecide = await api(
    "POST",
    `/admin/governance/proposals/${govProposal.json.proposal_id}/decision`,
    { decision: "rejected" }
  );
  check(
    "governance re-decision rejected",
    govReDecide.status === 400 && govReDecide.json.code === "ProposalDecided"
  );

  // 13b: encrypted clue files — client-side AES-GCM, consent-gated reads,
  // revocation, and admin alert feeds (gaps 3 + 12)
  {
    const nodeCrypto = await import("node:crypto");
    const filesHuntId = `hunt-smoke-files-${runSuffix}`;
    await api("POST", "/games", {
      hunt_id: filesHuntId,
      gm_did: gm.did,
      gm_signature: signMessage(claimMessages.createHunt(filesHuntId, gm.did), gm.privateKeyHex),
      title: "Encrypted Clue Beacon",
      reward_amount: 60,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      clues: [
        { index: 0, manifest_id: "manifest-files-0", latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
      ],
    });
    await api("POST", `/games/${filesHuntId}/fund`, {
      gm_signature: signMessage(claimMessages.fundHunt(filesHuntId, gm.did), gm.privateKeyHex),
      escrow_gm_signature: signMessage(claimMessages.fundEscrow(`esc-${filesHuntId}`), gm.privateKeyHex),
      asset_gm_signature: signMessage(
        assetMessages.transfer("treasurenet.gold", gm.did, assetMessages.vaultAccount(`esc-${filesHuntId}`), 60, `deposit-${filesHuntId}`),
        gm.privateKeyHex
      ),
    });
    await api("POST", `/games/${filesHuntId}/activate`, {
      gm_signature: signMessage(claimMessages.activate(filesHuntId, gm.did), gm.privateKeyHex),
    });

    const cluePlaintext = "The beacon stands where the ferry queue forms. Ask for the silver crate.";
    const clueKey = nodeCrypto.randomBytes(32);
    const clueIv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", clueKey, clueIv);
    const ciphertext = Buffer.concat([cipher.update(cluePlaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    const uploaded = await api("POST", "/files/clue", {
      hunt_id: filesHuntId,
      clue_index: 0,
      ciphertext_b64: ciphertext.toString("base64"),
      iv_b64: clueIv.toString("base64"),
      gm_did: gm.did,
      gm_signature: signMessage(`clue-upload:${filesHuntId}:0`, gm.privateKeyHex),
    });
    check(
      "encrypted clue uploaded",
      uploaded.status === 200 && uploaded.json.manifest_id?.startsWith("sha256:"),
      JSON.stringify(uploaded.json)
    );
    const manifestId = uploaded.json.manifest_id;

    const wrapKey = Buffer.from(
      nodeCrypto.hkdfSync("sha256", Buffer.from(manifestId, "utf8"), Buffer.from("treasurenet:clue-key-wrap", "utf8"), Buffer.from("clue-aes-key", "utf8"), 32)
    );
    const wrapCipher = nodeCrypto.createCipheriv("aes-256-gcm", wrapKey, Buffer.alloc(12, 0));
    const keyWrapped = Buffer.concat([wrapCipher.update(clueKey), wrapCipher.final(), wrapCipher.getAuthTag()]);
    const keyAttached = await api("POST", "/files/clue/key", {
      hunt_id: filesHuntId,
      clue_index: 0,
      key_wrapped_b64: keyWrapped.toString("base64"),
      gm_signature: signMessage(`clue-key:${manifestId}`, gm.privateKeyHex),
    });
    check("clue key attached", keyAttached.status === 200 && keyAttached.json.ok === true);

    const filesPlayer = generateKeyPair();
    await api("POST", "/wallet/register", { did: filesPlayer.did });
    const filesPlayerToken = await login(filesPlayer);
    await api("POST", "/roles/grant", { did: filesPlayer.did, role: "player" });
    await api("POST", "/consent/grant", { purposes: ["location", "photo"] }, filesPlayerToken);
    await api("POST", `/games/${filesHuntId}/join`, undefined, filesPlayerToken);

    const lockedRead = await api("POST", "/files/clue/read", { hunt_id: filesHuntId, clue_index: 0 }, filesPlayerToken);
    check(
      "locked clue read forbidden",
      lockedRead.status === 403 && lockedRead.json.code === "ClueLocked",
      JSON.stringify(lockedRead.json)
    );

    await api("POST", `/games/${filesHuntId}/checkin`, { clue_index: 0, latitude: 10.31672, longitude: 123.89081 }, filesPlayerToken);
    const clueRead = await api("POST", "/files/clue/read", { hunt_id: filesHuntId, clue_index: 0 }, filesPlayerToken);
    check(
      "unlocked clue read served",
      clueRead.status === 200 && clueRead.json.manifest_id === manifestId && clueRead.json.ciphertext_b64,
      JSON.stringify(clueRead.json).slice(0, 200)
    );

    const unwrapCipher = nodeCrypto.createDecipheriv(
      "aes-256-gcm",
      wrapKey,
      Buffer.alloc(12, 0)
    );
    const wrappedBytes = Buffer.from(clueRead.json.key_wrapped_b64, "base64");
    const wrappedMac = wrappedBytes.subarray(wrappedBytes.length - 16);
    const unwrap = Buffer.concat([
      unwrapCipher.update(wrappedBytes.subarray(0, wrappedBytes.length - 16)),
    ]);
    unwrapCipher.setAuthTag(wrappedMac);
    const recoveredKey = Buffer.concat([unwrap, unwrapCipher.final()]);
    check("wrapped clue key round-trips", recoveredKey.equals(clueKey));

    const clueBytes = Buffer.from(clueRead.json.ciphertext_b64, "base64");
    const clueMac = clueBytes.subarray(clueBytes.length - 16);
    const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", recoveredKey, Buffer.from(clueRead.json.iv_b64, "base64"));
    decipher.setAuthTag(clueMac);
    const recoveredPlaintext = Buffer.concat([decipher.update(clueBytes.subarray(0, clueBytes.length - 16)), decipher.final()]).toString("utf8");
    check("clue decrypts to original plaintext", recoveredPlaintext === cluePlaintext, recoveredPlaintext);
    const observedHash = `sha256:${nodeCrypto.createHash("sha256").update(clueBytes).digest("hex")}`;
    check("ciphertext hash matches commitment", observedHash === clueRead.json.ciphertext_hash);

    const revoked = await api("POST", "/files/clue/revoke", {
      hunt_id: filesHuntId,
      clue_index: 0,
      reader_did: filesPlayer.did,
      gm_signature: signMessage(`clue-revoke:${filesHuntId}:0:${filesPlayer.did}`, gm.privateKeyHex),
    });
    check("clue reader revoked", revoked.status === 200 && revoked.json.revoked === true);
    const revokedRead = await api("POST", "/files/clue/read", { hunt_id: filesHuntId, clue_index: 0 }, filesPlayerToken);
    check(
      "revoked reader forbidden",
      revokedRead.status === 403 && revokedRead.json.code === "ReaderRevoked",
      JSON.stringify(revokedRead.json)
    );
    const badRevoke = await api("POST", "/files/clue/revoke", {
      hunt_id: filesHuntId,
      clue_index: 0,
      reader_did: filesPlayer.did,
      gm_signature: "00".repeat(64),
    });
    check("forged revoke signature rejected", badRevoke.status === 400 && badRevoke.json.code === "InvalidSignature");

    const fileAlerts = await api("GET", "/admin/file-alerts");
    check(
      "file alerts include revocation + locked-read denial",
      fileAlerts.json?.some((a) => a.type === "clue.revoked") &&
        fileAlerts.json?.some((a) => a.type === "clue.read_denied_locked"),
      JSON.stringify(fileAlerts.json?.map((a) => a.type))
    );
  }

  // 13c: full game-design flow — funding gate, paid admission, riddle-guided
  // sequential clue chain, and instant claim via GM-delegated settlement
  {
    const adminOverview = await api("GET", "/admin/overview");
    const serviceDid = adminOverview.json?.service_did;
    check("admin overview exposes service did", typeof serviceDid === "string" && serviceDid.startsWith("did:key:"), JSON.stringify(adminOverview.json).slice(0, 120));

    // Funding gate: activation and admission are impossible until the GM
    // funds the escrow (the module itself rejects the transition).
    const gateHuntId = `hunt-smoke-gate-${runSuffix}`;
    const gateCreate = await api("POST", "/games", {
      hunt_id: gateHuntId,
      gm_did: gm.did,
      gm_signature: signMessage(claimMessages.createHunt(gateHuntId, gm.did), gm.privateKeyHex),
      title: "Unfunded Gate Beacon",
      reward_amount: 100,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      clues: [
        { index: 0, manifest_id: "manifest-gate-0", latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
      ],
      ...(serviceDid
        ? {
            auto_claim: true,
            delegate_gm_signature: signMessage(claimMessages.huntDelegate(gateHuntId, serviceDid), gm.privateKeyHex),
            delegate_escrow_gm_signature: signMessage(claimMessages.escrowDelegate(`esc-${gateHuntId}`, serviceDid), gm.privateKeyHex),
          }
        : {}),
    });
    check("gate hunt created", gateCreate.status === 200, JSON.stringify(gateCreate.json));
    check("auto_claim persisted", gateCreate.json.auto_claim === true);
    const earlyActivate = await api("POST", `/games/${gateHuntId}/activate`, {
      gm_signature: signMessage(claimMessages.activate(gateHuntId, gm.did), gm.privateKeyHex),
    });
    check(
      "activation before funding rejected",
      earlyActivate.status === 400 && earlyActivate.json.code === "InvalidStatus",
      JSON.stringify(earlyActivate.json)
    );
    const earlyJoin = await api("POST", `/games/${gateHuntId}/join`, undefined, playerToken);
    check(
      "join before activation rejected",
      earlyJoin.status === 400 && earlyJoin.json.code === "HuntNotActive",
      JSON.stringify(earlyJoin.json)
    );

    // Full flow hunt: paid admission, three riddle-guided clues, auto-claim.
    const flowHuntId = `hunt-smoke-flow-${runSuffix}`;
    const flowReward = 300;
    const flowFee = 25;
    const flowCreate = await api("POST", "/games", {
      hunt_id: flowHuntId,
      gm_did: gm.did,
      gm_signature: signMessage(claimMessages.createHunt(flowHuntId, gm.did), gm.privateKeyHex),
      title: "Riddle Chain Beacon",
      reward_amount: flowReward,
      expires_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      clues: [
        { index: 0, manifest_id: `manifest-flow-${runSuffix}-0`, latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
        { index: 1, manifest_id: `manifest-flow-${runSuffix}-1`, latitude: 10.3172, longitude: 123.8912, radius_meters: 50 },
        { index: 2, manifest_id: `manifest-flow-${runSuffix}-2`, latitude: 10.3177, longitude: 123.8916, radius_meters: 50 },
      ],
      admission: { mode: "paid", fee_amount: flowFee },
      auto_claim: true,
      delegate_gm_signature: signMessage(claimMessages.huntDelegate(flowHuntId, serviceDid), gm.privateKeyHex),
      delegate_escrow_gm_signature: signMessage(claimMessages.escrowDelegate(`esc-${flowHuntId}`, serviceDid), gm.privateKeyHex),
    });
    check(
      "flow hunt created with paid admission + auto claim",
      flowCreate.status === 200 && flowCreate.json.admission?.mode === "paid" && flowCreate.json.admission?.fee_amount === flowFee && flowCreate.json.auto_claim === true,
      JSON.stringify(flowCreate.json).slice(0, 200)
    );
    await api("POST", `/games/${flowHuntId}/fund`, {
      gm_signature: signMessage(claimMessages.fundHunt(flowHuntId, gm.did), gm.privateKeyHex),
      escrow_gm_signature: signMessage(claimMessages.fundEscrow(`esc-${flowHuntId}`), gm.privateKeyHex),
      asset_gm_signature: signMessage(
        assetMessages.transfer("treasurenet.gold", gm.did, assetMessages.vaultAccount(`esc-${flowHuntId}`), flowReward, `deposit-${flowHuntId}`),
        gm.privateKeyHex
      ),
    });
    await api("POST", `/games/${flowHuntId}/activate`, {
      gm_signature: signMessage(claimMessages.activate(flowHuntId, gm.did), gm.privateKeyHex),
    });

    // Paid admission: the fee transfer message is signed by the player's
    // device key and moves real tokens to the GM.
    const flowJoinMessage = assetMessages.transfer("treasurenet.gold", player.did, gm.did, flowFee, `join-${flowHuntId}`);
    const missingPayment = await api("POST", `/games/${flowHuntId}/join`, undefined, playerToken);
    check(
      "paid join without payment rejected",
      missingPayment.status === 400 && missingPayment.json.code === "PaymentRequired",
      JSON.stringify(missingPayment.json)
    );
    const wrongFeeSig = await api(
      "POST",
      `/games/${flowHuntId}/join`,
      { payment_signature: signMessage(assetMessages.transfer("treasurenet.gold", player.did, gm.did, flowFee + 1, `join-${flowHuntId}`), player.privateKeyHex) },
      playerToken
    );
    check(
      "wrong-fee admission signature rejected",
      wrongFeeSig.status === 400 && wrongFeeSig.json.code === "InvalidSignature",
      JSON.stringify(wrongFeeSig.json)
    );
    const brokePlayer = generateKeyPair();
    await api("POST", "/wallet/register", { did: brokePlayer.did });
    const brokeToken = await login(brokePlayer);
    const brokeJoin = await api(
      "POST",
      `/games/${flowHuntId}/join`,
      { payment_signature: signMessage(assetMessages.transfer("treasurenet.gold", brokePlayer.did, gm.did, flowFee, `join-${flowHuntId}`), brokePlayer.privateKeyHex) },
      brokeToken
    );
    check(
      "paid join without balance rejected on-chain",
      brokeJoin.status === 400 && brokeJoin.json.code === "InsufficientFunds",
      JSON.stringify(brokeJoin.json)
    );
    const paidJoin = await api(
      "POST",
      `/games/${flowHuntId}/join`,
      { payment_signature: signMessage(flowJoinMessage, player.privateKeyHex) },
      playerToken
    );
    check(
      "paid admission join accepted",
      paidJoin.status === 200 && paidJoin.json.fee_paid === flowFee && paidJoin.json.mode === "paid",
      JSON.stringify(paidJoin.json)
    );
    const gmBalance = await api("GET", `/wallet/${encodeURIComponent(gm.did)}/balance`);
    check("admission fee credited to GM", gmBalance.json?.balance === flowFee, JSON.stringify(gmBalance.json));
    const playerBalanceAfterFee = await api("GET", `/wallet/${encodeURIComponent(player.did)}/balance`);
    check("admission fee debited from player", playerBalanceAfterFee.json?.balance === 500 - flowFee, JSON.stringify(playerBalanceAfterFee.json));

    // Riddle for clue 0 rides the encrypted clue channel; solving it reveals
    // the coordinates players must walk to for clue 1.
    const nodeCrypto = await import("node:crypto");
    const riddlePlaintext = "From the harbor master's steps walk east past two moorings; the next mark sits where the seawall ends (10.3172, 123.8912).";
    const riddleKey = nodeCrypto.randomBytes(32);
    const riddleIv = nodeCrypto.randomBytes(12);
    const riddleCipher = nodeCrypto.createCipheriv("aes-256-gcm", riddleKey, riddleIv);
    const riddleCiphertext = Buffer.concat([riddleCipher.update(riddlePlaintext, "utf8"), riddleCipher.final(), riddleCipher.getAuthTag()]);
    await api("POST", "/files/clue", {
      hunt_id: flowHuntId,
      clue_index: 0,
      ciphertext_b64: riddleCiphertext.toString("base64"),
      iv_b64: riddleIv.toString("base64"),
      gm_did: gm.did,
      gm_signature: signMessage(`clue-upload:${flowHuntId}:0`, gm.privateKeyHex),
    });

    // Sequential chain: clue 0 -> riddle decrypt -> clue 1 -> clue 2 (final).
    const flowOutOfOrder = await api("POST", `/games/${flowHuntId}/checkin`, { clue_index: 2, latitude: 10.3177, longitude: 123.8916 }, playerToken);
    check(
      "skipping ahead the clue chain rejected",
      flowOutOfOrder.status === 400 && flowOutOfOrder.json.code === "OutOfOrderClue",
      JSON.stringify(flowOutOfOrder.json)
    );
    await api("POST", `/games/${flowHuntId}/checkin`, { clue_index: 0, latitude: 10.31672, longitude: 123.89081 }, playerToken);
    const riddleRead = await api("POST", "/files/clue/read", { hunt_id: flowHuntId, clue_index: 0 }, playerToken);
    check("riddle served after unlock", riddleRead.status === 200 && riddleRead.json.ciphertext_b64, JSON.stringify(riddleRead.json).slice(0, 120));
    await api("POST", `/games/${flowHuntId}/checkin`, { clue_index: 1, latitude: 10.31721, longitude: 123.89119 }, playerToken);

    // Final treasure coordinates: unlock + instant claim in one request.
    const finalCheckin = await api("POST", `/games/${flowHuntId}/checkin`, { clue_index: 2, latitude: 10.31772, longitude: 123.89159 }, playerToken);
    check(
      "final clue unlocked with instant claim",
      finalCheckin.status === 200 &&
        finalCheckin.json.is_final_clue === true &&
        finalCheckin.json.instant_claim?.status === "confirmed",
      JSON.stringify(finalCheckin.json).slice(0, 300)
    );
    check("instant claim has receipt", typeof finalCheckin.json.instant_claim?.receipt_id === "string");
    const playerBalanceFinal = await api("GET", `/wallet/${encodeURIComponent(player.did)}/balance`);
    check(
      "reward credited instantly",
      playerBalanceFinal.json?.balance === 500 - flowFee + flowReward,
      JSON.stringify(playerBalanceFinal.json)
    );
    const flowHuntAfter = await api("GET", `/games/${flowHuntId}`);
    check("flow hunt completed", flowHuntAfter.json.status === "completed" && flowHuntAfter.json.winner_did === player.did);
    const flowEscrow = await api("GET", `/escrow/esc-${flowHuntId}/status`);
    check("flow escrow Completed", flowEscrow.json?.status === "Completed", JSON.stringify(flowEscrow.json));
    const instantNotified = await api("GET", `/wallet/${encodeURIComponent(player.did)}/notifications`);
    check(
      "instant claim notification sent",
      instantNotified.json?.some((n) => n.type === "claim.instant"),
      JSON.stringify(instantNotified.json?.map((n) => n.type))
    );
    const lateJoin = await api("POST", `/games/${flowHuntId}/join`, undefined, player2Token);
    check(
      "join after completion rejected",
      lateJoin.status === 400 && lateJoin.json.code === "HuntNotActive",
      JSON.stringify(lateJoin.json)
    );
  }

  // 14: refund after expiry — scheduler self-serve with the configured GM
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

  // 15: rate limiting — a second server with a tiny general bucket
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

  // 16: external oracle mode — reference AI service with pinned verifier DID
  const oraclePort = 7761;
  const oracleKeyHex =
    process.env.TREASURENET_ORACLE_KEY ??
    "5dd19fb5ca3a25c2098fbdef1d01a28a35f0736b26cc50a36495a75c5ffba55b";
  const oracleDid = didFromPrivateKeyHex(oracleKeyHex);
  const oracleProc = spawn(process.execPath, ["service.mjs"], {
    cwd: new URL("../apps/oracle/", import.meta.url).pathname,
    env: { ...process.env, ORACLE_KEY_HEX: oracleKeyHex, ORACLE_PORT: String(oraclePort) },
    stdio: "ignore",
  });
  const oracleBase = `http://127.0.0.1:${oraclePort}`;
  const extPort = 7758;
  const extBase = `http://127.0.0.1:${extPort}`;
  const extServer = spawn(process.execPath, ["src/main.ts"], {
    cwd: serverCwd,
    env: {
      ...process.env,
      TREASURENET_PORT: String(extPort),
      TREASURENET_ORACLE_MODE: "external",
      TREASURENET_ORACLE_URL: `${oracleBase}/verdict`,
      TREASURENET_ORACLE_VERIFIER_DID: oracleDid,
      TREASURENET_ORACLE_KEY: oracleKeyHex,
    },
    stdio: "ignore",
  });
  async function extCall(method, path, body, token, base = extBase) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  }
  try {
    check("external oracle service healthy", await waitForBoot(oracleBase));
    check("external-mode server healthy", await waitForBoot(extBase));
    const extPlayer = generateKeyPair();
    await extCall("POST", "/wallet/register", { did: gm.did });
    await extCall("POST", "/wallet/register", { did: extPlayer.did });
    const extPlayerToken = await (async () => {
      const challenge = await extCall("POST", "/auth/challenge", { did: extPlayer.did });
      const sig = signMessage(challenge.json.message, extPlayer.privateKeyHex);
      const session = await extCall("POST", "/auth/verify", { did: extPlayer.did, signature: sig });
      return session.json.token;
    })();
    await extCall("POST", "/roles/grant", { did: gm.did, role: "gamemaster" });
    await extCall("POST", "/roles/grant", { did: extPlayer.did, role: "player" });
    const extHuntId = `hunt-smoke-ext-${runSuffix}`;
    await extCall("POST", "/games", {
      hunt_id: extHuntId,
      gm_did: gm.did,
      gm_signature: signMessage(claimMessages.createHunt(extHuntId, gm.did), gm.privateKeyHex),
      title: "External Oracle Beacon",
      reward_amount: 90,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      clues: [
        { index: 0, manifest_id: "manifest-ext-0", latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
      ],
    });
    await extCall("POST", `/games/${extHuntId}/fund`, {
      gm_signature: signMessage(claimMessages.fundHunt(extHuntId, gm.did), gm.privateKeyHex),
      escrow_gm_signature: signMessage(claimMessages.fundEscrow(`esc-${extHuntId}`), gm.privateKeyHex),
      asset_gm_signature: signMessage(
        assetMessages.transfer("treasurenet.gold", gm.did, assetMessages.vaultAccount(`esc-${extHuntId}`), 90, `deposit-${extHuntId}`),
        gm.privateKeyHex
      ),
    });
    await extCall("POST", `/games/${extHuntId}/activate`, {
      gm_signature: signMessage(claimMessages.activate(extHuntId, gm.did), gm.privateKeyHex),
    });
    await extCall("POST", "/consent/grant", { purposes: ["location", "photo"] }, extPlayerToken);
    await extCall("POST", `/games/${extHuntId}/join`, undefined, extPlayerToken);
    await extCall("POST", `/games/${extHuntId}/checkin`, { clue_index: 0, latitude: 10.31672, longitude: 123.89081 }, extPlayerToken);
    const extClaim = await extCall(
      "POST",
      `/games/${extHuntId}/claim`,
      {
        gm_signature: signMessage(claimMessages.hunt(extHuntId, extPlayer.did), gm.privateKeyHex),
        escrow_gm_signature: signMessage(claimMessages.escrow(`esc-${extHuntId}`, extPlayer.did), gm.privateKeyHex),
        asset_gm_signature: signMessage(
          assetMessages.vaultTransfer(`esc-${extHuntId}`, extPlayer.did, 90, `claim-${extHuntId}`),
          gm.privateKeyHex
        ),
        photo_b64: "cGhvdG8tcHJvb2YtZGVtbwo=".repeat(4),
        latitude: 10.3167,
        longitude: 123.8908,
      },
      extPlayerToken
    );
    check(
      "external-oracle claim confirmed",
      extClaim.status === 200 && extClaim.json.status === "confirmed",
      JSON.stringify(extClaim.json)
    );
    const extVerdicts = await extCall("GET", `/oracle/verdicts/${extHuntId}`);
    check(
      "external verdict recorded from pinned did",
      extVerdicts.json?.some(
        (v) => v.oracle_did === oracleDid && v.passed === true && v.verdict_signature
      ),
      JSON.stringify(extVerdicts.json)
    );
  } finally {
    extServer.kill("SIGTERM");
  }

  // 17: pinned-verifier rejection — verdict signed by a foreign oracle did
  const rogueDid = didFromPrivateKeyHex(generateKeyPair().privateKeyHex);
  const pinPort = 7759;
  const pinBase = `http://127.0.0.1:${pinPort}`;
  const pinCall = (method, path, body, token) => extCall(method, path, body, token, pinBase);
  const pinServer = spawn(process.execPath, ["src/main.ts"], {
    cwd: serverCwd,
    env: {
      ...process.env,
      TREASURENET_PORT: String(pinPort),
      TREASURENET_ORACLE_MODE: "external",
      TREASURENET_ORACLE_URL: `${oracleBase}/verdict`,
      TREASURENET_ORACLE_VERIFIER_DID: rogueDid,
      TREASURENET_ORACLE_KEY: oracleKeyHex,
    },
    stdio: "ignore",
  });
  try {
    check("pinned-verifier server healthy", await waitForBoot(pinBase));
    const pinPlayer = generateKeyPair();
    await pinCall("POST", "/wallet/register", { did: gm.did });
    await pinCall("POST", "/wallet/register", { did: pinPlayer.did });
    const pinPlayerToken = await (async () => {
      const challenge = await pinCall("POST", "/auth/challenge", { did: pinPlayer.did });
      const sig = signMessage(challenge.json.message, pinPlayer.privateKeyHex);
      const session = await pinCall("POST", "/auth/verify", { did: pinPlayer.did, signature: sig });
      return session.json.token;
    })();
    await pinCall("POST", "/roles/grant", { did: gm.did, role: "gamemaster" });
    await pinCall("POST", "/roles/grant", { did: pinPlayer.did, role: "player" });
    const pinHuntId = `hunt-smoke-pin-${runSuffix}`;
    await pinCall("POST", "/games", {
      hunt_id: pinHuntId,
      gm_did: gm.did,
      gm_signature: signMessage(claimMessages.createHunt(pinHuntId, gm.did), gm.privateKeyHex),
      title: "Pinned Verifier Beacon",
      reward_amount: 40,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      clues: [
        { index: 0, manifest_id: "manifest-pin-0", latitude: 10.3167, longitude: 123.8908, radius_meters: 50 },
      ],
    });
    await pinCall("POST", `/games/${pinHuntId}/fund`, {
      gm_signature: signMessage(claimMessages.fundHunt(pinHuntId, gm.did), gm.privateKeyHex),
      escrow_gm_signature: signMessage(claimMessages.fundEscrow(`esc-${pinHuntId}`), gm.privateKeyHex),
      asset_gm_signature: signMessage(
        assetMessages.transfer("treasurenet.gold", gm.did, assetMessages.vaultAccount(`esc-${pinHuntId}`), 40, `deposit-${pinHuntId}`),
        gm.privateKeyHex
      ),
    });
    await pinCall("POST", `/games/${pinHuntId}/activate`, {
      gm_signature: signMessage(claimMessages.activate(pinHuntId, gm.did), gm.privateKeyHex),
    });
    await pinCall("POST", "/consent/grant", { purposes: ["location", "photo"] }, pinPlayerToken);
    await pinCall("POST", `/games/${pinHuntId}/join`, undefined, pinPlayerToken);
    await pinCall("POST", `/games/${pinHuntId}/checkin`, { clue_index: 0, latitude: 10.31672, longitude: 123.89081 }, pinPlayerToken);
    const pinClaim = await pinCall(
      "POST",
      `/games/${pinHuntId}/claim`,
      {
        gm_signature: signMessage(claimMessages.hunt(pinHuntId, pinPlayer.did), gm.privateKeyHex),
        escrow_gm_signature: signMessage(claimMessages.escrow(`esc-${pinHuntId}`, pinPlayer.did), gm.privateKeyHex),
        asset_gm_signature: signMessage(
          assetMessages.vaultTransfer(`esc-${pinHuntId}`, pinPlayer.did, 40, `claim-${pinHuntId}`),
          gm.privateKeyHex
        ),
        photo_b64: "cGhvdG8tcHJvb2YtZGVtbwo=".repeat(4),
        latitude: 10.3167,
        longitude: 123.8908,
      },
      pinPlayerToken
    );
    check(
      "foreign-did verdict rejected",
      pinClaim.status === 400 && pinClaim.json.code === "VerificationFailed",
      JSON.stringify(pinClaim.json)
    );
  } finally {
    pinServer.kill("SIGTERM");
    oracleProc.kill("SIGTERM");
  }

  // 18: durable projection — create a hunt, restart the backend, verify the
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
