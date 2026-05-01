import { useEffect, useMemo, useState } from 'react';
import {
  createBackup,
  discoverRemovableDrives,
  exportDiagnosticBundle,
  flushPendingWrites,
  testRestore,
  verifyBackup,
} from '../lib/mockVaultCore';
import type {
  BackupRequest,
  DiagnosticBundle,
  OperationLog,
  PortableProfile,
  RemovableDrive,
  RestoreResult,
  VerifyResult,
  VaultRole,
} from '../lib/types';
import { ERROR_COPY, OPERATION_STATE_COPY, type ErrorIdentifier, type OperationState } from '../lib/operationState';

type Stage = 'create' | 'verify' | 'restore' | 'eject';

const STAGES: Stage[] = ['create', 'verify', 'restore', 'eject'];

const estimateEntropyBits = (value: string) => {
  if (!value) return 0;
  let charset = 0;
  if (/[a-z]/.test(value)) charset += 26;
  if (/[A-Z]/.test(value)) charset += 26;
  if (/\d/.test(value)) charset += 10;
  if (/[^A-Za-z0-9]/.test(value)) charset += 32;
  return Math.round(value.length * Math.log2(Math.max(charset, 1)));
};

const entropyBand = (bits: number) => {
  if (bits >= 80) return { label: 'Strong', className: 'ok' as const };
  if (bits >= 60) return { label: 'Moderate', className: 'warn' as const };
  return { label: 'Weak', className: 'bad' as const };
};

