import { useState, useEffect, useCallback } from "react";

const NODE_BASE = import.meta.env.VITE_NODE_URL ?? "";

interface Candidate {
  candidate_id: string;
  name: string;
  party: string;
}

interface Race {
  race_id: string;
  title: string;
  seat_type: "single" | "multi";
  max_selections: number;
  candidates: Candidate[];
}

interface ElectionSummary {
  election_id: string;
  title: string | null;
  opened_at: number;
  opened_by: string;
  status: string;
  race_count: number;
}

type View = "builder" | "elections";

export default function App() {
  const [view, setView] = useState<View>("builder");
  const [elections, setElections] = useState<ElectionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Builder state
  const [electionId, setElectionId] = useState("");
  const [electionTitle, setElectionTitle] = useState("");
  const [races, setRaces] = useState<Race[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const fetchElections = useCallback(async () => {
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/civic/elections`);
      if (!res.ok) throw new Error("Failed to fetch elections");
      const data = await res.json();
      setElections(data.elections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    fetchElections();
  }, [fetchElections]);

  // ── Race builder helpers ──────────────────────────────────

  const addRace = () => {
    setRaces((prev) => [
      ...prev,
      {
        race_id: "",
        title: "",
        seat_type: "single",
        max_selections: 1,
        candidates: [],
      },
    ]);
  };

  const removeRace = (idx: number) => {
    setRaces((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateRace = (idx: number, field: keyof Race, value: any) => {
    setRaces((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const updated = { ...r, [field]: value };
        if (field === "seat_type") {
          updated.max_selections = value === "single" ? 1 : prev[idx].max_selections || 12;
        }
        return updated;
      }),
    );
  };

  const addCandidate = (raceIdx: number) => {
    setRaces((prev) =>
      prev.map((r, i) => {
        if (i !== raceIdx) return r;
        return { ...r, candidates: [...r.candidates, { candidate_id: "", name: "", party: "" }] };
      }),
    );
  };

  const removeCandidate = (raceIdx: number, candIdx: number) => {
    setRaces((prev) =>
      prev.map((r, i) => {
        if (i !== raceIdx) return r;
        return { ...r, candidates: r.candidates.filter((_, j) => j !== candIdx) };
      }),
    );
  };

  const updateCandidate = (raceIdx: number, candIdx: number, field: keyof Candidate, value: string) => {
    setRaces((prev) =>
      prev.map((r, i) => {
        if (i !== raceIdx) return r;
        return {
          ...r,
          candidates: r.candidates.map((c, j) => (j === candIdx ? { ...c, [field]: value } : c)),
        };
      }),
    );
  };

  // ── Validation ────────────────────────────────────────────

  const validateElection = (): string | null => {
    if (!electionId.trim()) return "Election ID is required";
    if (!electionTitle.trim()) return "Election title is required";
    if (races.length === 0) return "At least one race is required";
    for (let i = 0; i < races.length; i++) {
      const r = races[i];
      if (!r.race_id.trim()) return `Race ${i + 1}: race_id is required`;
      if (!r.title.trim()) return `Race ${i + 1}: title is required`;
      if (r.candidates.length < 2) return `Race "${r.title}": needs at least 2 candidates`;
      for (let j = 0; j < r.candidates.length; j++) {
        const c = r.candidates[j];
        if (!c.candidate_id.trim()) return `Race "${r.title}", candidate ${j + 1}: ID is required`;
        if (!c.name.trim()) return `Race "${r.title}", candidate ${j + 1}: name is required`;
      }
    }
    const raceIds = races.map((r) => r.race_id);
    if (new Set(raceIds).size !== raceIds.length) return "Duplicate race_id values detected";
    return null;
  };

  // ── Submit election ───────────────────────────────────────

  const submitElection = async () => {
    const err = validateElection();
    if (err) {
      setError(err);
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);

    const payload = {
      title: electionTitle.trim(),
      races: races.map((r) => ({
        ...r,
        candidates: r.candidates.map((c) => ({
          candidate_id: c.candidate_id.trim(),
          name: c.name.trim(),
          party: c.party.trim(),
        })),
      })),
    };

    const entry = {
      entry_id: crypto.randomUUID(),
      namespace: "civic.election",
      action: "OPEN_ELECTION",
      object_id: electionId.trim(),
      payload,
      author: "governance:vote",
      signature: "placeholder",
      timestamp: Math.floor(Date.now() / 1000),
      privacy_flag: false,
      privacy_mode: "none",
    };

    try {
      const res = await fetch(`${NODE_BASE}/api/v1/entries/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Submission failed (${res.status}): ${body}`);
      }
      setSuccess(`Election "${electionId}" opened with ${races.length} race${races.length !== 1 ? "s" : ""}.`);
      setElectionId("");
      setElectionTitle("");
      setRaces([]);
      await fetchElections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Close election ────────────────────────────────────────

  const closeElection = async (id: string) => {
    setError(null);
    setSuccess(null);
    const entry = {
      entry_id: crypto.randomUUID(),
      namespace: "civic.election",
      action: "CLOSE_ELECTION",
      object_id: id,
      payload: {},
      author: "governance:vote",
      signature: "placeholder",
      timestamp: Math.floor(Date.now() / 1000),
      privacy_flag: false,
      privacy_mode: "none",
    };
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/entries/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setSuccess(`Election "${id}" closed.`);
      await fetchElections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  // ── Load template ─────────────────────────────────────────

  const loadNationalTemplate = () => {
    setElectionId("elec-2028-national");
    setElectionTitle("2028 National and Local Elections");
    setRaces([
      {
        race_id: "president",
        title: "President",
        seat_type: "single",
        max_selections: 1,
        candidates: [
          { candidate_id: "cand-001", name: "Alyssa Ong", party: "Partido ng Pagbabago" },
          { candidate_id: "cand-002", name: "Bong Revilla Jr.", party: "Lakas-CMD" },
          { candidate_id: "cand-003", name: "Leni Robredo", party: "Liberal Party" },
        ],
      },
      {
        race_id: "senator",
        title: "Senator (Top 12)",
        seat_type: "multi",
        max_selections: 12,
        candidates: [
          { candidate_id: "sen-001", name: "Mark Villar", party: "Nacionalista" },
          { candidate_id: "sen-002", name: "Risa Hontiveros", party: "Akbayan" },
          { candidate_id: "sen-003", name: "Kiko Pangilinan", party: "Liberal" },
        ],
      },
    ]);
  };

  const loadLocalTemplate = () => {
    setElectionId("elec-2028-qc-local");
    setElectionTitle("2028 Quezon City Local Elections");
    setRaces([
      {
        race_id: "mayor",
        title: "Mayor",
        seat_type: "single",
        max_selections: 1,
        candidates: [
          { candidate_id: "mayor-001", name: "Joy Belmonte", party: "SB" },
          { candidate_id: "mayor-002", name: "Mike Defensor", party: "PFP" },
        ],
      },
      {
        race_id: "councilor-d1",
        title: "Councilor, District 1",
        seat_type: "multi",
        max_selections: 6,
        candidates: [
          { candidate_id: "cou-001", name: "Anna Reyes", party: "SB" },
          { candidate_id: "cou-002", name: "Bob Cruz", party: "PFP" },
          { candidate_id: "cou-003", name: "Cara Lim", party: "Independent" },
        ],
      },
    ]);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Governance Administration</p>
          <h1>Election Admin Console</h1>
          <p className="lead">
            Configure elections with custom races and candidates. Define any
            position — president, senators, congressmen, mayors, councilors.
          </p>
        </div>
        <div className="view-toggle">
          <button
            className={`btn btn-sm ${view === "builder" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setView("builder")}
          >
            Builder
          </button>
          <button
            className={`btn btn-sm ${view === "elections" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => { setView("elections"); fetchElections(); }}
          >
            Active Elections ({elections.filter(e => e.status === "open").length})
          </button>
        </div>
      </header>

      {error && (
        <div className="banner banner-error">
          <strong>Error:</strong> {error}
          <button className="dismiss" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {success && (
        <div className="banner banner-success">
          {success}
          <button className="dismiss" onClick={() => setSuccess(null)}>Dismiss</button>
        </div>
      )}

      {view === "builder" && (
        <div className="builder">
          {/* Templates */}
          <div className="templates">
            <span className="template-label">Quick Start:</span>
            <button className="btn btn-ghost btn-sm" onClick={loadNationalTemplate}>
              National Election Template
            </button>
            <button className="btn btn-ghost btn-sm" onClick={loadLocalTemplate}>
              Local Election Template
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setElectionId(""); setElectionTitle(""); setRaces([]); }}>
              Clear
            </button>
          </div>

          {/* Election metadata */}
          <div className="card">
            <h3>Election Details</h3>
            <div className="form-row">
              <label className="field">
                <span className="field-label">Election ID</span>
                <input
                  type="text"
                  value={electionId}
                  onChange={(e) => setElectionId(e.target.value)}
                  placeholder="elec-2028-national"
                  className="input mono"
                />
              </label>
              <label className="field field-grow">
                <span className="field-label">Election Title</span>
                <input
                  type="text"
                  value={electionTitle}
                  onChange={(e) => setElectionTitle(e.target.value)}
                  placeholder="2028 National and Local Elections"
                  className="input"
                />
              </label>
            </div>
          </div>

          {/* Races */}
          {races.map((race, ri) => (
            <div key={ri} className="card race-builder">
              <div className="race-builder-header">
                <h4>Race {ri + 1}</h4>
                <button className="btn btn-danger btn-sm" onClick={() => removeRace(ri)}>
                  Remove Race
                </button>
              </div>
              <div className="form-row">
                <label className="field">
                  <span className="field-label">Race ID</span>
                  <input
                    type="text"
                    value={race.race_id}
                    onChange={(e) => updateRace(ri, "race_id", e.target.value)}
                    placeholder="president"
                    className="input mono"
                  />
                </label>
                <label className="field field-grow">
                  <span className="field-label">Race Title</span>
                  <input
                    type="text"
                    value={race.title}
                    onChange={(e) => updateRace(ri, "title", e.target.value)}
                    placeholder="President"
                    className="input"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Seat Type</span>
                  <select
                    value={race.seat_type}
                    onChange={(e) => updateRace(ri, "seat_type", e.target.value)}
                    className="input"
                  >
                    <option value="single">Single (radio)</option>
                    <option value="multi">Multi (checkbox)</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Max Selections</span>
                  <input
                    type="number"
                    min={1}
                    value={race.max_selections}
                    onChange={(e) => updateRace(ri, "max_selections", parseInt(e.target.value) || 1)}
                    className="input"
                    disabled={race.seat_type === "single"}
                  />
                </label>
              </div>

              {/* Candidates */}
              <div className="candidates-section">
                <div className="candidates-header">
                  <span className="field-label">Candidates ({race.candidates.length})</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => addCandidate(ri)}>
                    + Add Candidate
                  </button>
                </div>
                {race.candidates.map((cand, ci) => (
                  <div key={ci} className="candidate-builder-row">
                    <input
                      type="text"
                      value={cand.candidate_id}
                      onChange={(e) => updateCandidate(ri, ci, "candidate_id", e.target.value)}
                      placeholder="cand-001"
                      className="input mono cand-id"
                    />
                    <input
                      type="text"
                      value={cand.name}
                      onChange={(e) => updateCandidate(ri, ci, "name", e.target.value)}
                      placeholder="Candidate Name"
                      className="input cand-name"
                    />
                    <input
                      type="text"
                      value={cand.party}
                      onChange={(e) => updateCandidate(ri, ci, "party", e.target.value)}
                      placeholder="Party"
                      className="input cand-party"
                    />
                    <button className="btn btn-danger btn-sm" onClick={() => removeCandidate(ri, ci)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="builder-actions">
            <button className="btn btn-ghost" onClick={addRace}>
              + Add Race
            </button>
            <button
              className="btn btn-primary btn-lg"
              onClick={submitElection}
              disabled={submitting || !electionId.trim()}
            >
              {submitting ? "Submitting..." : `Open Election${races.length > 0 ? ` (${races.length} races, ${races.reduce((s, r) => s + r.candidates.length, 0)} candidates)` : ""}`}
            </button>
          </div>

          {/* JSON preview */}
          {races.length > 0 && electionId && (
            <details className="json-preview">
              <summary>Submission JSON Preview</summary>
              <pre>{JSON.stringify({
                namespace: "civic.election",
                action: "OPEN_ELECTION",
                object_id: electionId,
                payload: {
                  title: electionTitle,
                  races,
                },
              }, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      {view === "elections" && (
        <div className="elections-list">
          {elections.length === 0 && (
            <div className="empty-state">
              <p>No elections created yet.</p>
            </div>
          )}
          {elections.map((e) => (
            <div key={e.election_id} className="card election-row">
              <div className="election-row-info">
                <h3>{e.title ?? e.election_id}</h3>
                <div className="election-row-meta">
                  <span className="mono">{e.election_id}</span>
                  <span className={`status-badge ${e.status === "open" ? "open" : "closed"}`}>{e.status}</span>
                  <span className="badge-info">{e.race_count} races</span>
                </div>
              </div>
              <div className="election-row-actions">
                {e.status === "open" && (
                  <button className="btn btn-danger btn-sm" onClick={() => closeElection(e.election_id)}>
                    Close Election
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
