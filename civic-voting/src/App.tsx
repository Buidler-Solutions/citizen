import { useState, useEffect, useCallback } from "react";

const NODE_BASE = import.meta.env.VITE_NODE_URL ?? "";

interface Proposal {
  proposal_id: string;
  title: string | null;
  description: string | null;
  opened_at: number;
  opened_by: string;
  status: string;
}

interface Tally {
  proposal_id: string;
  total_ballots: number;
  tally: Record<string, number>;
  voters: string[];
}

export default function App() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(
    null,
  );
  const [tally, setTally] = useState<Tally | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [walletConnected, setWalletConnected] = useState(false);
  const [signerDid, setSignerDid] = useState<string>("");

  const fetchProposals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/civic/proposals`);
      if (!res.ok) throw new Error("Failed to fetch proposals");
      const data = await res.json();
      setProposals(data.proposals ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTally = useCallback(async (proposalId: string) => {
    try {
      const res = await fetch(
        `${NODE_BASE}/api/v1/civic/proposals/${proposalId}/tally`,
      );
      if (!res.ok) throw new Error("Failed to fetch tally");
      const data = await res.json();
      setTally(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  const selectProposal = (proposal: Proposal) => {
    setSelectedProposal(proposal);
    setTally(null);
    setSubmitResult(null);
    fetchTally(proposal.proposal_id);
  };

  const connectWallet = async () => {
    const provider = (window as any).citizen ?? (window as any).ethereum;
    if (!provider) {
      setError(
        "No wallet provider found. Install the Citizen wallet extension.",
      );
      return;
    }
    try {
      const accounts = await provider.request({
        method: "citizen_requestAccounts",
      });
      if (accounts && accounts.length > 0) {
        setSignerDid(accounts[0]);
        setWalletConnected(true);
      }
    } catch {
      try {
        const accounts = await provider.request({
          method: "eth_requestAccounts",
        });
        if (accounts && accounts.length > 0) {
          setSignerDid(accounts[0]);
          setWalletConnected(true);
        }
      } catch {
        setError("Wallet connection rejected");
      }
    }
  };

  const castBallot = async (choice: string) => {
    if (!selectedProposal || !walletConnected) return;
    setSubmitting(true);
    setSubmitResult(null);
    setError(null);

    try {
      const entry = {
        entry_id: crypto.randomUUID(),
        namespace: "civic.ballot",
        action: "CAST_BALLOT",
        object_id: `ballot-${signerDid}-${selectedProposal.proposal_id}`,
        payload: {
          proposal_id: selectedProposal.proposal_id,
          choice,
        },
        author: signerDid,
        signature: "",
        timestamp: Math.floor(Date.now() / 1000),
        privacy_flag: false,
        privacy_mode: "none",
      };

      const signingPayload = JSON.stringify({
        entry_id: entry.entry_id,
        namespace: entry.namespace,
        action: entry.action,
        object_id: entry.object_id,
        payload: entry.payload,
        author: entry.author,
        timestamp: entry.timestamp,
      });

      const provider = (window as any).citizen ?? (window as any).ethereum;
      let signature = "";

      try {
        signature = await provider.request({
          method: "personal_sign",
          params: [signingPayload, signerDid],
        });
      } catch {
        setError("Signing rejected");
        setSubmitting(false);
        return;
      }

      entry.signature = signature;

      const res = await fetch(`${NODE_BASE}/api/v1/entries/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Submission failed (${res.status}): ${body}`);
      }

      setSubmitResult(`Ballot cast successfully: "${choice}"`);
      await fetchTally(selectedProposal.proposal_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  };

  const maxTally = tally
    ? Math.max(...Object.values(tally.tally), 1)
    : 1;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Civic Participation</p>
          <h1>Proposal Voting</h1>
          <p className="lead">
            Cast your ballot on governance proposals. Every vote is verifiable,
            tamper-proof, and secured by your citizenship credential.
          </p>
        </div>
        <button
          className={`btn ${walletConnected ? "btn-ghost" : "btn-primary"}`}
          onClick={connectWallet}
          disabled={walletConnected}
        >
          {walletConnected
            ? `${signerDid.slice(0, 16)}...`
            : "Connect Wallet"}
        </button>
      </header>

      {error && (
        <div className="banner banner-error">
          <strong>Error:</strong> {error}
          <button className="dismiss" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {submitResult && (
        <div className="banner banner-success">
          {submitResult}
          <button className="dismiss" onClick={() => setSubmitResult(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="voting-layout">
        <div className="proposals-panel">
          <div className="panel-header">
            <h2>Open Proposals</h2>
            <button
              className="btn btn-ghost btn-sm"
              onClick={fetchProposals}
              disabled={loading}
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
          </div>

          {proposals.length === 0 && !loading && (
            <p className="empty-state">No proposals are currently open.</p>
          )}

          {proposals.map((p) => (
            <div
              key={p.proposal_id}
              className={`proposal-card ${
                selectedProposal?.proposal_id === p.proposal_id
                  ? "selected"
                  : ""
              }`}
              onClick={() => selectProposal(p)}
            >
              <div className="proposal-card-header">
                <span
                  className={`status-badge ${p.status === "open" ? "open" : "closed"}`}
                >
                  {p.status}
                </span>
                <span className="proposal-id">{p.proposal_id}</span>
              </div>
              <h3>{p.title ?? p.proposal_id}</h3>
              {p.description && (
                <p className="proposal-desc">{p.description}</p>
              )}
            </div>
          ))}
        </div>

        <div className="detail-panel">
          {!selectedProposal && (
            <div className="empty-detail">
              <p>Select a proposal to view details and cast your ballot.</p>
            </div>
          )}

          {selectedProposal && (
            <>
              <div className="detail-header">
                <h2>
                  {selectedProposal.title ?? selectedProposal.proposal_id}
                </h2>
                <span className="proposal-meta">
                  {selectedProposal.proposal_id} - Opened by{" "}
                  {selectedProposal.opened_by.slice(0, 20)}...
                </span>
              </div>

              {selectedProposal.description && (
                <p className="detail-description">
                  {selectedProposal.description}
                </p>
              )}

              {tally && (
                <div className="tally-section">
                  <h3>Live Tally</h3>
                  <p className="total-ballots">
                    {tally.total_ballots} ballot
                    {tally.total_ballots !== 1 ? "s" : ""} cast
                  </p>
                  <div className="tally-bars">
                    {Object.entries(tally.tally)
                      .sort((a, b) => b[1] - a[1])
                      .map(([choice, count]) => (
                        <div key={choice} className="tally-row">
                          <span className="tally-label">
                            {choice.charAt(0).toUpperCase() + choice.slice(1)}
                          </span>
                          <div className="tally-bar-container">
                            <div
                              className={`tally-bar ${choice}`}
                              style={{
                                width: `${(count / maxTally) * 100}%`,
                              }}
                            />
                            <span className="tally-count">{count}</span>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              <div className="ballot-section">
                <h3>Cast Your Ballot</h3>
                {!walletConnected && (
                  <p className="wallet-prompt">
                    Connect your wallet to cast a ballot.
                  </p>
                )}
                <div className="ballot-buttons">
                  <button
                    className="vote-btn yes"
                    onClick={() => castBallot("yes")}
                    disabled={!walletConnected || submitting}
                  >
                    {submitting ? "Submitting..." : "Vote Yes"}
                  </button>
                  <button
                    className="vote-btn no"
                    onClick={() => castBallot("no")}
                    disabled={!walletConnected || submitting}
                  >
                    {submitting ? "Submitting..." : "Vote No"}
                  </button>
                  <button
                    className="vote-btn abstain"
                    onClick={() => castBallot("abstain")}
                    disabled={!walletConnected || submitting}
                  >
                    {submitting ? "Submitting..." : "Abstain"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
