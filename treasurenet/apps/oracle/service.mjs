#!/usr/bin/env node
/**
 * Reference external AI-oracle service for TreasureNet Citizen Edition.
 *
 * The backend oracle module (external mode) POSTs
 *   { hunt_id, player_did, clue_index, photo_b64, geo_ok }
 * here and only trusts the response when the returned verdict signature
 * verifies against the pinned TREASURENET_ORACLE_VERIFIER_DID.
 *
 * This reference implementation replaces the AI model with a deterministic
 * heuristic (same rules as the in-process heuristic oracle) and signs the
 * verdict with the configured oracle key. A production deployment swaps the
 * evaluate() body for the real model — the HTTP contract, message format,
 * and signature scheme stay identical.
 *
 * Env:
 *   ORACLE_KEY_HEX        Ed25519 private key (32-byte hex) used to sign verdicts
 *   ORACLE_PORT           listen port (default 7760)
 *   ORACLE_MIN_PHOTO_BYTES minimum decoded photo payload (default 32)
 */
import { createServer } from "node:http";
import {
  didFromPublicKey,
  publicKeyFromPrivateKeyHex,
  signMessage,
} from "../../chain/sdk/src/index.ts";

const privateKeyHex =
  process.env.ORACLE_KEY_HEX ??
  "5dd19fb5ca3a25c2098fbdef1d01a28a35f0736b26cc50a36495a75c5ffba55b";
const port = Number(process.env.ORACLE_PORT ?? 7760);
const minPhotoBytes = Number(process.env.ORACLE_MIN_PHOTO_BYTES ?? 32);
const oracleDid = didFromPublicKey(publicKeyFromPrivateKeyHex(privateKeyHex));

function verdictMessage(v) {
  return `verdict:${v.hunt_id}:${v.player_did}:${v.clue_index}:${v.passed ? "pass" : "fail"}`;
}

/**
 * Deterministic reference policy. Production swaps this for the AI model
 * call; everything else (contract, signing) is the deployment surface.
 */
function evaluate(input) {
  const photoBytes = Math.floor((input.photo_b64?.length ?? 0) * 3) / 4;
  const plausible = photoBytes >= minPhotoBytes;
  const passed = Boolean(input.geo_ok) && plausible;
  const confidence = passed ? 0.9 : input.geo_ok ? 0.15 : 0.05;
  const reason = passed
    ? "reference oracle: photo payload plausible and geo check passed"
    : input.geo_ok
      ? "reference oracle: photo payload too small to verify"
      : "reference oracle: geo proximity check failed";
  return { passed, confidence, reason };
}

const server = createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") {
    return send(200, { ok: true, oracle_did: oracleDid, mode: "external-reference" });
  }
  if (req.method !== "POST" || req.url !== "/verdict") {
    return send(404, { code: "NotFound", message: "POST /verdict is the only route" });
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(400, { code: "BadRequest", message: "body must be JSON" });
    }
    if (!input.hunt_id || !input.player_did || typeof input.clue_index !== "number" || !input.photo_b64) {
      return send(400, {
        code: "BadRequest",
        message: "hunt_id, player_did, clue_index, photo_b64 are required",
      });
    }
    const { passed, confidence, reason } = evaluate(input);
    const verdict = {
      hunt_id: input.hunt_id,
      player_did: input.player_did,
      clue_index: input.clue_index,
      passed,
      confidence,
      oracle_did: oracleDid,
      reason,
    };
    verdict.verdict_signature = signMessage(verdictMessage(verdict), privateKeyHex);
    send(200, verdict);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`reference oracle listening on http://127.0.0.1:${port} did=${oracleDid}`);
});
