const form = document.querySelector("#publish-form");
const message = document.querySelector("#publish-message");
const receipt = document.querySelector("#receipt");
const articleList = document.querySelector("#article-list");
const chainMeta = document.querySelector("#chain-meta");
const chainBlocks = document.querySelector("#chain-blocks");

function setMessage(text, mode) {
  message.hidden = false;
  message.textContent = text;
  message.className = `message ${mode}`;
}

function clearMessage() {
  message.hidden = true;
  message.textContent = "";
  message.className = "message";
}

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

function renderArticles(articles) {
  if (!articles.length) {
    articleList.innerHTML = "<p class='meta'>No published articles yet.</p>";
    return;
  }

  articleList.innerHTML = articles
    .map(
      (article) => `
      <article>
        <h3>${article.title}</h3>
        <p class="meta">By ${article.author} • ${formatDate(article.publishedAt)}</p>
        <p>${article.excerpt}...</p>
        <p class="meta">Block #${article.blockHeight} • hash ${article.contentHash.slice(0, 16)}...</p>
      </article>
    `
    )
    .join("");
}

function renderChain(chain) {
  const latest = chain.blocks[chain.blocks.length - 1];
  chainMeta.textContent = `Network ${chain.network} · Namespace ${chain.namespace} · Height ${chain.height} · Latest block hash ${latest.blockHash.slice(0, 18)}...`;

  const lightweight = chain.blocks
    .slice()
    .reverse()
    .slice(0, 6)
    .map((block) => ({
      height: block.height,
      timestamp: block.timestamp,
      previousHash: block.previousHash,
      merkleRoot: block.merkleRoot,
      blockHash: block.blockHash,
      txCount: block.transactions.length,
      articleTitle: block.transactions[0]?.title ?? null
    }));

  chainBlocks.textContent = JSON.stringify(lightweight, null, 2);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.details?.join(", ") || body.error || "Request failed");
  }
  return body;
}

async function refresh() {
  const [articlesData, chainData] = await Promise.all([
    fetchJson("/api/articles"),
    fetchJson("/api/chain")
  ]);

  renderArticles(articlesData.articles);
  renderChain(chainData.chain);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();

  const payload = {
    author: form.author.value,
    title: form.title.value,
    tags: form.tags.value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    content: form.content.value
  };

  try {
    const result = await fetchJson("/api/articles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    receipt.textContent = JSON.stringify(result.receipt, null, 2);
    setMessage("Article anchored successfully. Block receipt generated.", "success");
    form.reset();
    await refresh();
  } catch (error) {
    setMessage(error.message, "error");
  }
});

refresh().catch((error) => {
  setMessage(`Failed to load data: ${error.message}`, "error");
});
