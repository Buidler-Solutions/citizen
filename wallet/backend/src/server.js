import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { URL } from "node:url";
import { verifyMessage, verifyTypedData } from "ethers";

const PORT = Number(process.env.PORT ?? 4499);
const CHALLENGE_TTL_MS = Number(process.env.AUTH_CHALLENGE_TTL_MS ?? 5 * 60 * 1000);
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS ?? 30 * 60 * 1000);
const MAX_VERIFY_ATTEMPTS = Number(process.env.AUTH_MAX_VERIFY_ATTEMPTS ?? 5);
const RATE_LIMIT_WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX ?? 30);
const SESSION_SIGNING_SECRET = process.env.AUTH_SESSION_SECRET ?? "dev-insecure-secret-change-me";
const SESSION_SIGNING_SECRETS = process.env.AUTH_SESSION_SECRETS ?? "";
const TOKEN_ISSUER = process.env.AUTH_TOKEN_ISSUER ?? "citizen-wallet-auth-backend";
const TOKEN_AUDIENCE = process.env.AUTH_TOKEN_AUDIENCE ?? "citizen-dapps";

const ALLOWED_NETWORKS = new Set(["mainnet", "futurenet", "testnet", "localnode"]);
const ALLOWED_ORIGINS = new Set(
  (process.env.AUTH_ALLOWED_ORIGINS
    ?? "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const dataDir = path.resolve(process.cwd(), "data");
const statePath = path.join(dataDir, "wallet-auth-state.json");
const auditPath = path.join(dataDir, "wallet-auth-audit.log");

function parseSigningKeys() {
  const configured = SESSION_SIGNING_SECRETS
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [kid, secret] = entry.split(":", 2).map((value) => value?.trim());
      return kid && secret ? { kid, secret } : null;
    })
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }

  return [{ kid: "v1", secret: SESSION_SIGNING_SECRET }];
}

const signingKeys = parseSigningKeys();
const activeSigningKey = signingKeys[0];

function enforceSecretPolicy() {
  const minLength = 32;
  if (process.env.NODE_ENV === "production") {
    if (!activeSigningKey?.secret || activeSigningKey.secret.length < minLength) {
      throw new Error(`AUTH_SESSION_SECRET/AUTH_SESSION_SECRETS must be at least ${minLength} chars in production`);
    }
    if (activeSigningKey.secret === "dev-insecure-secret-change-me") {
      throw new Error("Default dev auth secret is forbidden in production");
    }
  }
}

/**
 * @typedef {{
 *   id: string;
 *   wallet: string;
 *   domain: string;
 *   uri: string;
 *   network: string;
 *   nonce: string;
 *   message: string;
 *   createdAt: number;
 *   expiresAt: number;
 *   consumed: boolean;
 *   consumedAt?: number;
 *   verifyAttempts: number;
 *   ipAddress: string;
 * }} AuthChallenge
 */

/**
 * @typedef {{
 *   sessionId: string;
 *   wallet: string;
 *   network: string;
 *   issuedAt: number;
 *   expiresAt: number;
 *   revoked: boolean;
 *   revokedAt?: number;
 * }} WalletSession
 */

/** @type {Map<string, AuthChallenge>} */
const challenges = new Map();
/** @type {Map<string, WalletSession>} */
const sessions = new Map();
/** @type {Map<string, { count: number; resetsAt: number }>} */
const rateLimitBuckets = new Map();

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function appendAudit(event, payload = {}) {
  ensureDataDir();
  const line = JSON.stringify({
    event,
    at: new Date().toISOString(),
    ...payload
  });
  fs.appendFileSync(auditPath, `${line}\n`);
}

function persistState() {
  ensureDataDir();
  const payload = {
    challenges: Array.from(challenges.values()),
    sessions: Array.from(sessions.values())
  };
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2));
}

function loadState() {
  if (!fs.existsSync(statePath)) {
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const now = Date.now();
    for (const challenge of Array.isArray(raw.challenges) ? raw.challenges : []) {
      if (typeof challenge?.id !== "string" || challenge.expiresAt <= now) {
        continue;
      }
      challenges.set(challenge.id, challenge);
    }
    for (const session of Array.isArray(raw.sessions) ? raw.sessions : []) {
      if (typeof session?.sessionId !== "string" || session.expiresAt <= now || session.revoked) {
        continue;
      }
      sessions.set(session.sessionId, session);
    }
  } catch {
    appendAudit("state_load_error");
  }
}

