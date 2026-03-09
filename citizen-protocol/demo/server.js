const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { verifyMessage } = require("ethers");

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 4300);
const NODE_RUNTIME_URL = (process.env.CITIZEN_NODE_URL ?? "http://127.0.0.1:8081").replace(/\/$/, "");
const CONTENT_NAMESPACE = process.env.CITIZEN_CONTENT_NAMESPACE ?? "content.article";
const PUBLIC_DIR = path.join(__dirname, "public");
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const challenges = new Map();
const didBindings = new Map();

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeDid(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isValidDid(value) {
  return /^did:[a-z0-9]+:[a-z0-9:._-]{3,120}$/.test(value);
}

function normalizeWallet(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function pruneExpiredChallenges() {
  const now = Date.now();
  for (const [id, challenge] of challenges.entries()) {
    if (challenge.expiresAt <= now || challenge.consumed) {
      challenges.delete(id);
    }
  }
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function validateDraft(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const author = typeof body.author === "string" ? body.author.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const tags = Array.isArray(body.tags)
    ? body.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];
  const creditGrantId = typeof body.creditGrantId === "string" ? body.creditGrantId.trim() : "";
  const sponsorBuilderId = typeof body.sponsorBuilderId === "string" ? body.sponsorBuilderId.trim() : "";

  const errors = [];
  if (title.length < 5) errors.push("title must have at least 5 characters");
  if (author.length < 3) errors.push("author must have at least 3 characters");
  if (content.length < 100) errors.push("content must have at least 100 characters");
  if (creditGrantId.length < 3) errors.push("creditGrantId is required (minimum 3 characters)");

  return { valid: errors.length === 0, errors, draft: { title, author, content, tags, creditGrantId, sponsorBuilderId } };
}

async function fetchNodeJson(pathname, options) {
  const response = await fetch(`${NODE_RUNTIME_URL}${pathname}`, options);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep string body
  }
  if (!response.ok) {
    const error = new Error(`Node runtime responded with ${response.status}`);
    error.details = body;
    throw error;
  }
  return body;
}

async function listArticleEntries() {
  const payload = await fetchNodeJson(`/entries/${encodeURIComponent(CONTENT_NAMESPACE)}`);
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  return entries
    .filter((entry) => entry?.action === "PUBLISH_ARTICLE")
    .sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));
}

function mapEntryToArticle(entry) {
  const rawContent = typeof entry?.payload?.content === "string" ? entry.payload.content : "";
  const publishedAt = Number.isFinite(entry.timestamp)
    ? new Date(entry.timestamp * 1000).toISOString()
    : nowIso();

  return {
    entryId: entry.entry_id,
    title: String(entry?.payload?.title ?? "Untitled"),
    author: String(entry.author ?? "unknown"),
    authorWallet: String(entry.author ?? ""),
    authorDid: String(entry?.payload?.authorDid ?? ""),
    tags: Array.isArray(entry?.payload?.tags) ? entry.payload.tags : [],
    content: rawContent,
    excerpt: rawContent.slice(0, 180),
    contentHash: sha256(rawContent),
    publishedAt,
    blockHeight: Number(entry?.timestamp ?? 0),
    blockHash: entry.signature ?? "",
  };
}

function ensureDidBinding(did, wallet) {
  const existing = didBindings.get(did);
  if (existing && existing !== wallet) {
    return { valid: false, error: `DID ${did} is already bound to wallet ${existing}` };
  }
  didBindings.set(did, wallet);
  return { valid: true };
}

function createSigningChallenge(body) {
  const { valid, errors, draft } = validateDraft(body);
  if (!valid) {
    return { valid: false, status: 422, payload: { error: "validation_failed", details: errors } };
  }

  const wallet = normalizeWallet(body.wallet);
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return { valid: false, status: 422, payload: { error: "wallet must be a valid 20-byte hex address" } };
  }

  const authorDid = normalizeDid(draft.author);
  if (!isValidDid(authorDid)) {
    return { valid: false, status: 422, payload: { error: "author must be a valid DID (did:<method>:<identifier>)" } };
  }

  const binding = ensureDidBinding(authorDid, wallet);
  if (!binding.valid) return { valid: false, status: 409, payload: { error: "did_binding_conflict", details: [binding.error] } };

  const challengeId = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + CHALLENGE_TTL_MS;
  const contentHash = sha256(draft.content);

  const message = [
    "Citizen Demo Blog Publish",
    `Challenge: ${challengeId}`,
    `Wallet: ${wallet}`,
    `DID: ${authorDid}`,
    `Namespace: ${CONTENT_NAMESPACE}`,
    `Title: ${draft.title}`,
    `Content Hash: ${contentHash}`,
    `Issued At: ${new Date(createdAt).toISOString()}`,
    `Expires At: ${new Date(expiresAt).toISOString()}`,
  ].join("\n");

  challenges.set(challengeId, {
    challengeId,
    draft,
    wallet,
    authorDid,
    createdAt,
    expiresAt,
    signedMessage: message,
    contentHash,
    consumed: false,
  });

  return {
    valid: true,
    payload: {
      challengeId,
      message,
      expiresAt: new Date(expiresAt).toISOString(),
      namespace: CONTENT_NAMESPACE,
      nodeRuntime: NODE_RUNTIME_URL,
    },
  };
}

