const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 4300);
const CHAIN_PATH = path.join(__dirname, "data", "chain.json");
const PUBLIC_DIR = path.join(__dirname, "public");

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

function readChain() {
  if (!fs.existsSync(CHAIN_PATH)) {
    const genesis = createGenesisChain();
    writeChain(genesis);
    return genesis;
  }

  const contents = fs.readFileSync(CHAIN_PATH, "utf8");
  const parsed = JSON.parse(contents);
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
    title: articleDraft.title,
    excerpt: articleDraft.content.slice(0, 180),
    tags: articleDraft.tags,
    content: articleDraft.content,
    contentHash: articleHash,
    publishedAt: timestamp,
    signature: sha256(`${articleDraft.author}:${articleHash}`)
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

function handleApi(req, res, url) {
  const chain = readChain();

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { status: "ok", blocks: chain.blocks.length });
  }

  if (req.method === "GET" && url.pathname === "/api/articles") {
    const articles = flattenArticles(chain).map((article) => ({
      entryId: article.entryId,
      title: article.title,
      author: article.author,
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
        blocks: chain.blocks
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/articles") {
    return parseBody(req)
      .then((body) => {
        const { valid, errors, draft } = validateDraft(body);
        if (!valid) {
          return sendJson(res, 422, { error: "validation_failed", details: errors });
        }

        const receipt = appendArticleToChain(chain, draft);
        return sendJson(res, 201, {
          message: "Article published and anchored to blockchain",
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