function clearExpired() {
  const now = Date.now();
  for (const [id, challenge] of challenges.entries()) {
    if (challenge.expiresAt <= now || challenge.consumed) {
      challenges.delete(id);
    }
  }
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now || session.revoked) {
      sessions.delete(id);
    }
  }
  persistState();
}

function writeJson(res, status, payload, origin = "") {
  const safeOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "";
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": safeOrigin || Array.from(ALLOWED_ORIGINS)[0] || "*",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(payload));
}

function normalizeWallet(wallet) {
  if (typeof wallet !== "string") {
    return null;
  }
  const value = wallet.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(value) ? value : null;
}

function normalizeNetwork(network) {
  if (typeof network !== "string") {
    return "futurenet";
  }
  const value = network.trim().toLowerCase();
  return ALLOWED_NETWORKS.has(value) ? value : "futurenet";
}

function createAuthMessage(challenge) {
  return [
    "Citizen Wallet Login",
    `Challenge: ${challenge.id}`,
    `Wallet: ${challenge.wallet}`,
    `Network: ${challenge.network}`,
    `Domain: ${challenge.domain}`,
    `URI: ${challenge.uri}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${new Date(challenge.createdAt).toISOString()}`,
    `Expires At: ${new Date(challenge.expiresAt).toISOString()}`
  ].join("\n");
}

function createAuthTypedData(challenge) {
  return {
    domain: {
      name: "Citizen Wallet Login",
      version: "1",
      chainId: 1
    },
    types: {
      CitizenLogin: [
        { name: "challengeId", type: "string" },
        { name: "wallet", type: "address" },
        { name: "network", type: "string" },
        { name: "domain", type: "string" },
        { name: "uri", type: "string" },
        { name: "nonce", type: "string" },
        { name: "issuedAt", type: "string" },
        { name: "expiresAt", type: "string" }
      ]
    },
    primaryType: "CitizenLogin",
    message: {
      challengeId: challenge.id,
      wallet: challenge.wallet,
      network: challenge.network,
      domain: challenge.domain,
      uri: challenge.uri,
      nonce: challenge.nonce,
      issuedAt: new Date(challenge.createdAt).toISOString(),
      expiresAt: new Date(challenge.expiresAt).toISOString()
    }
  };
}

