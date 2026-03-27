"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

type NetworkName = "testnet" | "futurenet" | "mainnet";

type NetworkPayload = {
  defaultNetwork: NetworkName;
  networks: Record<NetworkName, string>;
};

type PublishedArticle = {
  id: string;
  title: string;
  content: string;
  authorWallet: string;
  network: NetworkName;
  submittedAt: string;
  nodeSubmission?: {
    endpoint: string;
    network: NetworkName;
    status: number;
  };
};

type ApiError = {
  message?: string;
  error?: string;
};

declare global {
  interface Window {
    citizen?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}



function getWalletProvider() {
  return window.citizen ?? window.ethereum;
}

async function requestAccountsFromProvider(provider: {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}) {
  try {
    return (await provider.request({ method: "citizen_requestAccounts" })) as string[];
  } catch {
    return (await provider.request({ method: "eth_requestAccounts" })) as string[];
  }
}

export default function ArticlePublisher() {
  const [wallet, setWallet] = useState<string>("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [creditGrantId, setCreditGrantId] = useState("");
  const [sponsorBuilderId, setSponsorBuilderId] = useState("");
  const [articles, setArticles] = useState<PublishedArticle[]>([]);
  const [status, setStatus] = useState("Connect a wallet to start publishing.");
  const [busy, setBusy] = useState(false);
  const [targetNetwork, setTargetNetwork] = useState<NetworkName>("futurenet");
  const [networkEndpoints, setNetworkEndpoints] = useState<Record<NetworkName, string> | null>(null);

  const walletShort = useMemo(() => {
    if (!wallet) {
      return "Not connected";
    }
    return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  }, [wallet]);

  useEffect(() => {
    void Promise.all([loadNetworks(), loadArticles()]);
  }, []);

  async function loadNetworks() {
    try {
      const response = await fetch(`${apiBase}/networks`, { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as NetworkPayload;
      setTargetNetwork(payload.defaultNetwork);
      setNetworkEndpoints(payload.networks);
    } catch {
      // keep fallback defaults
    }
  }

  async function connectWallet() {
    const provider = getWalletProvider();
    if (!provider) {
      setStatus("No injected Citizen wallet detected. Start the Citizen Browser Wallet extension.");
      return;
    }

    try {
      const accounts = await requestAccountsFromProvider(provider);
      const account = accounts[0];
      if (!account) {
        setStatus("Wallet connected but no account was returned.");
        return;
      }
      setWallet(account.toLowerCase());
      setStatus("Wallet connected. Choose network, draft an article, sign, and submit.");
      await loadArticles();
    } catch {
      setStatus("Wallet connection was rejected.");
    }
  }

  async function loadArticles() {
    try {
      const response = await fetch(`${apiBase}/articles`, { cache: "no-store" });
      if (!response.ok) {
        setStatus("Could not load published articles from API.");
        return;
      }
      const payload = (await response.json()) as PublishedArticle[];
      setArticles(payload);
    } catch {
      setStatus("Could not load published articles from API.");
    }
  }

  async function signAndSubmit(event: FormEvent) {
    event.preventDefault();
    const provider = getWalletProvider();
    if (!wallet || !provider) {
      setStatus("Connect a wallet before submitting.");
      return;
    }

    setBusy(true);
    setStatus(`Requesting ${targetNetwork} signing challenge from API...`);

    try {
      const challengeResponse = await fetch(`${apiBase}/articles/challenge`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          authorWallet: wallet,
          title,
          content,
          network: targetNetwork,
          creditGrantId,
          sponsorBuilderId: sponsorBuilderId || undefined
        })
      });

      const challengePayload = (await challengeResponse.json()) as {
        challengeId?: string;
        message?: string;
        network?: NetworkName;
      };

      if (!challengeResponse.ok || !challengePayload.challengeId || !challengePayload.message) {
        setStatus("Challenge request failed. Ensure title/content are long enough.");
        return;
      }

      setStatus("Signing challenge with wallet...");
      const signature = (await provider.request({
        method: "personal_sign",
        params: [challengePayload.message, wallet]
      })) as string;

      setStatus(`Submitting signed article to ${challengePayload.network ?? targetNetwork}...`);
      const submitResponse = await fetch(`${apiBase}/articles/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          challengeId: challengePayload.challengeId,
          signature
        })
      });

      if (!submitResponse.ok) {
        const errorPayload = (await submitResponse.json().catch(() => ({}))) as ApiError;
        setStatus(
          `Submit failed: ${errorPayload.message ?? errorPayload.error ?? "unknown error"}`
        );
        return;
      }

      await submitResponse.json();
      setTitle("");
      setContent("");
      setCreditGrantId("");
      setSponsorBuilderId("");
      setStatus("Article published and submitted to selected blockchain network.");
      await loadArticles();
    } catch {
      setStatus("Publishing flow failed. Confirm wallet signing and API/network availability.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section article-publisher">
      <div className="section-heading">
        <h2>DApp demo · Wallet sign-and-submit publishing</h2>
        <p>
          Choose a blockchain target (testnet, futurenet, mainnet), sign a challenge, and submit
          through the API to the selected network endpoint.
        </p>
      </div>

      <div className="publisher-grid">
        <article className="card publisher-card">
          <h3>Publish article</h3>
          <p className="muted">Connected wallet: {walletShort}</p>
          <label>
            Target network
            <select
              value={targetNetwork}
              onChange={(event) => setTargetNetwork(event.target.value as NetworkName)}
              disabled={busy}
            >
              <option value="testnet">testnet</option>
              <option value="futurenet">futurenet</option>
              <option value="mainnet">mainnet</option>
            </select>
          </label>
          {networkEndpoints?.[targetNetwork] && (
            <p className="muted">Submit endpoint: {networkEndpoints[targetNetwork]}</p>
          )}
          <div className="hero-actions">
            <button className="button primary action-button" type="button" onClick={connectWallet}>
              Connect wallet
            </button>
            <button className="button ghost action-button" type="button" onClick={loadArticles}>
              Refresh feed
            </button>
          </div>

          <form onSubmit={signAndSubmit} className="publish-form">
            <label>
              Title
              <input
                required
                minLength={5}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Article title"
              />
            </label>
            <label>
              Content
              <textarea
                required
                minLength={20}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Describe what happened..."
              />
            </label>
            <label>
              Credit grant ID
              <input
                required
                value={creditGrantId}
                onChange={(event) => setCreditGrantId(event.target.value)}
                placeholder="grant:builder:..."
              />
            </label>
            <label>
              Sponsor builder DID (optional)
              <input
                value={sponsorBuilderId}
                onChange={(event) => setSponsorBuilderId(event.target.value)}
                placeholder="did:ledger:builder:..."
              />
            </label>
            <button className="button primary action-button" disabled={busy} type="submit">
              {busy ? "Publishing..." : "Sign & submit"}
            </button>
          </form>

          <p className="status-text">{status}</p>
        </article>

        <article className="card publisher-card">
          <h3>Published articles</h3>
          {articles.length === 0 ? (
            <p className="muted">No signed articles yet. Publish one to populate this feed.</p>
          ) : (
            <div className="article-feed">
              {articles.map((article) => (
                <article key={article.id} className="article-item">
                  <h4>{article.title}</h4>
                  <p>{article.content}</p>
                  <footer>
                    <span>{article.authorWallet}</span>
                    <span>{new Date(article.submittedAt).toLocaleString()}</span>
                    <span>
                      Network: {article.network} · HTTP {article.nodeSubmission?.status ?? "n/a"}
                    </span>
                    <span>{article.nodeSubmission?.endpoint ?? "not submitted"}</span>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