export function AppShell() {
  const [stage, setStage] = useState<Stage>('create');
  const [targetPath, setTargetPath] = useState('/Volumes/CITIZEN_USB');
  const [detectedDrives, setDetectedDrives] = useState<RemovableDrive[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<VaultRole[]>(['decoy', 'critical']);
  const [includeConsentReceipts, setIncludeConsentReceipts] = useState(true);
  const [portableMode, setPortableMode] = useState(true);
  const [highContrast, setHighContrast] = useState(false);
  const [running, setRunning] = useState(false);
  const [profile, setProfile] = useState<PortableProfile | null>(null);
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [verifySummary, setVerifySummary] = useState('');
  const [restoreSummary, setRestoreSummary] = useState('');
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [decoyPassphrase, setDecoyPassphrase] = useState('');
  const [criticalPassphrase, setCriticalPassphrase] = useState('');
  const [unlockFailures, setUnlockFailures] = useState(0);
  const [unlockDelayMs, setUnlockDelayMs] = useState(0);
  const [diagnosticBundle, setDiagnosticBundle] = useState<DiagnosticBundle | null>(null);

  const [operationState, setOperationState] = useState<OperationState>('idle');
  const [activeError, setActiveError] = useState<ErrorIdentifier | null>(null);
  const [ejectChecks, setEjectChecks] = useState({
    verified: false,
    restoreTest: false,
    flushComplete: false,
    duplicateMedia: false,
  });

  useEffect(() => {
    discoverRemovableDrives().then(setDetectedDrives);
  }, []);

  useEffect(() => {
    if (unlockDelayMs <= 0) return;
    const timer = setInterval(() => {
      setUnlockDelayMs((value) => Math.max(0, value - 500));
    }, 500);
    return () => clearInterval(timer);
  }, [unlockDelayMs]);

  const canProceed = useMemo(() => !!profile, [profile]);
  const safeToEject = useMemo(() => Object.values(ejectChecks).every(Boolean), [ejectChecks]);

  const decoyEntropy = estimateEntropyBits(decoyPassphrase);
  const criticalEntropy = estimateEntropyBits(criticalPassphrase);

  const appendLogs = (next: OperationLog[]) => setLogs((current) => [...next, ...current]);

  const toggleRole = (role: VaultRole) => {
    setSelectedRoles((current) =>
      current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role]
    );
  };

  const runCreateBackup = async () => {
    const request: BackupRequest = {
      targetPath,
      roles: selectedRoles,
      includeConsentReceipts,
      portableMode,
    };

    setRunning(true);
    setActiveError(null);
    setOperationState('preflight');
    setVerifySummary('');
    setRestoreSummary('');
    setVerifyResult(null);
    setRestoreResult(null);

    try {
      setOperationState('writing');
      const result = await createBackup(request);
      setProfile(result.profile);
      appendLogs(result.log);
      setStage('verify');
      setOperationState('verify_required');
    } finally {
      setRunning(false);
    }
  };

  const runVerify = async () => {
    if (!profile) return;
    setRunning(true);
    setActiveError(null);
    setOperationState('preflight');

    try {
      const result = await verifyBackup({
        targetPath,
        expectedVaultVersion: profile.vaultVersion,
      });
      appendLogs(result.log);
      setVerifyResult(result);
      setVerifySummary(
        `Backup verified. ${result.checks.length} deterministic checks passed at ${result.verifiedAt}.`
      );
      setProfile({ ...profile, lastVerifiedAt: result.verifiedAt });
      setEjectChecks((prev) => ({ ...prev, verified: true }));
      setStage('restore');
      setOperationState('completed');
    } finally {
      setRunning(false);
    }
  };

  const simulateFailedUnlock = () => {
    const nextFailures = unlockFailures + 1;
    const delay = Math.min(2 ** nextFailures * 500, 8000);
    setUnlockFailures(nextFailures);
    setUnlockDelayMs(delay);

    setActiveError('decrypt_failed');

    appendLogs([
      {
        at: new Date().toISOString(),
        action: 'vault.unlock.failed',
        status: 'warn',
        details: `Failed unlock #${nextFailures}; restore backoff ${delay}ms enforced.`,
      },
    ]);
  };

  const runRestore = async () => {
    if (unlockDelayMs > 0) return;
    setRunning(true);
    setActiveError(null);
    setOperationState('preflight');

    try {
      const result = await testRestore({
        targetPath,
        role: 'critical',
        restoreIdentityKeys: true,
        restoreAccountKeys: true,
        restoreConsentReceipts: includeConsentReceipts,
      });
      appendLogs(result.log);
      setRestoreResult(result);
      setRestoreSummary(
        `Restore simulation completed for ${result.restoredRole} slot at ${result.restoredAt}.`
      );
      setUnlockFailures(0);
      setEjectChecks((prev) => ({ ...prev, restoreTest: true }));
      setStage('eject');
      setOperationState('verify_required');
    } finally {
      setRunning(false);
    }
  };

  const runFlushWrites = async () => {
    setOperationState('flushing');
    const flushLog = await flushPendingWrites(targetPath);
    appendLogs(flushLog);
    setEjectChecks((prev) => ({ ...prev, flushComplete: true }));
    setOperationState('completed');
  };

  const runExportDiagnostics = async () => {
    if (!profile) return;
    const bundle = await exportDiagnosticBundle(profile, logs.slice(0, 12));
    setDiagnosticBundle(bundle);
  };

  return (
    <main className={highContrast ? 'shell high-contrast' : 'shell'}>
      <section className="card" aria-live="polite">
        <h1>Vaultier</h1>
        <p className="subtitle">Portable encrypted backup vault for Citizen wallet recovery.</p>

        <article className="state-panel" role="status" aria-label="Current operation state">
          <strong>{OPERATION_STATE_COPY[operationState].title}</strong>
          <p className="hint">{OPERATION_STATE_COPY[operationState].detail}</p>
          {activeError && (
            <div className="error-panel">
              <strong>Error code: {activeError}</strong>
              <p>{ERROR_COPY[activeError].headline}</p>
              <p className="hint">Next action: {ERROR_COPY[activeError].nextAction}</p>
            </div>
          )}
        </article>

        <div className="row controls-row">
          <label className="inline-control">
            <input
              type="checkbox"
              checked={highContrast}
              onChange={() => setHighContrast(!highContrast)}
            />
            High contrast
          </label>
        </div>

        <nav className="stages" aria-label="Backup flow stages">
          {STAGES.map((item) => (
            <button
              key={item}
              className={stage === item ? 'pill active' : 'pill'}
              onClick={() => setStage(item)}
              disabled={!canProceed && item !== 'create'}
              aria-current={stage === item ? 'step' : undefined}
            >
              {item}
            </button>
          ))}
        </nav>

        <label htmlFor="target-path">
          USB target path
          <input
            id="target-path"
            value={targetPath}
            onChange={(event) => setTargetPath(event.target.value)}
            aria-describedby="path-hint"
          />
        </label>

        <p id="path-hint" className="hint">
          Cross-platform path semantics are supported (macOS, Linux, Windows adapters).
        </p>

        {detectedDrives.length > 0 && (
          <label htmlFor="drive-picker">
            Detected removable drives
            <select
              id="drive-picker"
              value={targetPath}
              onChange={(event) => setTargetPath(event.target.value)}
            >
              {detectedDrives.map((drive) => (
                <option key={drive.id} value={drive.mountPath}>
                  {drive.label} · {drive.mountPath} · {drive.platform} · {drive.filesystem}
                </option>
              ))}
            </select>
          </label>
        )}

        {stage === 'create' && (
          <>
            <div className="row">
              <label className="inline-control">
                <input
                  type="checkbox"
                  checked={selectedRoles.includes('decoy')}
                  onChange={() => toggleRole('decoy')}
                />
                Decoy slot
              </label>
              <label className="inline-control">
                <input
                  type="checkbox"
                  checked={selectedRoles.includes('critical')}
                  onChange={() => toggleRole('critical')}
                />
                Critical slot
              </label>
            </div>

            <div className="row">
              <label className="inline-control">
                <input
                  type="checkbox"
                  checked={includeConsentReceipts}
                  onChange={() => setIncludeConsentReceipts(!includeConsentReceipts)}
                />
                Include consent artifacts
              </label>
              <label className="inline-control">
                <input
                  type="checkbox"
                  checked={portableMode}
                  onChange={() => setPortableMode(!portableMode)}
                />
                Portable mode metadata
              </label>
            </div>

            <div className="status-grid">
              <article className="status-card">
                <label htmlFor="decoy-passphrase">Decoy passphrase</label>
                <input
                  id="decoy-passphrase"
                  type="password"
                  value={decoyPassphrase}
                  onChange={(event) => setDecoyPassphrase(event.target.value)}
                />
                <p className={`summary ${entropyBand(decoyEntropy).className}`}>
                  Entropy: {decoyEntropy} bits · {entropyBand(decoyEntropy).label}
                </p>
              </article>

              <article className="status-card">
                <label htmlFor="critical-passphrase">Critical passphrase</label>
                <input
                  id="critical-passphrase"
                  type="password"
                  value={criticalPassphrase}
                  onChange={(event) => setCriticalPassphrase(event.target.value)}
                />
                <p className={`summary ${entropyBand(criticalEntropy).className}`}>
                  Entropy: {criticalEntropy} bits · {entropyBand(criticalEntropy).label}
                </p>
              </article>
            </div>

            <div className="note-panel">
              <strong>What this cannot protect against</strong>
              <p>
                This does not protect against active malware on an unlocked host, firmware compromise,
                or coerced passphrase disclosure.
              </p>
            </div>

            <button disabled={running || selectedRoles.length === 0} onClick={runCreateBackup}>
              {running ? 'Creating backup...' : 'Create Backup'}
            </button>
          </>
        )}

        {stage === 'verify' && (
          <>
            <button disabled={running || !profile} onClick={runVerify}>
              {running ? 'Verifying...' : 'Verify Backup'}
            </button>
            {verifySummary && <p className="summary ok">{verifySummary}</p>}
            {verifyResult && (
              <div className="status-grid" role="status" aria-label="Verification checks">
                {verifyResult.checks.map((check) => (
                  <article key={check.label} className="status-card">
                    <strong>{check.label}</strong>
                    <p>{check.detail}</p>
                    <span className={check.status === 'ok' ? 'badge ok' : 'badge warn'}>
                      {check.status}
                    </span>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {stage === 'restore' && (
          <>
            <div className="row">
              <button onClick={simulateFailedUnlock}>Simulate wrong passphrase</button>
              <button disabled={running || !profile || unlockDelayMs > 0} onClick={runRestore}>
                {running ? 'Running restore test...' : 'Test Restore'}
              </button>
            </div>
            {unlockDelayMs > 0 && (
              <p className="summary warn">Backoff active: {unlockDelayMs}ms remaining.</p>
            )}
            {restoreSummary && <p className="summary ok">{restoreSummary}</p>}
            {restoreResult && (
              <div className="status-card">
                <strong>Recovered artifacts</strong>
                <p>{restoreResult.restoredArtifacts.join(', ') || 'No artifacts selected'}</p>
              </div>
            )}
          </>
        )}

        {stage === 'eject' && (
          <>
            <h2 className="h3">Safe removal checklist</h2>
            <ul className="checklist">
              <li>
                <label className="inline-control">
                  <input
                    type="checkbox"
                    checked={ejectChecks.verified}
                    onChange={() =>
                      setEjectChecks((prev) => ({ ...prev, verified: !prev.verified }))
                    }
                  />
                  Verification completed on this media.
                </label>
              </li>
              <li>
                <label className="inline-control">
                  <input
                    type="checkbox"
                    checked={ejectChecks.restoreTest}
                    onChange={() =>
                      setEjectChecks((prev) => ({ ...prev, restoreTest: !prev.restoreTest }))
                    }
                  />
                  Restore test passed with expected artifacts.
                </label>
              </li>
              <li>
                <label className="inline-control">
                  <input
                    type="checkbox"
                    checked={ejectChecks.flushComplete}
                    onChange={() =>
                      setEjectChecks((prev) => ({ ...prev, flushComplete: !prev.flushComplete }))
                    }
                  />
                  Pending writes flushed before eject.
                </label>
              </li>
              <li>
                <label className="inline-control">
                  <input
                    type="checkbox"
                    checked={ejectChecks.duplicateMedia}
                    onChange={() =>
                      setEjectChecks((prev) => ({ ...prev, duplicateMedia: !prev.duplicateMedia }))
                    }
                  />
                  Duplicate backup media stored separately.
                </label>
              </li>
            </ul>

            <button onClick={runFlushWrites}>Flush pending writes</button>
            <p className={safeToEject ? 'summary ok' : 'summary warn'}>
              {safeToEject
                ? 'Checklist complete. Media is ready for safe removal.'
                : 'Complete all checklist items before removing media.'}
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Portable profile</h2>
        {profile ? (
          <ul>
            <li>USB Label: {profile.usbLabel}</li>
            <li>Vault Format: {profile.vaultVersion}</li>
            <li>Created: {profile.createdAt}</li>
            <li>Last Verification: {profile.lastVerifiedAt}</li>
          </ul>
        ) : (
          <p className="hint">Create a backup to generate a profile.</p>
        )}

        <h3>Operation log</h3>
        <ul className="log-list">
          {logs.map((entry) => (
            <li key={`${entry.at}-${entry.action}`}>
              {entry.at} · {entry.action} · {entry.status} · {entry.details}
            </li>
          ))}
        </ul>

        <button disabled={!profile} onClick={runExportDiagnostics}>
          Export diagnostics
        </button>
        {diagnosticBundle && (
          <details>
            <summary>Latest diagnostic bundle</summary>
            <pre>{JSON.stringify(diagnosticBundle, null, 2)}</pre>
          </details>
        )}
      </section>
    </main>
  );
}
