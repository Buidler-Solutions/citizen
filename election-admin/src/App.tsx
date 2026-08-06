import React, { useState, useEffect, useCallback } from "react";
import { generateElectionKeyPair, importElectionPrivateKey, decryptBallot } from "./ballotCrypto";
import { generateKycKeyPair, kycReaderDid, decryptKycHybrid, type KycWrappedSecret } from "./kycCrypto";

const NODE_BASE = import.meta.env.VITE_NODE_URL ?? "";

const ELECTION_KEY_PREFIX = "citizen.election.tallykey.";
const KYC_KEY_STORAGE = "citizen.kyc.encryptionkey";
const EXPLORER_BASE = "http://localhost:8885";

function explorerDataHashHref(hash: string): string {
  const normalized = hash.startsWith("sha256:") ? hash : `sha256:${hash}`;
  return `${EXPLORER_BASE}/data-hash?q=${encodeURIComponent(normalized)}`;
}

interface AdminStatus {
  is_admin: boolean;
  role: string | null;
  scope: string | null;
}

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

type View = "builder" | "elections" | "voters" | "kyc" | "tally" | "admins";
type AuthState = "disconnected" | "connecting" | "checking" | "authorized" | "denied";

export default function App() {
  const [authState, setAuthState] = useState<AuthState>("disconnected");
  const [walletDid, setWalletDid] = useState<string>("");
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<View>("builder");
  const [elections, setElections] = useState<ElectionSummary[]>([]);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;
  const [success, setSuccess] = useState<React.ReactNode | null>(null);

  // Voter registration state
  const [voterDid, setVoterDid] = useState("");
  const [voterJurisdiction, setVoterJurisdiction] = useState("");
  const [registering, setRegistering] = useState(false);

  // KYC state
  const [kycSubmissions, setKycSubmissions] = useState<any[]>([]);
  const [kycJurisdictionInput, setKycJurisdictionInput] = useState("");
  const [approvingDid, setApprovingDid] = useState<string | null>(null);
  const [decryptedKyc, setDecryptedKyc] = useState<Record<string, { full_name: string; address: string }>>({});
  const [decryptingDid, setDecryptingDid] = useState<string | null>(null);

  // Tally state
  const [tallyElectionId, setTallyElectionId] = useState("");
  const [tallyResult, setTallyResult] = useState<any>(null);
  const [tallying, setTallying] = useState(false);

  // Builder state
  const [electionId, setElectionId] = useState("");
  const [electionTitle, setElectionTitle] = useState("");
  const [races, setRaces] = useState<Race[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Admin management state (smart contract powered)
  const [adminList, setAdminList] = useState<any[]>([]);
  const [newAdminDid, setNewAdminDid] = useState("");
  const [newAdminRole, setNewAdminRole] = useState("election-commissioner");
  const [newAdminScope, setNewAdminScope] = useState("national");
  const [adminActionPending, setAdminActionPending] = useState(false);

  const isAdmin = authState === "authorized" && adminStatus?.is_admin === true;

  // ── Wallet connection + admin verification ───────────────────

  const connectWallet = useCallback(async () => {
    setAuthState("connecting");
    setError(null);
    const provider = (window as any).ctzn ?? (window as any).citizen;
    if (!provider) {
      setError("Citizen wallet extension not found. Install the Citizen wallet and try again.");
      setAuthState("disconnected");
      return;
    }
    try {
      const signer = await Promise.race([
        provider.request({ method: "ctzn_getCitizenSigner" }),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]);
      if (!signer) {
        setError("Wallet returned no signer identity.");
        setAuthState("disconnected");
        return;
      }
      const did = signer.did ?? signer.signer ?? signer.address;
      if (!did) {
        setError("Wallet returned no DID.");
        setAuthState("disconnected");
        return;
      }
      setWalletDid(did);
      setAuthState("checking");

      const res = await fetch(`${NODE_BASE}/api/v1/civic/admin/check/${encodeURIComponent(did)}`);
      if (!res.ok) {
        setError(`Admin verification failed (${res.status}).`);
        setAuthState("denied");
        return;
      }
      const status: AdminStatus = await res.json();
      setAdminStatus(status);
      if (status.is_admin) {
        setAuthState("authorized");
        await fetchElections();
        await ensureKycEncryptionKey(did);
      } else {
        setAuthState("denied");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect wallet.");
      setAuthState("disconnected");
    }
  }, []);

  // ── Fetch elections ──────────────────────────────────────────

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
    if (isAdmin) fetchElections();
  }, [isAdmin, fetchElections]);

  // ── Race builder helpers ─────────────────────────────────────

  const addRace = () => {
    setRaces((prev) => [
      ...prev,
      { race_id: "", title: "", seat_type: "single", max_selections: 1, candidates: [] },
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

  // ── Validation ───────────────────────────────────────────────

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

  // ── Sign entry with wallet private key ───────────────────────

  const signEntry = async (entryData: Record<string, any>, authorOverride?: string): Promise<string> => {
    const provider = (window as any).ctzn ?? (window as any).citizen;
    if (!provider) throw new Error("Wallet not connected");
    const signingPayload = {
      entry_id: entryData.entry_id,
      namespace: entryData.namespace,
      action: entryData.action,
      object_id: entryData.object_id,
      payload: entryData.payload,
      author: authorOverride ?? walletDid,
      timestamp: entryData.timestamp,
    };
    const result = await provider.request({
      method: "ctzn_signCitizenTx",
      params: [signingPayload],
    });
    return result?.signature ?? result ?? "unsigned";
  };

  // ── Submit entry helper ─────────────────────────────────────
  const submitEntry = async (entryData: Record<string, any>): Promise<void> => {
    const signature = await signEntry(entryData);
    const res = await fetch(`${NODE_BASE}/api/v1/entries/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...entryData, signature }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Submission failed (${res.status}): ${body}`);
    }
  };

  // ── Smart contract admin management ──────────────────────────

  const signAuthMessage = async (message: string): Promise<string> => {
    const provider = (window as any).ctzn ?? (window as any).citizen;
    if (!provider) throw new Error("Wallet not connected");
    const result = await provider.request({
      method: "ctzn_signAuthChallenge",
      params: [message],
    });
    const sigB64url = result?.signature ?? result?.result?.signature;
    if (!sigB64url) throw new Error("Wallet did not return a signature");
    const b64 = sigB64url.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  const executeAdminContract = async (params: Record<string, any>): Promise<any> => {
    const res = await fetch(`${NODE_BASE}/api/v1/modules/admin-registry/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Contract execution failed (${res.status}): ${body}`);
    }
    return res.json();
  };

  const fetchAdmins = useCallback(async () => {
    try {
      const data = await executeAdminContract({ operation: "list_admins" });
      const result = data?.result ?? data;
      setAdminList(result?.admins ?? []);
    } catch {
      setAdminList([]);
    }
  }, []);

  const assignAdmin = async () => {
    if (!newAdminDid.trim()) {
      setError("Enter a DID to assign");
      return;
    }
    setAdminActionPending(true);
    setError(null);
    setSuccess(null);
    try {
      const message = `assign_admin:${newAdminDid}:${newAdminRole}:${newAdminScope}`;
      const sigHex = await signAuthMessage(message);
      const data = await executeAdminContract({
        operation: "assign_admin",
        admin_did: walletDid,
        admin_sig: sigHex,
        target_did: newAdminDid,
        role: newAdminRole,
        scope: newAdminScope,
      });
      const result = data?.result ?? data;
      if (result?.ok) {
        setSuccess(`Admin assigned: ${newAdminDid}`);
        setNewAdminDid("");
        await fetchAdmins();
      } else {
        setError(result?.error || "Failed to assign admin");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign admin");
    } finally {
      setAdminActionPending(false);
    }
  };

  const revokeAdmin = async (targetDid: string) => {
    setAdminActionPending(true);
    setError(null);
    setSuccess(null);
    try {
      const message = `revoke_admin:${targetDid}`;
      const sigHex = await signAuthMessage(message);
      const data = await executeAdminContract({
        operation: "revoke_admin",
        admin_did: walletDid,
        admin_sig: sigHex,
        target_did: targetDid,
      });
      const result = data?.result ?? data;
      if (result?.ok) {
        setSuccess(`Admin revoked: ${targetDid}`);
        await fetchAdmins();
      } else {
        setError(result?.error || "Failed to revoke admin");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke admin");
    } finally {
      setAdminActionPending(false);
    }
  };

  const buildEncryptedEntry = (
    action: string,
    objectId: string,
    payload: Record<string, any>,
  ) => ({
    entry_id: crypto.randomUUID(),
    namespace: "civic.election",
    action,
    object_id: objectId,
    payload,
    author: walletDid,
    timestamp: Math.floor(Date.now() / 1000),
    privacy_flag: true,
    privacy_mode: "passphrase",
    payload_commitment: crypto.randomUUID(),
  });

  // ── Submit election ──────────────────────────────────────────
  // Opens the election shell, then submits each race and candidate
  // as individual encrypted on-chain transactions.

  const submitElection = async () => {
    const err = validateElection();
    if (err) { setError(err); return; }
    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      // 0. Generate election tally keypair for ballot encryption
      const keyPair = await generateElectionKeyPair();
      localStorage.setItem(
        ELECTION_KEY_PREFIX + electionId.trim(),
        JSON.stringify({ privateKeyJwk: keyPair.privateKeyJwk }),
      );

      // 1. OPEN_ELECTION with empty races + tally public key
      const openEntry = buildEncryptedEntry(
        "OPEN_ELECTION",
        electionId.trim(),
        {
          title: electionTitle.trim(),
          races: [],
          tally_public_key: keyPair.publicKeyBase64,
        },
      );
      await submitEntry(openEntry);

      // 2. Submit each race as ADD_RACE
      for (const race of races) {
        const racePayload = {
          election_id: electionId.trim(),
          race: {
            race_id: race.race_id.trim(),
            title: race.title.trim(),
            seat_type: race.seat_type,
            max_selections: race.max_selections,
            candidates: [],
          },
        };
        const raceEntry = buildEncryptedEntry(
          "ADD_RACE",
          electionId.trim(),
          racePayload,
        );
        await submitEntry(raceEntry);

        // 3. Submit each candidate as ADD_CANDIDATE
        for (const cand of race.candidates) {
          const candPayload = {
            election_id: electionId.trim(),
            race_id: race.race_id.trim(),
            candidate: {
              candidate_id: cand.candidate_id.trim(),
              name: cand.name.trim(),
              party: cand.party.trim(),
            },
          };
          const candEntry = buildEncryptedEntry(
            "ADD_CANDIDATE",
            electionId.trim(),
            candPayload,
          );
          await submitEntry(candEntry);
        }
      }

      const totalCandidates = races.reduce((s, r) => s + r.candidates.length, 0);
      setSuccess(
        `Election "${electionId}" opened. ${races.length} race${races.length !== 1 ? "s" : ""} and ${totalCandidates} candidate${totalCandidates !== 1 ? "s" : ""} recorded on-chain.`,
      );
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

  // ── Close election ───────────────────────────────────────────

  const closeElection = async (id: string) => {
    setError(null);
    setSuccess(null);
    const entry = buildEncryptedEntry("CLOSE_ELECTION", id, {});
    try {
      await submitEntry(entry);
      setSuccess(`Election "${id}" closed.`);
      await fetchElections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  // ── Register voter ──────────────────────────────────────────

  const registerVoter = async () => {
    if (!voterDid.trim() || !voterJurisdiction.trim()) return;
    setRegistering(true);
    setError(null);
    setSuccess(null);

    const jurisdictionPath = voterJurisdiction.split("/").map((s) => s.trim()).filter(Boolean);
    if (jurisdictionPath.length === 0) {
      setError("Jurisdiction path cannot be empty");
      setRegistering(false);
      return;
    }

    const entry = {
      entry_id: crypto.randomUUID(),
      namespace: "civic.registry",
      action: "REGISTER_VOTER",
      object_id: voterDid.trim(),
      payload: {
        voter_did: voterDid.trim(),
        jurisdiction_path: jurisdictionPath,
        verified_by: walletDid,
        registered_at: new Date().toISOString(),
      },
      author: walletDid,
      timestamp: Math.floor(Date.now() / 1000),
      privacy_flag: true,
      privacy_mode: "passphrase",
      payload_commitment: crypto.randomUUID(),
    };

    try {
      const signature = await signEntry(entry);
      await fetch(`${NODE_BASE}/api/v1/entries/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...entry, signature }),
      }).then(async (res) => {
        if (!res.ok) throw new Error(`Registration failed (${res.status}): ${await res.text()}`);
      });
      setSuccess(`Voter ${voterDid} registered at ${jurisdictionPath.join(" / ")}.`);
      setVoterDid("");
      setVoterJurisdiction("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRegistering(false);
    }
  };

  // ── KYC encryption key management ─────────────────────────────

  const ensureKycEncryptionKey = useCallback(async (did: string) => {
    try {
      const stored = localStorage.getItem(KYC_KEY_STORAGE);
      let keyPair: { publicKeyHex: string; privateKeyHex: string };
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.publicKeyHex && parsed.privateKeyHex) {
          keyPair = parsed;
        } else {
          localStorage.removeItem(KYC_KEY_STORAGE);
          keyPair = await generateKycKeyPair();
          localStorage.setItem(KYC_KEY_STORAGE, JSON.stringify(keyPair));
        }
      } else {
        keyPair = await generateKycKeyPair();
        localStorage.setItem(KYC_KEY_STORAGE, JSON.stringify(keyPair));
      }
      const entry = {
        entry_id: crypto.randomUUID(),
        namespace: "civic.admin",
        action: "SET_KYC_PUBLIC_KEY",
        object_id: "kyc-encryption-key",
        payload: { kyc_encryption_public_key: keyPair.publicKeyHex, key_algorithm: "x25519" },
        author: did,
        timestamp: Math.floor(Date.now() / 1000),
      };
      const signature = await signEntry(entry, did);
      const resp = await fetch(`${NODE_BASE}/api/v1/entries/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...entry, signature }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        setError(`Failed to publish KYC encryption key (${resp.status}): ${body}`);
      }
    } catch (err) {
      setError(`KYC encryption key setup failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }, []);

  const decryptKycEntry = useCallback(async (encryptedData: {
    ciphertext_hex?: string; nonce_hex?: string;
    hybrid_author_x25519_public_key?: string;
    key_wrapped_secrets?: KycWrappedSecret[];
  } | null): Promise<{ full_name: string; address: string } | null> => {
    if (!encryptedData?.ciphertext_hex || !encryptedData?.nonce_hex
        || !encryptedData?.hybrid_author_x25519_public_key
        || !encryptedData?.key_wrapped_secrets) {
      console.error('[decryptKycEntry] missing fields:', {
        has_ct: !!encryptedData?.ciphertext_hex,
        has_nonce: !!encryptedData?.nonce_hex,
        has_author_key: !!encryptedData?.hybrid_author_x25519_public_key,
        has_wrapped: !!encryptedData?.key_wrapped_secrets,
      });
      return null;
    }
    const stored = localStorage.getItem(KYC_KEY_STORAGE);
    if (!stored) {
      console.error('[decryptKycEntry] no key in localStorage');
      return null;
    }
    try {
      const keyData = JSON.parse(stored);
      if (!keyData.privateKeyHex || !keyData.publicKeyHex) {
        console.error('[decryptKycEntry] old key format in localStorage, missing publicKeyHex/privateKeyHex');
        return null;
      }
      const adminReaderDid = kycReaderDid(keyData.publicKeyHex);
      const matching = encryptedData.key_wrapped_secrets.find((s) => s.reader_id === adminReaderDid);
      if (!matching) {
        console.error('[decryptKycEntry] no wrapped secret for admin reader DID:', adminReaderDid,
          'available readers:', encryptedData.key_wrapped_secrets.map((s) => s.reader_id));
      }
      return await decryptKycHybrid(
        encryptedData.ciphertext_hex,
        encryptedData.nonce_hex,
        encryptedData.hybrid_author_x25519_public_key,
        encryptedData.key_wrapped_secrets,
        adminReaderDid,
        keyData.privateKeyHex,
      );
    } catch {
      return null;
    }
  }, []);

  // ── KYC management ──────────────────────────────────────────

  const fetchKycSubmissions = useCallback(async () => {
    try {
      const res = await fetch(`${NODE_BASE}/api/v1/identity/kyc`);
      if (!res.ok) throw new Error("Failed to fetch KYC");
      const data = await res.json();
      const submissions = data.submissions ?? [];
      const carryOver: Record<string, { full_name: string; address: string }> = {};
      for (const s of submissions) {
        if (decryptedKyc[s.did]) {
          carryOver[s.did] = decryptedKyc[s.did];
        }
      }
      setDecryptedKyc(carryOver);
      setKycSubmissions(submissions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [decryptedKyc]);

  const handleDecryptKyc = useCallback(async (did: string, encryptedData: {
    ciphertext_hex?: string; nonce_hex?: string;
    hybrid_author_x25519_public_key?: string;
    key_wrapped_secrets?: KycWrappedSecret[];
  } | null) => {
    if (!encryptedData?.ciphertext_hex || !encryptedData?.nonce_hex
        || !encryptedData?.hybrid_author_x25519_public_key
        || !encryptedData?.key_wrapped_secrets) {
      setError("No encrypted payload available for this submission.");
      return;
    }
    setDecryptingDid(did);
    setError(null);
    try {
      const result = await decryptKycEntry(encryptedData);
      if (result) {
        setDecryptedKyc((prev) => ({ ...prev, [did]: result }));
      } else {
        setError(`Failed to decrypt KYC for ${did.slice(0, 30)}… — check that the admin encryption key matches.`);
      }
    } catch {
      setError(`Decryption error for ${did.slice(0, 30)}…`);
    } finally {
      setDecryptingDid(null);
    }
  }, [decryptKycEntry]);

  const approveKyc = async (did: string, jurisdictionPath: string) => {
    setError(null);
    setSuccess(null);
    setApprovingDid(did);
    const entryId = crypto.randomUUID();
    const payload: Record<string, unknown> = {
      jurisdiction_path: jurisdictionPath.split("/").map((s) => s.trim()).filter(Boolean),
    };
    const entry = {
      entry_id: entryId,
      namespace: "identity.kyc",
      action: "APPROVE_KYC",
      object_id: did,
      payload,
      author: walletDid,
      timestamp: Math.floor(Date.now() / 1000),
    };
    try {
      const signature = await signEntry(entry);
      const resp = await fetch(`${NODE_BASE}/api/v1/entries/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...entry, signature }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(`Approval failed (${resp.status}): ${JSON.stringify(body)}`);

      const blockHeight = body?.receipt?.finality?.block_height;
      const blockHash = body?.receipt?.finality?.block_hash;
      const receiptId = body?.receipt?.receipt_id;
      const explorerHref = blockHash ? explorerDataHashHref(blockHash) : null;
      setSuccess(
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>✅ KYC approved for {did}</div>
          <div style={{ fontSize: "0.8rem", lineHeight: 1.6 }}>
            {receiptId && <div>Receipt: <code>{receiptId}</code></div>}
            <div>Entry ID: <code>{entryId}</code></div>
            {blockHeight != null && <div>Block #{blockHeight}</div>}
            {blockHash && <div>Tx Hash: <code>{blockHash}</code></div>}
            {explorerHref && (
              <div>
                <a href={explorerHref} target="_blank" rel="noreferrer" style={{ color: "inherit", fontWeight: 600 }}>
                  View on Explorer →
                </a>
              </div>
            )}
          </div>
        </div>
      );
      setKycJurisdictionInput("");
      await fetchKycSubmissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setApprovingDid(null);
    }
  };

  const revokeKyc = async (did: string) => {
    setError(null);
    setSuccess(null);
    const entry = {
      entry_id: crypto.randomUUID(),
      namespace: "identity.kyc",
      action: "REVOKE_KYC",
      object_id: did,
      payload: {},
      author: walletDid,
      timestamp: Math.floor(Date.now() / 1000),
    };
    try {
      const signature = await signEntry(entry);
      await fetch(`${NODE_BASE}/api/v1/entries/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...entry, signature }),
      }).then(async (res) => {
        if (!res.ok) throw new Error(`Revocation failed (${res.status}): ${await res.text()}`);
      });
      setSuccess(`KYC revoked for ${did}.`);
      await fetchKycSubmissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  // ── Encrypted tally decryption ──────────────────────────────

  const decryptTally = async () => {
    if (!tallyElectionId.trim()) return;
    setTallying(true);
    setError(null);
    setTallyResult(null);

    try {
      const res = await fetch(`${NODE_BASE}/api/v1/civic/elections/${encodeURIComponent(tallyElectionId.trim())}/ballots`);
      if (!res.ok) throw new Error(`Failed to fetch ballots (${res.status})`);
      const data = await res.json();
      const ballots = data.ballots ?? [];

      const keyStorage = localStorage.getItem(ELECTION_KEY_PREFIX + tallyElectionId.trim());
      if (!keyStorage) {
        throw new Error("No tally private key found for this election. You may not be the election admin who created it.");
      }
      const { privateKeyJwk } = JSON.parse(keyStorage);
      const privateKey = await importElectionPrivateKey(privateKeyJwk);

      const tallyByRace: Record<string, Record<string, number>> = {};
      let decryptedCount = 0;
      let failedCount = 0;

      for (const ballot of ballots) {
        const p = ballot.payload;
        if (p.enc_ballot && p.epk && p.nonce) {
          try {
            const selections = await decryptBallot(
              {
                ciphertextBase64: p.enc_ballot,
                ephemeralPublicKeyBase64: p.epk,
                nonceBase64: p.nonce,
              },
              privateKey,
            ) as Array<{ race_id: string; candidate_ids: string[] }>;

            for (const sel of selections) {
              if (!tallyByRace[sel.race_id]) tallyByRace[sel.race_id] = {};
              for (const cid of sel.candidate_ids) {
                tallyByRace[sel.race_id][cid] = (tallyByRace[sel.race_id][cid] ?? 0) + 1;
              }
            }
            decryptedCount++;
          } catch {
            failedCount++;
          }
        } else if (p.selections) {
          for (const sel of p.selections) {
            if (!tallyByRace[sel.race_id]) tallyByRace[sel.race_id] = {};
            for (const cid of sel.candidate_ids) {
              tallyByRace[sel.race_id][cid] = (tallyByRace[sel.race_id][cid] ?? 0) + 1;
            }
          }
          decryptedCount++;
        }
      }

      setTallyResult({
        election_id: tallyElectionId.trim(),
        total_ballots: ballots.length,
        decrypted: decryptedCount,
        failed: failedCount,
        tally: tallyByRace,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tally failed");
    } finally {
      setTallying(false);
    }
  };

  // ── Templates ────────────────────────────────────────────────

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

  // ══════════════════════════════════════════════════════════════
  // GATE: Not authorized — wallet not connected or not admin
  // ══════════════════════════════════════════════════════════════

  if (authState === "disconnected" || authState === "connecting" || authState === "checking") {
    return (
      <div className="app">
        <div className="auth-gate">
          <div className="auth-card">
            <p className="eyebrow">Governance Administration</p>
            <h1>Election Admin Console</h1>
            <p className="lead">
              This console is restricted to authorized election administrators.
              Connect your Citizen wallet to verify your credentials.
            </p>
            {error && <div className="banner banner-error">{error}</div>}
            <button
              className="btn btn-primary btn-lg"
              onClick={connectWallet}
              disabled={authState !== "disconnected"}
            >
              {authState === "connecting"
                ? "Connecting to wallet..."
                : authState === "checking"
                  ? "Verifying admin credentials..."
                  : "Connect Citizen Wallet"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (authState === "denied") {
    return (
      <div className="app">
        <div className="auth-gate">
          <div className="auth-card auth-denied-card">
            <p className="eyebrow">Access Denied</p>
            <h1>Not Authorized</h1>
            <p className="lead">
              The connected wallet <span className="mono">{walletDid}</span> is not
              registered as an election admin.
            </p>
            <p className="muted">
              Only wallets assigned through the civic.admin namespace can access
              this console. Contact your governance administrator if you believe
              this is an error.
            </p>
            {error && <div className="banner banner-error">{error}</div>}
            <button className="btn btn-ghost" onClick={() => { setAuthState("disconnected"); setError(null); }}>
              Try Different Wallet
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // AUTHORIZED: Full admin console
  // ══════════════════════════════════════════════════════════════

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Governance Administration</p>
          <h1>Election Admin Console</h1>
          <p className="lead">
            Configure elections with custom races and candidates.
          </p>
        </div>
        <div className="header-right">
          <div className="admin-info">
            <span className="status-badge open">ADMIN</span>
            <span className="admin-role">{adminStatus?.role}</span>
            <span className="admin-did mono">{walletDid}</span>
          </div>
          <div className="view-toggle">
            <button
              className={`btn btn-sm ${view === "builder" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => { setView("builder"); setPage(1); }}
            >
              Builder
            </button>
            <button
              className={`btn btn-sm ${view === "elections" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => { setView("elections"); fetchElections(); setPage(1); }}
            >
              Active Elections ({elections.filter(e => e.status === "open").length})
            </button>
            <button
              className={`btn btn-sm ${view === "voters" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => { setView("voters"); setPage(1); }}
            >
              Voters
            </button>
            <button
              className={`btn btn-sm ${view === "kyc" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => { setView("kyc"); fetchKycSubmissions(); setPage(1); }}
            >
              KYC ({kycSubmissions.filter(k => k.status === "submitted").length})
            </button>
            <button
              className={`btn btn-sm ${view === "tally" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => { setView("tally"); setPage(1); }}
            >
              Tally
            </button>
            <button
              className={`btn btn-sm ${view === "admins" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => { setView("admins"); fetchAdmins(); }}
            >
              Admins
            </button>
          </div>
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
                      X
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

          {races.length > 0 && electionId && (
            <details className="json-preview">
              <summary>Submission JSON Preview</summary>
              <pre>{JSON.stringify({
                namespace: "civic.election",
                action: "OPEN_ELECTION",
                object_id: electionId,
                payload: { title: electionTitle, races },
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
          {elections.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((e) => (
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
          {elections.length > PAGE_SIZE && (
            <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16 }}>
              <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>« Prev</button>
              <span className="meta-text">Page {page} of {Math.ceil(elections.length / PAGE_SIZE)}</span>
              <button className="btn btn-ghost btn-sm" disabled={page >= Math.ceil(elections.length / PAGE_SIZE)} onClick={() => setPage(page + 1)}>Next »</button>
            </div>
          )}
        </div>
      )}
      {view === "voters" && (
        <div className="builder">
          <div className="card">
            <h3>Register Voter</h3>
            <p className="muted" style={{ marginBottom: 16 }}>
              Register a voter with their DID and jurisdiction path.
              The voter must hold a CTZN citizenship token and be registered here
              before they can cast a ballot. Jurisdiction path is slash-separated,
              e.g. <code className="mono">PH/NCR/Quezon City/District 1</code>
            </p>
            <div className="form-row">
              <label className="field">
                <span className="field-label">Voter DID</span>
                <input
                  type="text"
                  value={voterDid}
                  onChange={(e) => setVoterDid(e.target.value)}
                  placeholder="did:key:ed25519:..."
                  className="input mono"
                />
              </label>
            </div>
            <div className="form-row">
              <label className="field field-grow">
                <span className="field-label">Jurisdiction Path (slash-separated)</span>
                <input
                  type="text"
                  value={voterJurisdiction}
                  onChange={(e) => setVoterJurisdiction(e.target.value)}
                  placeholder="PH/NCR/Quezon City/District 1"
                  className="input"
                />
              </label>
            </div>
            <div className="builder-actions">
              <button
                className="btn btn-primary btn-lg"
                onClick={registerVoter}
                disabled={registering || !voterDid.trim() || !voterJurisdiction.trim()}
              >
                {registering ? "Registering..." : "Register Voter"}
              </button>
            </div>
          </div>

          <div className="card">
            <h4>Quick-fill locations</h4>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {[
                { label: "PH / NCR / Quezon City / D1", value: "PH/NCR/Quezon City/District 1" },
                { label: "PH / NCR / Manila / D2", value: "PH/NCR/Manila/District 2" },
                { label: "PH / NCR / Makati", value: "PH/NCR/Makati" },
                { label: "PH / IV-A / Cavite", value: "PH/Region IV-A/Cavite" },
              ].map((loc) => (
                <button
                  key={loc.value}
                  className="btn btn-ghost btn-sm"
                  onClick={() => setVoterJurisdiction(loc.value)}
                >
                  {loc.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {view === "kyc" && (
        <div className="elections-list">
          {kycSubmissions.length === 0 && (
            <div className="empty-state"><p>No KYC submissions yet.</p></div>
          )}
          {(() => {
            const filtered = kycSubmissions
              .filter((k) => k.status === "submitted" || k.status === "approved")
              .sort((a, b) => (a.status === "submitted" ? -1 : 1) - (b.status === "submitted" ? -1 : 1));
            if (filtered.length === 0 && kycSubmissions.length > 0) {
              return <div className="empty-state"><p>No pending or approved KYC submissions.</p></div>;
            }
            const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
            return (
              <>
                {paged.map((k) => (
            <div key={k.did} className="card election-row">
              <div className="election-row-info">
                <h3>{(() => {
                  const dc = decryptedKyc[k.did];
                  if (dc) return dc.full_name;
                  if (k.encrypted?.ciphertext_hex) return "🔒 Encrypted";
                  return k.full_name ?? "Unknown";
                })()}</h3>
                <div className="election-row-meta">
                  <span className="mono" title={k.did}>{k.did.slice(0, 40)}...</span>
                  <span className={`status-badge ${k.status === "approved" ? "open" : k.status === "submitted" ? "open" : "closed"}`} style={k.status === "submitted" ? {background: "var(--accent-weak)", color: "var(--accent)"} : {}}>
                    {k.status}
                  </span>
                  {k.encrypted?.ciphertext_hex && !decryptedKyc[k.did] && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleDecryptKyc(k.did, k.encrypted)}
                      disabled={decryptingDid === k.did}
                      style={{ marginLeft: 4, fontSize: "0.72rem", padding: "2px 10px" }}
                    >
                      {decryptingDid === k.did ? "Decrypting…" : "Decrypt"}
                    </button>
                  )}
                </div>
                {(() => {
                  const dc = decryptedKyc[k.did];
                  if (dc) {
                    return (
                      <>
                        <div className="meta-text" style={{ marginTop: 4 }}>
                          Physical address: {dc.address}
                        </div>
                      </>
                    );
                  }
                  return null;
                })()}
                {k.jurisdiction_path && (
                  <div className="meta-text">
                    Jurisdiction: {k.jurisdiction_path.join(" / ")}
                  </div>
                )}
                {k.author && (
                  <div className="meta-text">
                    Voter DID: <span className="mono">{k.author.slice(0, 48)}...</span>
                  </div>
                )}
                {k.verified_by && (
                  <div className="meta-text">
                    Approved by: <span className="mono">{k.verified_by.slice(0, 40)}...</span>
                  </div>
                )}
              </div>
              <div className="election-row-actions">
                {k.status === "submitted" && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      value={approvingDid === k.did ? kycJurisdictionInput : ""}
                      onChange={(e) => setKycJurisdictionInput(e.target.value)}
                      onClick={() => { setApprovingDid(k.did); setKycJurisdictionInput(""); }}
                      placeholder="PH/NCR/City/District"
                      className="input"
                      style={{ width: 200, fontSize: "0.78rem" }}
                      disabled={!decryptedKyc[k.did]}
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => approveKyc(k.did, kycJurisdictionInput)}
                      disabled={(approvingDid === k.did && !kycJurisdictionInput.trim()) || !decryptedKyc[k.did]}
                      title={!decryptedKyc[k.did] ? "Decrypt the KYC payload first" : undefined}
                    >
                      {approvingDid === k.did ? "Confirm" : "Approve"}
                    </button>
                  </div>
                )}
                {k.status === "approved" && (
                  <button className="btn btn-danger btn-sm" onClick={() => revokeKyc(k.did)}>
                    Revoke
                  </button>
                )}
              </div>
            </div>
                ))}
                {filtered.length > PAGE_SIZE && (
                  <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16 }}>
                    <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>« Prev</button>
                    <span className="meta-text">Page {page} of {Math.ceil(filtered.length / PAGE_SIZE)}</span>
                    <button className="btn btn-ghost btn-sm" disabled={page >= Math.ceil(filtered.length / PAGE_SIZE)} onClick={() => setPage(page + 1)}>Next »</button>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {view === "tally" && (
        <div className="builder">
          <div className="card">
            <h3>Decrypt &amp; Tally Ballots</h3>
            <p className="muted" style={{ marginBottom: 16 }}>
              Fetch encrypted ballots from the chain and decrypt them locally using
              the election's private key. Only the admin who created the election
              can decrypt the ballots.
            </p>
            <div className="form-row">
              <label className="field field-grow">
                <span className="field-label">Election ID</span>
                <input
                  type="text"
                  value={tallyElectionId}
                  onChange={(e) => setTallyElectionId(e.target.value)}
                  placeholder="elec-2028-national"
                  className="input mono"
                />
              </label>
            </div>
            <div className="builder-actions">
              <button
                className="btn btn-primary btn-lg"
                onClick={decryptTally}
                disabled={tallying || !tallyElectionId.trim()}
              >
                {tallying ? "Decrypting..." : "Decrypt & Tally"}
              </button>
            </div>
          </div>

          {tallyResult && (
            <div className="card">
              <h3>Results — {tallyResult.election_id}</h3>
              <div className="election-row-meta" style={{ marginBottom: 16 }}>
                <span className="badge-info">{tallyResult.total_ballots} total ballots</span>
                <span className="badge-info">{tallyResult.decrypted} decrypted</span>
                {tallyResult.failed > 0 && (
                  <span className="status-badge closed">{tallyResult.failed} failed</span>
                )}
              </div>
              {Object.entries(tallyResult.tally).map(([raceId, candidates]) => (
                <div key={raceId} className="race-tally" style={{ marginBottom: 20 }}>
                  <h4 style={{ textTransform: "capitalize" }}>{raceId}</h4>
                  <div className="tally-bars">
                    {Object.entries(candidates as Record<string, number>)
                      .sort(([, a], [, b]) => (b as number) - (a as number))
                      .map(([cid, count]) => {
                        const max = Math.max(...Object.values(candidates as Record<string, number>), 1);
                        return (
                          <div key={cid} className="tally-row" style={{
                            display: "flex", alignItems: "center", gap: 8, marginBottom: 4,
                          }}>
                            <span className="tally-label" style={{ width: 150 }}>{cid}</span>
                            <div style={{
                              flex: 1, height: 24, background: "var(--bg)", borderRadius: 4,
                              overflow: "hidden",
                            }}>
                              <div style={{
                                width: `${((count as number) / max) * 100}%`,
                                height: "100%",
                                background: "var(--accent)",
                                borderRadius: 4,
                                display: "flex",
                                alignItems: "center",
                                paddingLeft: 8,
                                color: "white",
                                fontSize: "0.8rem",
                              }}>
                                {count as number}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "admins" && (
        <div className="builder">
          <div className="card">
            <h3>Admin Management — Smart Contract</h3>
            <p className="muted" style={{ marginBottom: 16 }}>
              Admin assignments are powered by the <code>admin-registry</code> WASM smart contract.
              All operations require a wallet signature verified on-chain by the contract.
            </p>
            <div style={{ marginBottom: 24 }}>
              <h4 style={{ marginBottom: 12 }}>Assign New Admin</h4>
              <div className="form-row">
                <label className="field field-grow">
                  <span className="field-label">Admin DID</span>
                  <input
                    type="text"
                    value={newAdminDid}
                    onChange={(e) => setNewAdminDid(e.target.value)}
                    placeholder="did:key:ed25519:..."
                    className="input mono"
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="field">
                  <span className="field-label">Role</span>
                  <select
                    value={newAdminRole}
                    onChange={(e) => setNewAdminRole(e.target.value)}
                    className="input"
                  >
                    <option value="election-commissioner">Election Commissioner</option>
                    <option value="governance-body">Governance Body</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Scope</span>
                  <select
                    value={newAdminScope}
                    onChange={(e) => setNewAdminScope(e.target.value)}
                    className="input"
                  >
                    <option value="national">National</option>
                    <option value="regional">Regional</option>
                    <option value="local">Local</option>
                  </select>
                </label>
              </div>
              <div className="builder-actions">
                <button
                  className="btn btn-primary btn-lg"
                  onClick={assignAdmin}
                  disabled={adminActionPending || !newAdminDid.trim()}
                >
                  {adminActionPending ? "Signing..." : "Assign Admin (Sign)"}
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h4>Active Admins</h4>
              <button className="btn btn-sm btn-ghost" onClick={fetchAdmins}>Refresh</button>
            </div>
            {adminList.length === 0 ? (
              <p className="muted">No admins loaded. Click Refresh or deploy the admin-registry contract first.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                    <th style={{ padding: "8px" }}>DID</th>
                    <th style={{ padding: "8px" }}>Role</th>
                    <th style={{ padding: "8px" }}>Scope</th>
                    <th style={{ padding: "8px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {adminList.map((admin) => (
                    <tr key={admin.did} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "8px" }} className="mono" title={admin.did}>
                        {admin.did.length > 40 ? `${admin.did.slice(0, 20)}...${admin.did.slice(-12)}` : admin.did}
                      </td>
                      <td style={{ padding: "8px" }}>{admin.role}</td>
                      <td style={{ padding: "8px" }}>{admin.scope}</td>
                      <td style={{ padding: "8px" }}>
                        {admin.did !== walletDid && (
                          <button
                            className="btn btn-sm"
                            style={{ color: "var(--danger)" }}
                            onClick={() => revokeAdmin(admin.did)}
                            disabled={adminActionPending}
                          >
                            Revoke
                          </button>
                        )}
                        {admin.did === walletDid && (
                          <span className="muted" style={{ fontSize: "0.8rem" }}>(you)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}