async function finalizeSignedArticle(body) {
  const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
  const wallet = normalizeWallet(body.wallet);
  const walletSignature = typeof body.walletSignature === "string" ? body.walletSignature : "";

  if (!challengeId || !wallet || !walletSignature) {
    return { valid: false, status: 422, payload: { error: "challengeId, wallet, and walletSignature are required" } };
  }

  const challenge = challenges.get(challengeId);
  if (!challenge) {
    return { valid: false, status: 404, payload: { error: "unknown challenge id" } };
  }

  if (challenge.consumed) {
    return { valid: false, status: 409, payload: { error: "challenge already used" } };
  }

  if (Date.now() > challenge.expiresAt) {
    challenges.delete(challengeId);
    return { valid: false, status: 422, payload: { error: "challenge expired" } };
  }

  if (wallet !== challenge.wallet) {
    return { valid: false, status: 422, payload: { error: "wallet mismatch for challenge" } };
  }

  let recoveredWallet;
  try {
    recoveredWallet = verifyMessage(challenge.signedMessage, walletSignature).toLowerCase();
  } catch {
    return { valid: false, status: 422, payload: { error: "wallet signature verification failed" } };
  }

  if (recoveredWallet !== challenge.wallet) {
    return { valid: false, status: 422, payload: { error: "signature does not recover to challenge wallet" } };
  }

  const envelope = {
    envelope_id: crypto.randomUUID(),
    signer: challenge.wallet,
    signature: walletSignature,
    submitted_at: nowIso(),
    payload: {
      entry_id: crypto.randomUUID(),
      namespace: CONTENT_NAMESPACE,
      action: "PUBLISH_ARTICLE",
      object_id: `article:${challenge.challengeId}`,
      payload: {
        title: challenge.draft.title,
        content: challenge.draft.content,
        tags: challenge.draft.tags,
        authorDid: challenge.authorDid,
        signedMessage: challenge.signedMessage,
        contentHash: challenge.contentHash,
        credit_grant_id: challenge.draft.creditGrantId,
        sponsor_builder_id: challenge.draft.sponsorBuilderId || challenge.wallet,
      },
      author: challenge.wallet,
      signature: walletSignature,
      timestamp: Math.floor(Date.now() / 1000),
    },
  };

  let runtimeResponse;
  try {
    runtimeResponse = await fetchNodeJson("/api/v1/envelopes/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
  } catch (error) {
    return {
      valid: false,
      status: 503,
      payload: { error: "node_runtime_unavailable", details: error.details ?? String(error.message ?? error) },
    };
  }

  challenge.consumed = true;
  return {
    valid: true,
    payload: {
      status: "accepted",
      runtime: {
        nodeUrl: NODE_RUNTIME_URL,
        namespace: CONTENT_NAMESPACE,
      },
      receipt: runtimeResponse.receipt,
      entryId: runtimeResponse.entry_id,
    },
  };
}

function sendStaticFile(res, pathname) {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 400, { error: "invalid path" });
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const ext = path.extname(filePath);
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
      ? "text/css; charset=utf-8"
      : ext === ".js"
      ? "text/javascript; charset=utf-8"
      : "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `localhost:${PORT}`}`);

  pruneExpiredChallenges();

  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    let runtimeHealth = "unknown";
    try {
      await fetchNodeJson("/health");
      runtimeHealth = "ok";
    } catch {
      runtimeHealth = "unreachable";
    }
    sendJson(res, 200, {
      status: "ok",
      mode: "node-runtime",
      nodeRuntimeUrl: NODE_RUNTIME_URL,
      namespace: CONTENT_NAMESPACE,
      runtimeHealth,
      pendingChallenges: challenges.size,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/articles") {
    try {
      const entries = await listArticleEntries();
      sendJson(res, 200, { source: `${NODE_RUNTIME_URL}/entries/${CONTENT_NAMESPACE}`, articles: entries.map(mapEntryToArticle) });
    } catch (error) {
      sendJson(res, 503, { error: "node_runtime_unavailable", details: error.details ?? String(error.message ?? error) });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/chain") {
    try {
      const [health, namespaces, genesisBlock] = await Promise.all([
        fetchNodeJson("/health"),
        fetchNodeJson("/namespaces"),
        fetchNodeJson("/blocks/0"),
      ]);
      sendJson(res, 200, {
        chain: {
          network: "citizen-localnet",
          namespace: CONTENT_NAMESPACE,
          nodeRuntimeUrl: NODE_RUNTIME_URL,
          health,
          namespaces: namespaces.namespaces ?? [],
          genesis: genesisBlock.block ?? null,
        },
      });
    } catch (error) {
      sendJson(res, 503, { error: "node_runtime_unavailable", details: error.details ?? String(error.message ?? error) });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/wallet/challenge") {
    try {
      const body = await parseBody(req);
      const result = createSigningChallenge(body);
      if (!result.valid) {
        sendJson(res, result.status, result.payload);
        return;
      }
      sendJson(res, 201, result.payload);
    } catch (error) {
      sendJson(res, 400, { error: String(error.message ?? error) });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/articles") {
    try {
      const body = await parseBody(req);
      const result = await finalizeSignedArticle(body);
      if (!result.valid) {
        sendJson(res, result.status, result.payload);
        return;
      }
      sendJson(res, 201, result.payload);
    } catch (error) {
      sendJson(res, 400, { error: String(error.message ?? error) });
    }
    return;
  }

  if (req.method === "GET") {
    sendStaticFile(res, requestUrl.pathname);
    return;
  }

  sendJson(res, 405, { error: "method_not_allowed" });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Citizen demo blog running on http://${HOST}:${PORT} (node runtime: ${NODE_RUNTIME_URL}, namespace: ${CONTENT_NAMESPACE})`);
});
