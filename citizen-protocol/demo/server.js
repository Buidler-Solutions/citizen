const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { verifyMessage } = require("ethers");

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 4300);
const CHAIN_PATH = path.join(__dirname, "data", "chain.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const challenges = new Map();

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeDid(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isValidDid(value) {
  return /^did:[a-z0-9]+:[a-z0-9:._-]{3,120}$/.test(value);
}

function pruneExpiredChallenges() {
  const now = Date.now();
  for (const [id, challenge] of challenges.entries()) {
    if (challenge.expiresAt <= now || challenge.consumed) {
      challenges.delete(id);
    }
  }
}

function readChain() {
  if (!fs.existsSync(CHAIN_PATH)) {
    const genesis = createGenesisChain();
    writeChain(genesis);
    return genesis;
  }

  const contents = fs.readFileSync(CHAIN_PATH, "utf8");
  const parsed = JSON.parse(contents);
  parsed.identities = parsed.identities ?? { didToWallet: {}, walletToDid: {} };
  parsed.identities.didToWallet = parsed.identities.didToWallet ?? {};
  parsed.identities.walletToDid = parsed.identities.walletToDid ?? {};
  return parsed;
}

function writeChain(chain) {
  fs.writeFileSync(CHAIN_PATH, JSON.stringify(chain, null, 2));
}

function createGenesisChain() {
  const genesisBlock = {
    height: 0,
    previousHash: "0".repeat(64),
    timestamp: nowIso(),
    proposer: "genesis.system",
    transactions: [],
    merkleRoot: sha256("[]")
  };

  genesisBlock.blockHash = sha256(canonicalJson(genesisBlock));

  return {
    network: "citizen-demo",
    namespace: "content.blog",
    createdAt: nowIso(),
    identities: {
      didToWallet: {},
      walletToDid: {}
    },
    blocks: [genesisBlock]
  };
}

function buildMerkleRoot(transactions) {
  if (!transactions.length) {
    return sha256("[]");
  }

  let hashes = transactions.map((tx) => sha256(canonicalJson(tx)));
  while (hashes.length > 1) {
    const next = [];
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = hashes[i + 1] ?? left;
      next.push(sha256(left + right));
    }
    hashes = next;
  }
  return hashes[0];
}

function flattenArticles(chain) {
  return chain.blocks
    .flatMap((block) => block.transactions.map((tx) => ({ blockHeight: block.height, blockHash: block.blockHash, ...tx })))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
}

function appendArticleToChain(chain, articleDraft) {
  const previousBlock = chain.blocks[chain.blocks.length - 1];
  const articleHash = sha256(articleDraft.content);
  const timestamp = nowIso();

  const tx = {
    entryId: crypto.randomUUID(),
    namespace: "content.blog",
    action: "PUBLISH_ARTICLE",
    objectId: `article-${Date.now()}`,
    author: articleDraft.author,
    authorWallet: articleDraft.authorWallet,
    authorDid: articleDraft.authorDid,
    title: articleDraft.title,
    excerpt: articleDraft.content.slice(0, 180),
    tags: articleDraft.tags,
    content: articleDraft.content,
    contentHash: articleHash,
    publishedAt: timestamp,
    signature: articleDraft.walletSignature,
    signedMessage: articleDraft.signedMessage,
    verification: articleDraft.verification
  };

  const newBlock = {
    height: previousBlock.height + 1,
    previousHash: previousBlock.blockHash,
    timestamp,
    proposer: "validator.demo.alpha",
    transactions: [tx],
    merkleRoot: buildMerkleRoot([tx])
  };

  newBlock.blockHash = sha256(canonicalJson(newBlock));
  chain.blocks.push(newBlock);
  writeChain(chain);

  return {
    block: newBlock,
    transaction: tx
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
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

  const errors = [];
  if (title.length < 5) {
    errors.push("title must have at least 5 characters");
  }
  if (author.length < 3) {
    errors.push("author must have at least 3 characters");
  }
  if (content.length < 100) {
    errors.push("content must have at least 100 characters");
  }

  return {
    valid: errors.length === 0,
    errors,
    draft: { title, author, content, tags }
  };
}

function normalizeWallet(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function ensureDidBinding(chain, did, wallet) {
  const existingWallet = chain.identities.didToWallet[did];
  if (existingWallet && existingWallet !== wallet) {
    return {
      valid: false,
      error: `DID ${did} is already bound to wallet ${existingWallet}`
    };
  }

  const existingDid = chain.identities.walletToDid[wallet];
  if (existingDid && existingDid !== did) {
    return {
      valid: false,
      error: `Wallet ${wallet} is already bound to DID ${existingDid}`
    };
  }

  chain.identities.didToWallet[did] = wallet;
  chain.identities.walletToDid[wallet] = did;
  writeChain(chain);

  return { valid: true };
}

function createSigningChallenge(chain, body) {
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
    return {
      valid: false,
      status: 422,
      payload: { error: "author must be a valid DID (did:<method>:<identifier>)" }
    };
  }

  const binding = ensureDidBinding(chain, authorDid, wallet);
  if (!binding.valid) {
    return { valid: false, status: 409, payload: { error: binding.error } };
  }

  const challengeId = crypto.randomUUID();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + CHALLENGE_TTL_MS;
  const contentHash = sha256(draft.content);
  const message = [
    "Citizen BlogChain Publisher",
    `Challenge: ${challengeId}`,
    `Wallet: ${wallet}`,
    `Author DID: ${authorDid}`,
    `Title: ${draft.title}`,
    `Content Hash: ${contentHash}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    `Expires At: ${new Date(expiresAt).toISOString()}`
  ].join("\n");

  challenges.set(challengeId, {
    challengeId,
    wallet,
    authorDid,
    draft,
    message,
    contentHash,
    issuedAt,
    expiresAt,
    consumed: false
  });

  return {
    valid: true,
    payload: {
      challengeId,
      message,
      expiresAt: new Date(expiresAt).toISOString(),
      authorDid,
      wallet
    }
  };
}

function validateChallengeSubmission(body) {
  pruneExpiredChallenges();

  const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
  const walletSignature = typeof body.walletSignature === "string" ? body.walletSignature : "";
  const wallet = normalizeWallet(body.wallet);

  if (!challengeId) {
    return { valid: false, status: 422, payload: { error: "challengeId is required" } };
  }
  if (!walletSignature) {
    return { valid: false, status: 422, payload: { error: "walletSignature is required" } };
  }
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return { valid: false, status: 422, payload: { error: "wallet must be a valid 20-byte hex address" } };
  }

  const challenge = challenges.get(challengeId);
  if (!challenge) {
    return {
      valid: false,
      status: 404,
      payload: { error: "challenge_not_found", details: ["Request a new signing challenge."] }
    };
  }

  if (challenge.consumed) {
    return {
      valid: false,
      status: 409,
      payload: { error: "challenge_already_used", details: ["Request a new signing challenge."] }
    };
  }

  if (Date.now() > challenge.expiresAt) {
    challenges.delete(challengeId);
    return {
      valid: false,
      status: 422,
      payload: { error: "challenge_expired", details: ["Request a new signing challenge."] }
    };
  }

  if (challenge.wallet !== wallet) {
    return {
      valid: false,
      status: 422,
      payload: { error: "challenge_wallet_mismatch", details: ["Wallet does not match challenge wallet."] }
    };
  }

  let recoveredAddress = "";
  try {
    recoveredAddress = verifyMessage(challenge.message, walletSignature).toLowerCase();
  } catch (error) {
    return {
      valid: false,
      status: 422,
      payload: { error: "wallet_signature_invalid", details: ["Unable to recover address from signature."] }
    };
  }

  if (recoveredAddress !== challenge.wallet) {
    return {
      valid: false,
      status: 422,
      payload: {
        error: "wallet_signature_mismatch",
        details: ["Signature signer does not match challenge wallet."]
      }
    };
  }

  challenge.consumed = true;

  return {
    valid: true,
    payload: {
      challenge,
      walletSignature,
      verification: {
        authorWallet: challenge.wallet,
        recoveredAddress,
        authorDid: challenge.authorDid,
        contentHash: challenge.contentHash
      }
    }
  };
}

function handleApi(req, res, url) {
  const chain = readChain();

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { status: "ok", blocks: chain.blocks.length });
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/status") {
    return sendJson(res, 200, {
      status: "ok",
      didBindings: Object.keys(chain.identities.didToWallet).length
    });
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/challenge") {
    return parseBody(req)
      .then((body) => {
        const challengeResult = createSigningChallenge(chain, body);
        if (!challengeResult.valid) {
          return sendJson(res, challengeResult.status, challengeResult.payload);
        }
        return sendJson(res, 201, challengeResult.payload);
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
  }

  if (req.method === "GET" && url.pathname === "/api/articles") {
    const articles = flattenArticles(chain).map((article) => ({
      entryId: article.entryId,
      title: article.title,
      author: article.author,
      authorWallet: article.authorWallet,
      authorDid: article.authorDid,
      excerpt: article.excerpt,
      tags: article.tags,
      publishedAt: article.publishedAt,
      contentHash: article.contentHash,
      blockHeight: article.blockHeight,
      blockHash: article.blockHash
    }));

    return sendJson(res, 200, { articles });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/articles/")) {
    const articleId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const article = flattenArticles(chain).find((item) => item.entryId === articleId);
    if (!article) {
      return sendJson(res, 404, { error: "article not found" });
    }

    return sendJson(res, 200, { article });
  }

  if (req.method === "GET" && url.pathname === "/api/chain") {
    return sendJson(res, 200, {
      chain: {
        network: chain.network,
        namespace: chain.namespace,
        height: chain.blocks[chain.blocks.length - 1].height,
        identities: chain.identities,
        blocks: chain.blocks
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/articles") {
    return parseBody(req)
      .then((body) => {
        const submission = validateChallengeSubmission(body);
        if (!submission.valid) {
          return sendJson(res, submission.status, submission.payload);
        }

        const { challenge, walletSignature, verification } = submission.payload;
        const receipt = appendArticleToChain(chain, {
          ...challenge.draft,
          author: challenge.authorDid,
          authorWallet: challenge.wallet,
          authorDid: challenge.authorDid,
          walletSignature,
          signedMessage: challenge.message,
          verification
        });

        return sendJson(res, 201, {
          message: "Article published, wallet validated, DID linked, and anchored to blockchain",
          receipt
        });
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
  }

  return false;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requested).replace(/^\.\.(\/|\\|$)/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, file) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(file);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${PORT}`}`);

  if (url.pathname.startsWith("/api/")) {
    const handled = handleApi(req, res, url);
    if (handled !== false) {
      return;
    }
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Citizen blog demo running at http://${HOST}:${PORT}`);
});
