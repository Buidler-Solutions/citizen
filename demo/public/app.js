const form = document.querySelector("#publish-form");
const message = document.querySelector("#publish-message");
const receipt = document.querySelector("#receipt");
const articleList = document.querySelector("#article-list");
const chainMeta = document.querySelector("#chain-meta");
const chainBlocks = document.querySelector("#chain-blocks");
const connectWalletButton = document.querySelector("#connect-wallet");
const walletStatus = document.querySelector("#wallet-status");

let connectedWallet = "";


function getWalletProvider() {
  return window.citizen ?? window.ethereum;
}

async function requestAccountsFromProvider(provider) {
  try {
    return await provider.request({ method: "citizen_requestAccounts" });
  } catch {
    return await provider.request({ method: "eth_requestAccounts" });
  }
}


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

function maskWallet(wallet) {
  if (!wallet || wallet.length < 10) {
    return wallet || "not connected";
  }
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function setWalletStatus(text) {
  walletStatus.textContent = text;
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
        ${article.authorWallet ? `<p class="meta">Wallet ${maskWallet(article.authorWallet)}</p>` : ""}
      </article>
    `
    )
    .join("");
}

function renderChain(chain) {
  const namespaceCount = Array.isArray(chain.namespaces) ? chain.namespaces.length : 0;
  chainMeta.textContent = `Network ${chain.network} · Runtime ${chain.nodeRuntimeUrl} · Namespace ${chain.namespace} · Namespaces registered ${namespaceCount}`;
  chainBlocks.textContent = JSON.stringify(
    {
      health: chain.health,
      genesis: chain.genesis,
      namespaces: chain.namespaces
    },
    null,
    2
  );
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

async function connectWallet() {
  const provider = getWalletProvider();
  if (!provider?.request) {
    setWalletStatus("No injected Citizen wallet found. Start Citizen Browser Wallet extension.");
    return;
  }

  try {
    const accounts = await requestAccountsFromProvider(provider);
    const wallet = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : "";
    if (!wallet) {
      setWalletStatus("Wallet connected but no account returned.");
      return;
    }

    connectedWallet = wallet;
    setWalletStatus(`Connected wallet ${maskWallet(wallet)}.`);
    const authorInput = form.author;
    if (authorInput.value.trim().length === 0) {
      authorInput.value = `did:citizen:${wallet.slice(2, 10)}`;
    }
  } catch (error) {
    setWalletStatus("Wallet connection rejected.");
  }
}

if (connectWalletButton) {
  connectWalletButton.addEventListener("click", () => {
    void connectWallet();
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();

  if (!connectedWallet) {
    setMessage("Connect wallet before publishing.", "error");
    return;
  }

  const payload = {
    author: form.author.value,
    title: form.title.value,
    tags: form.tags.value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    content: form.content.value,
    creditGrantId: form.creditGrantId.value,
    sponsorBuilderId: form.sponsorBuilderId.value || undefined,
    wallet: connectedWallet
  };

  const provider = getWalletProvider();
  if (!provider?.request) {
    setMessage("Wallet provider missing.", "error");
    return;
  }

  try {
    const challenge = await fetchJson("/api/wallet/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const walletSignature = await provider.request({
      method: "personal_sign",
      params: [challenge.message, connectedWallet]
    });

    const result = await fetchJson("/api/articles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        wallet: connectedWallet,
        walletSignature
      })
    });

    receipt.textContent = JSON.stringify(result.receipt, null, 2);
    setMessage("Article signed by wallet, DID-linked, and anchored successfully.", "success");
    form.reset();
    await refresh();
  } catch (error) {
    setMessage(error.message, "error");
  }
});

refresh().catch((error) => {
  setMessage(`Failed to load data: ${error.message}`, "error");
});
