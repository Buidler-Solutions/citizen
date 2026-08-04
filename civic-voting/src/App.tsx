import { useState, useEffect, useCallback } from "react";

const NODE_BASE = import.meta.env.VITE_NODE_URL ?? "";

interface ElectionSummary {
  election_id: string;
  title: string | null;
  opened_at: number;
  opened_by: string;
  status: string;
  race_count: number;
}

interface Candidate {
  candidate_id: string;
  name: string;
  party: string;
}

interface Race {
  race_id: string;
  title: string;
  seat_type: string;
  max_selections: number;
  candidates: Candidate[];
}

interface ElectionDetail extends ElectionSummary {
  races: Race[];
}

interface RaceTally {
  race_id: string;
  title: string;
  seat_type: string;
  max_selections: number;
  tally: Record<string, number>;
  total_ballots: number;
}

interface ElectionTally {
  election_id: string;
  total_ballots: number;
  races: RaceTally[];
  voters: string[];
}

type Selections = Record<string, string[]>;

export default function App() {
  const [elections, setElections] = useState<ElectionSummary[]>([]);
  const [selectedElection, setSelectedElection] = useState<ElectionDetail | null>(null);
  const [tally, setTally] = useState<ElectionTally | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [walletConnected, setWalletConnected] = useState(false);
  const [signerDid, setSignerDid] = useState<string>("");
  const [showResults, setShowResults] = useState(false);
  const [showManualDid, setShowManualDid] = useState(false);
  const [manualDidInput, setManualDidInput] = useState("");

  const fetchElections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/civic/elections`);
      if (!res.ok) throw new Error("Failed to fetch elections");
      const data = await res.json();
      setElections(data.elections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchElectionDetail = useCallback(async (electionId: string) => {
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/civic/elections/${electionId}`);
      if (!res.ok) throw new Error("Failed to fetch election");
      const data: ElectionDetail = await res.json();
      setSelectedElection(data);
      const init: Selections = {};
      for (const r of data.races) {
        init[r.race_id] = [];
      }
      setSelections(init);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  const fetchTally = useCallback(async (electionId: string) => {
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/civic/elections/${electionId}/tally`);
      if (!res.ok) throw new Error("Failed to fetch tally");
      const data: ElectionTally = await res.json();
      setTally(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    fetchElections();
  }, [fetchElections]);

  const selectElection = (e: ElectionSummary) => {
    setSelectedElection(null);
    setTally(null);
    setSubmitResult(null);
    setShowResults(false);
    fetchElectionDetail(e.election_id);
    fetchTally(e.election_id);
  };

  const toggleCandidate = (raceId: string, candidateId: string, max: number) => {
    setSelections((prev) => {
      const current = prev[raceId] ?? [];
      if (current.includes(candidateId)) {
        return { ...prev, [raceId]: current.filter((c) => c !== candidateId) };
      }
      if (current.length >= max) return prev;
      return { ...prev, [raceId]: [...current, candidateId] };
    });
  };

  const connectWallet = async () => {
    const provider = (window as any).ctzn ?? (window as any).citizen;
    if (!provider) {
      setError("No Citizen wallet found. Enter your DID manually below.");
      setShowManualDid(true);
      return;
    }
    try {
      const signer = await provider.request({ method: "ctzn_getCitizenSigner" });
      if (signer?.did || signer?.signer) {
        const did = signer.did ?? signer.signer;
        setSignerDid(did);
        setWalletConnected(true);
      } else {
        setError("Wallet returned no signer identity. Enter DID manually.");
        setShowManualDid(true);
      }
    } catch {
      setError("Wallet unavailable. Enter your DID manually below.");
      setShowManualDid(true);
    }
  };

  const connectManualDid = () => {
    if (!manualDidInput.trim()) return;
    setSignerDid(manualDidInput.trim());
    setWalletConnected(true);
    setShowManualDid(false);
    setError(null);
  };

  const castBallot = async () => {
    if (!selectedElection || !walletConnected) return;
    setSubmitting(true);
    setSubmitResult(null);
    setError(null);

    const entry = {
      entry_id: crypto.randomUUID(),
      namespace: "civic.election.ballot",
      action: "CAST_BALLOT",
      object_id: `ballot-${signerDid}-${selectedElection.election_id}`,
      payload: {
        election_id: selectedElection.election_id,
        selections: selectedElection.races
          .filter((r) => (selections[r.race_id] ?? []).length > 0)
          .map((r) => ({
            race_id: r.race_id,
            candidate_ids: selections[r.race_id],
          })),
      },
      author: signerDid,
      signature: "",
      timestamp: Math.floor(Date.now() / 1000),
      privacy_flag: false,
      privacy_mode: "none",
    };

    try {
      const signingPayload = JSON.stringify({
        entry_id: entry.entry_id,
        namespace: entry.namespace,
        action: entry.action,
        object_id: entry.object_id,
        payload: entry.payload,
        author: entry.author,
        timestamp: entry.timestamp,
      });

      const provider = (window as any).ctzn ?? (window as any).citizen;
      if (provider) {
        try {
          const result = await provider.request({
            method: "ctzn_signCitizenTx",
            params: [{ payload: signingPayload, author: signerDid }],
          });
          entry.signature = result?.signature ?? "placeholder";
        } catch {
          entry.signature = "placeholder";
        }
      } else {
        entry.signature = "placeholder";
      }

      const res = await fetch(`${NODE_BASE}/api/v1/entries/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Submission failed (${res.status}): ${body}`);
      }

      const racesVoted = Object.values(selections).filter((a) => a.length > 0).length;
      setSubmitResult(`Ballot cast successfully across ${racesVoted} race${racesVoted !== 1 ? "s" : ""}.`);
      await fetchTally(selectedElection.election_id);
      setShowResults(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  };

  const totalSelections = Object.values(selections).reduce((sum, a) => sum + a.length, 0);
  const racesWithSelections = Object.values(selections).filter((a) => a.length > 0).length;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Civic Participation</p>
          <h1>Election Ballot</h1>
          <p className="lead">
            Cast your ballot across all races in a single submission. President,
            senators, congressmen, mayors — every position, one atomic ballot.
          </p>
        </div>
        <button
          className={`btn ${walletConnected ? "btn-ghost" : "btn-primary"}`}
          onClick={connectWallet}
          disabled={walletConnected}
        >
          {walletConnected ? `${signerDid.slice(0, 16)}...` : "Connect Wallet"}
        </button>
      </header>

      {showManualDid && !walletConnected && (
        <div className="banner banner-manual">
          <div className="manual-did-row">
            <input
              type="text"
              className="did-input"
              value={manualDidInput}
              onChange={(e) => setManualDidInput(e.target.value)}
              placeholder="did:key:ed25519:... or did:citizen:..."
              onKeyDown={(e) => e.key === "Enter" && connectManualDid()}
            />
            <button className="btn btn-primary" onClick={connectManualDid}>
              Use This DID
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <strong>Error:</strong> {error}
          <button className="dismiss" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {submitResult && (
        <div className="banner banner-success">
          {submitResult}
          <button className="dismiss" onClick={() => setSubmitResult(null)}>Dismiss</button>
        </div>
      )}

      <div className="voting-layout">
        <div className="elections-panel">
          <div className="panel-header">
            <h2>Open Elections</h2>
            <button className="btn btn-ghost btn-sm" onClick={fetchElections} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </button>
          </div>
          {elections.length === 0 && !loading && (
            <p className="empty-state">No elections are currently open.</p>
          )}
          {elections.map((e) => (
            <div
              key={e.election_id}
              className={`election-card ${selectedElection?.election_id === e.election_id ? "selected" : ""}`}
              onClick={() => selectElection(e)}
            >
              <div className="election-card-header">
                <span className={`status-badge ${e.status === "open" ? "open" : "closed"}`}>
                  {e.status}
                </span>
                <span className="race-count-badge">{e.race_count} races</span>
              </div>
              <h3>{e.title ?? e.election_id}</h3>
              <span className="election-id">{e.election_id}</span>
            </div>
          ))}
        </div>

        <div className="detail-panel">
          {!selectedElection && (
            <div className="empty-detail">
              <p>Select an election to view races and cast your ballot.</p>
            </div>
          )}

          {selectedElection && (
            <>
              <div className="detail-header">
                <div className="detail-header-row">
                  <div>
                    <h2>{selectedElection.title ?? selectedElection.election_id}</h2>
                    <span className="election-meta">
                      {selectedElection.election_id} · {selectedElection.races.length} races
                    </span>
                  </div>
                  <div className="view-toggle">
                    <button
                      className={`btn btn-sm ${!showResults ? "btn-primary" : "btn-ghost"}`}
                      onClick={() => setShowResults(false)}
                    >
                      Ballot
                    </button>
                    <button
                      className={`btn btn-sm ${showResults ? "btn-primary" : "btn-ghost"}`}
                      onClick={() => {
                        setShowResults(true);
                        fetchTally(selectedElection.election_id);
                      }}
                    >
                      Live Results
                    </button>
                  </div>
                </div>
              </div>

              {showResults && tally && (
                <div className="results-section">
                  <p className="total-ballots">
                    {tally.total_ballots} ballot{tally.total_ballots !== 1 ? "s" : ""} cast
                  </p>
                  {tally.races.map((race) => {
                    const raceDef = selectedElection.races.find((r) => r.race_id === race.race_id);
                    const max = Math.max(...Object.values(race.tally), 1);
                    return (
                      <div key={race.race_id} className="race-tally">
                        <div className="race-tally-header">
                          <h3>{race.title}</h3>
                          <span className="race-meta">
                            {race.seat_type === "multi" ? `Top ${race.max_selections}` : "Single seat"}
                          </span>
                        </div>
                        <div className="tally-bars">
                          {raceDef?.candidates
                            .map((c) => ({
                              ...c,
                              count: race.tally[c.candidate_id] ?? 0,
                            }))
                            .sort((a, b) => b.count - a.count)
                            .map((c) => (
                              <div key={c.candidate_id} className="tally-row">
                                <span className="tally-label">{c.name}</span>
                                <span className="tally-party">{c.party}</span>
                                <div className="tally-bar-container">
                                  <div
                                    className="tally-bar"
                                    style={{ width: `${(c.count / max) * 100}%` }}
                                  />
                                  <span className="tally-count">{c.count}</span>
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {!showResults && (
                <>
                  {selectedElection.races.map((race) => {
                    const sel = selections[race.race_id] ?? [];
                    const isMulti = race.max_selections > 1;
                    return (
                      <div key={race.race_id} className="race-card">
                        <div className="race-header">
                          <h3>{race.title}</h3>
                          <span className="race-instructions">
                            {isMulti
                              ? `Select up to ${race.max_selections}`
                              : "Select one"}
                          </span>
                        </div>
                        <div className={`candidates-grid ${isMulti ? "multi" : "single"}`}>
                          {race.candidates.map((c) => {
                            const isSelected = sel.includes(c.candidate_id);
                            const atMax = !isSelected && sel.length >= race.max_selections;
                            return (
                              <button
                                key={c.candidate_id}
                                className={`candidate-card ${isSelected ? "selected" : ""} ${atMax ? "disabled" : ""}`}
                                onClick={() => toggleCandidate(race.race_id, c.candidate_id, race.max_selections)}
                                disabled={atMax}
                              >
                                <div className="candidate-indicator">
                                  {isSelected ? (
                                    <span className="check">&#10003;</span>
                                  ) : (
                                    <span className={`box ${isMulti ? "checkbox" : "radio"}`} />
                                  )}
                                </div>
                                <div className="candidate-info">
                                  <span className="candidate-name">{c.name}</span>
                                  <span className="candidate-party">{c.party}</span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  <div className="ballot-footer">
                    <div className="ballot-summary">
                      {racesWithSelections} of {selectedElection.races.length} races selected
                      {totalSelections > 0 && ` · ${totalSelections} total pick${totalSelections !== 1 ? "s" : ""}`}
                    </div>
                    <button
                      className="btn btn-primary btn-lg"
                      onClick={castBallot}
                      disabled={!walletConnected || submitting || totalSelections === 0}
                    >
                      {submitting
                        ? "Submitting..."
                        : walletConnected
                          ? `Cast Ballot${totalSelections > 0 ? ` (${totalSelections})` : ""}`
                          : "Connect Wallet to Vote"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
