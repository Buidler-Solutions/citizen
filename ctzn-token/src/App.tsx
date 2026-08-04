import { useState, useEffect, useCallback } from "react";

const NODE_BASE = import.meta.env.VITE_NODE_URL ?? "";

interface TokenStatus {
  module_id: string;
  registered: boolean;
  active: boolean;
  total_holders: number;
  active_holders: number;
  revoked: number;
  burned: number;
}

interface Holder {
  token_id: string;
  owner: string;
  schema: string;
  tier: string;
  status: string;
}

interface CheckResult {
  did: string;
  module_id: string;
  has_citizenship: boolean;
  tokens: {
    token_id: string;
    owner: string | null;
    schema: string;
    tier: string;
    status: string;
  }[];
}

const TIER_LABELS: Record<string, string> = {
  "0": "Registered",
  "1": "Silver",
  "2": "Gold",
  "3": "Platinum",
};

export default function App() {
  const [moduleId, setModuleId] = useState("ctzn-token.v1");
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [holders, setHolders] = useState<Holder[]>([]);
  const [checkDid, setCheckDid] = useState("");
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "holders" | "check">("overview");

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/ctzn/${moduleId}/status`);
      if (!res.ok) {
        if (res.status === 404) {
          setStatus(null);
          setError(`Module "${moduleId}" not found on this node.`);
          return;
        }
        throw new Error(`Failed (${res.status})`);
      }
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [moduleId]);

  const fetchHolders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/ctzn/${moduleId}/holders`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      setHolders(data.holders ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [moduleId]);

  const checkCitizen = useCallback(async () => {
    if (!checkDid.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/ctzn/${moduleId}/check/${encodeURIComponent(checkDid.trim())}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      setCheckResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [moduleId, checkDid]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Digital Citizenship</p>
          <h1>CTZN Soulbound Token</h1>
          <p className="lead">
            Manage and inspect soulbound citizenship tokens. Non-transferable
            identity credentials tied to Citizen Protocol DIDs.
          </p>
        </div>
      </header>

      {error && (
        <div className="banner banner-error">
          <strong>Error:</strong> {error}
          <button className="dismiss" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="module-bar">
        <label className="module-label">
          Module ID
          <input
            type="text"
            value={moduleId}
            onChange={(e) => setModuleId(e.target.value)}
            placeholder="ctzn-token.v1"
            className="module-input"
          />
        </label>
        <button className="btn btn-primary" onClick={fetchStatus} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <div className="tabs">
        <button
          className={`tab ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => setActiveTab("overview")}
        >
          Overview
        </button>
        <button
          className={`tab ${activeTab === "holders" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("holders");
            fetchHolders();
          }}
        >
          Holders
        </button>
        <button
          className={`tab ${activeTab === "check" ? "active" : ""}`}
          onClick={() => setActiveTab("check")}
        >
          Check Citizenship
        </button>
      </div>

      {activeTab === "overview" && (
        <div className="tab-content">
          {status ? (
            <div className="stats-grid">
              <div className="stat-card">
                <span className="stat-value">{status.total_holders}</span>
                <span className="stat-label">Total Minted</span>
              </div>
              <div className="stat-card stat-active">
                <span className="stat-value">{status.active_holders}</span>
                <span className="stat-label">Active Citizens</span>
              </div>
              <div className="stat-card stat-revoked">
                <span className="stat-value">{status.revoked}</span>
                <span className="stat-label">Revoked</span>
              </div>
              <div className="stat-card stat-burned">
                <span className="stat-value">{status.burned}</span>
                <span className="stat-label">Burned</span>
              </div>
            </div>
          ) : (
            !loading && (
              <div className="empty-state">
                <p>No token module found with ID "{moduleId}".</p>
                <p className="hint">
                  Register a CTZN token module first, or check the module ID.
                </p>
              </div>
            )
          )}

          {status && (
            <div className="info-table">
              <div className="info-row">
                <span className="info-key">Module ID</span>
                <span className="info-val mono">{status.module_id}</span>
              </div>
              <div className="info-row">
                <span className="info-key">Registered</span>
                <span className={`info-val badge ${status.registered ? "badge-ok" : "badge-no"}`}>
                  {status.registered ? "Yes" : "No"}
                </span>
              </div>
              <div className="info-row">
                <span className="info-key">Activated</span>
                <span className={`info-val badge ${status.active ? "badge-ok" : "badge-no"}`}>
                  {status.active ? "Yes" : "No"}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === "holders" && (
        <div className="tab-content">
          {holders.length === 0 && !loading ? (
            <div className="empty-state">
              <p>No token holders found.</p>
            </div>
          ) : (
            <div className="holders-table">
              <div className="holders-header">
                <span>Token ID</span>
                <span>Owner</span>
                <span>Tier</span>
                <span>Schema</span>
                <span>Status</span>
              </div>
              {holders.map((h) => (
                <div key={h.token_id} className="holders-row">
                  <span className="mono">{h.token_id.slice(0, 16)}...</span>
                  <span className="mono">{h.owner.slice(0, 20)}...</span>
                  <span className={`tier-badge tier-${h.tier}`}>
                    {TIER_LABELS[h.tier] ?? `T${h.tier}`}
                  </span>
                  <span>{h.schema || "—"}</span>
                  <span className={`status-pill status-${h.status}`}>{h.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "check" && (
        <div className="tab-content">
          <div className="check-section">
            <div className="check-input-row">
              <input
                type="text"
                value={checkDid}
                onChange={(e) => setCheckDid(e.target.value)}
                placeholder="did:key:ed25519:... or did:citizen:alice"
                className="did-input"
                onKeyDown={(e) => e.key === "Enter" && checkCitizen()}
              />
              <button
                className="btn btn-primary"
                onClick={checkCitizen}
                disabled={loading || !checkDid.trim()}
              >
                Check
              </button>
            </div>

            {checkResult && (
              <div className={`check-result ${checkResult.has_citizenship ? "eligible" : "ineligible"}`}>
                <div className="check-status">
                  {checkResult.has_citizenship ? (
                    <><span className="check-icon">&#10003;</span> Active citizen — eligible to vote</>
                  ) : (
                    <><span className="check-icon">&#10007;</span> No active citizenship token</>
                  )}
                </div>
                {checkResult.tokens.length > 0 && (
                  <div className="check-tokens">
                    {checkResult.tokens.map((t) => (
                      <div key={t.token_id} className="check-token">
                        <span className="mono">{t.token_id.slice(0, 20)}</span>
                        <span className={`tier-badge tier-${t.tier}`}>
                          {TIER_LABELS[t.tier] ?? `T${t.tier}`}
                        </span>
                        <span className={`status-pill status-${t.status}`}>{t.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