function createSessionToken(session) {
  const header = Buffer.from(
    JSON.stringify({
      alg: "HS256",
      typ: "JWT",
      kid: activeSigningKey.kid
    }),
    "utf8"
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: TOKEN_ISSUER,
      aud: TOKEN_AUDIENCE,
      sub: session.wallet,
      sid: session.sessionId,
      wallet: session.wallet,
      network: session.network,
      iat: Math.floor(session.issuedAt / 1000),
      exp: Math.floor(session.expiresAt / 1000)
    }),
    "utf8"
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", activeSigningKey.secret).update(signingInput).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function parseSessionToken(token) {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length === 2) {
    // legacy support: payload.signature (pre-JWT format)
    const [payload, signature] = parts;
    const legacyExpected = createHmac("sha256", activeSigningKey.secret).update(payload).digest("base64url");
    const signatureBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(legacyExpected);
    if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
      return null;
    }
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return decoded && typeof decoded.sid === "string" ? decoded : null;
    } catch {
      return null;
    }
  }
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  let parsedHeader;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsedHeader || parsedHeader.alg !== "HS256" || typeof parsedHeader.kid !== "string") {
    return null;
  }
  const signingKey = signingKeys.find((item) => item.kid === parsedHeader.kid);
  if (!signingKey) {
    return null;
  }
  const expected = createHmac("sha256", signingKey.secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const signatureBuf = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded || typeof decoded.sid !== "string" || decoded.iss !== TOKEN_ISSUER) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function getRateLimitBucket(key) {
  const now = Date.now();
  const existing = rateLimitBuckets.get(key);
  if (!existing || now >= existing.resetsAt) {
    const next = { count: 0, resetsAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitBuckets.set(key, next);
    return next;
  }
  return existing;
}

function isRateLimited(key) {
  const bucket = getRateLimitBucket(key);
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

loadState();
enforceSecretPolicy();
setInterval(clearExpired, 30_000).unref();

const server = http.createServer(async (req, res) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const ipAddress = (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").toString();

  if (!req.url) {
    writeJson(res, 400, { error: "missing request url" }, origin);
    return;
  }

  if (req.method === "OPTIONS") {
    writeJson(res, 204, {}, origin);
    return;
  }

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    appendAudit("forbidden_origin", { origin, ipAddress });
    writeJson(res, 403, { error: "origin not allowed" }, origin);
    return;
  }

  if (isRateLimited(ipAddress)) {
    appendAudit("rate_limit_block", { ipAddress, origin });
    writeJson(res, 429, { error: "rate limit exceeded" }, origin);
    return;
  }

  const requestUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    writeJson(
      res,
      200,
      {
        status: "ok",
        service: "citizen-wallet-auth-backend",
        challengeTtlSeconds: Math.floor(CHALLENGE_TTL_MS / 1000),
        sessionTtlSeconds: Math.floor(SESSION_TTL_MS / 1000),
        activeChallenges: challenges.size,
        activeSessions: sessions.size,
        allowedOrigins: Array.from(ALLOWED_ORIGINS)
      },
      origin
    );
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/auth/challenge") {
    const body = await parseBody(req);
    if (!body || typeof body !== "object") {
      writeJson(res, 400, { error: "invalid JSON body" }, origin);
      return;
    }

    const wallet = normalizeWallet(body.wallet);
    if (!wallet) {
      writeJson(res, 422, { error: "wallet must be a 0x-prefixed 20-byte hex address" }, origin);
      return;
    }

    const now = Date.now();
    const challenge = {
      id: randomUUID(),
      wallet,
      domain: typeof body.domain === "string" && body.domain.trim() ? body.domain.trim() : "unknown-domain",
      uri: typeof body.uri === "string" && body.uri.trim() ? body.uri.trim() : "unknown-uri",
      network: normalizeNetwork(body.network),
      nonce: randomBytes(16).toString("hex"),
      message: "",
      createdAt: now,
      expiresAt: now + CHALLENGE_TTL_MS,
      consumed: false,
      verifyAttempts: 0,
      ipAddress
    };
    challenge.message = createAuthMessage(challenge);
    challenges.set(challenge.id, challenge);
    persistState();
    appendAudit("challenge_created", {
      challengeId: challenge.id,
      wallet: challenge.wallet,
      network: challenge.network,
      ipAddress
    });

    writeJson(
      res,
      200,
      {
        challengeId: challenge.id,
        wallet: challenge.wallet,
        domain: challenge.domain,
        uri: challenge.uri,
        network: challenge.network,
        nonce: challenge.nonce,
        message: challenge.message,
        typedData: createAuthTypedData(challenge),
        issuedAt: new Date(challenge.createdAt).toISOString(),
        expiresAt: new Date(challenge.expiresAt).toISOString()
      },
      origin
    );
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/auth/verify") {
    const body = await parseBody(req);
    if (!body || typeof body !== "object") {
      writeJson(res, 400, { error: "invalid JSON body" }, origin);
      return;
    }

    const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    const signatureMethod = typeof body.signatureMethod === "string"
      ? body.signatureMethod
      : "personal_sign";
    const wallet = normalizeWallet(body.wallet);

    if (!challengeId || !signature || !wallet) {
      writeJson(res, 422, { error: "challengeId, wallet, and signature are required" }, origin);
      return;
    }

    const challenge = challenges.get(challengeId);
    if (!challenge) {
      writeJson(res, 404, { error: "unknown auth challenge" }, origin);
      return;
    }
    if (challenge.consumed) {
      writeJson(res, 409, { error: "auth challenge already consumed" }, origin);
      return;
    }
    if (challenge.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
      appendAudit("verify_attempt_limit", { challengeId, wallet, ipAddress });
      writeJson(res, 429, { error: "challenge verify attempts exceeded" }, origin);
      return;
    }
    if (Date.now() > challenge.expiresAt) {
      writeJson(res, 410, { error: "auth challenge expired" }, origin);
      return;
    }
    if (wallet !== challenge.wallet) {
      challenge.verifyAttempts += 1;
      persistState();
      writeJson(res, 422, { error: "wallet mismatch for this challenge" }, origin);
      return;
    }

    let recovered;
    try {
      if (signatureMethod === "ctzn_signTypedData_v4") {
        const typedData = createAuthTypedData(challenge);
        const { domain, types, message } = typedData;
        recovered = verifyTypedData(domain, types, message, signature).toLowerCase();
      } else {
        recovered = verifyMessage(challenge.message, signature).toLowerCase();
      }
    } catch {
      challenge.verifyAttempts += 1;
      persistState();
      writeJson(res, 422, { error: "invalid signature payload" }, origin);
      return;
    }
    if (recovered !== challenge.wallet) {
      challenge.verifyAttempts += 1;
      persistState();
      writeJson(res, 422, { error: "signature does not recover to challenge wallet" }, origin);
      return;
    }

    challenge.consumed = true;
    challenge.consumedAt = Date.now();
    const session = {
      sessionId: randomUUID(),
      wallet: challenge.wallet,
      network: challenge.network,
      issuedAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      revoked: false
    };
    sessions.set(session.sessionId, session);
    persistState();

    const token = createSessionToken(session);
    appendAudit("auth_success", {
      challengeId: challenge.id,
      sessionId: session.sessionId,
      wallet: session.wallet,
      ipAddress
    });

    writeJson(
      res,
      200,
      {
        status: "authenticated",
        token,
        session: {
          sessionId: session.sessionId,
          wallet: session.wallet,
          network: session.network,
          issuedAt: new Date(session.issuedAt).toISOString(),
          expiresAt: new Date(session.expiresAt).toISOString()
        }
      },
      origin
    );
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/auth/session/verify") {
    const body = await parseBody(req);
    if (!body || typeof body !== "object" || typeof body.token !== "string") {
      writeJson(res, 422, { error: "token is required" }, origin);
      return;
    }
    const parsed = parseSessionToken(body.token);
    if (!parsed) {
      writeJson(res, 401, { error: "invalid session token" }, origin);
      return;
    }
    const session = sessions.get(parsed.sid);
    if (
      !session ||
      session.revoked ||
      session.expiresAt <= Date.now() ||
      (typeof parsed.exp === "number" && parsed.exp * 1000 <= Date.now())
    ) {
      writeJson(res, 401, { error: "session expired or revoked" }, origin);
      return;
    }
    writeJson(
      res,
      200,
      {
        status: "active",
        session: {
          sessionId: session.sessionId,
          wallet: session.wallet,
          network: session.network,
          issuedAt: new Date(session.issuedAt).toISOString(),
          expiresAt: new Date(session.expiresAt).toISOString()
        }
      },
      origin
    );
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/auth/session/revoke") {
    const body = await parseBody(req);
    if (!body || typeof body !== "object" || typeof body.token !== "string") {
      writeJson(res, 422, { error: "token is required" }, origin);
      return;
    }
    const parsed = parseSessionToken(body.token);
    if (!parsed) {
      writeJson(res, 401, { error: "invalid session token" }, origin);
      return;
    }
    const session = sessions.get(parsed.sid);
    if (!session) {
      writeJson(res, 404, { error: "session not found" }, origin);
      return;
    }
    session.revoked = true;
    session.revokedAt = Date.now();
    persistState();
    appendAudit("session_revoked", { sessionId: session.sessionId, wallet: session.wallet, ipAddress });
    writeJson(res, 200, { status: "revoked", sessionId: session.sessionId }, origin);
    return;
  }

  writeJson(res, 404, { error: "not found" }, origin);
});

server.listen(PORT, () => {
  appendAudit("server_started", {
    port: PORT,
    allowedOrigins: Array.from(ALLOWED_ORIGINS),
    challengeTtlMs: CHALLENGE_TTL_MS,
    sessionTtlMs: SESSION_TTL_MS,
    activeSigningKid: activeSigningKey.kid
  });
  console.log(`citizen-wallet-auth-backend listening on http://127.0.0.1:${PORT}`);
});
