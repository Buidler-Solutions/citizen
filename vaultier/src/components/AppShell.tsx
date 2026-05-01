import { useMemo, useState } from 'react';
import { createBackup, testRestore, verifyBackup } from '../lib/mockVaultCore';
import type {
  BackupRequest,
  OperationLog,
  PortableProfile,
  RestoreResult,
  VerifyResult,
  VaultRole,
} from '../lib/types';

type Stage = 'create' | 'verify' | 'restore' | 'eject';

const STAGES: Stage[] = ['create', 'verify', 'restore', 'eject'];

export function AppShell() {
  const [stage, setStage] = useState<Stage>('create');
  const [targetPath, setTargetPath] = useState('/Volumes/CITIZEN_USB');
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
  const [ejectChecks, setEjectChecks] = useState({
    verified: false,
    restoreTest: false,
    flushComplete: false,
    duplicateMedia: false,
  });

  const canProceed = useMemo(() => !!profile, [profile]);
  const safeToEject = useMemo(() => Object.values(ejectChecks).every(Boolean), [ejectChecks]);

  const toggleRole = (role: VaultRole) => {
    setSelectedRoles((current) =>
      current.includes(role) ? current.filter((item) => item !== role) : [...current, role]
    );
  };

  const appendLogs = (next: OperationLog[]) => setLogs((current) => [...next, ...current]);

  const runCreateBackup = async () => {
    const request: BackupRequest = { targetPath, roles: selectedRoles, includeConsentReceipts, portableMode };
    setRunning(true);
    setVerifySummary('');
    setRestoreSummary('');
    setVerifyResult(null);
    setRestoreResult(null);

    try {
      const result = await createBackup(request);
      setProfile(result.profile);
      appendLogs(result.log);
      setStage('verify');
    } finally {
      setRunning(false);
    }
  };

  const runVerify = async () => {
    if (!profile) return;
    setRunning(true);

    try {
      const result = await verifyBackup({ targetPath, expectedVaultVersion: profile.vaultVersion });
      appendLogs(result.log);
      setVerifyResult(result);
      setVerifySummary(`Backup verified. ${result.checks.length} deterministic checks passed at ${result.verifiedAt}.`);
      setProfile({ ...profile, lastVerifiedAt: result.verifiedAt });
      setEjectChecks((prev) => ({ ...prev, verified: true }));
      setStage('restore');
    } finally {
      setRunning(false);
    }
  };

  const runRestore = async () => {
    setRunning(true);

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
      setRestoreSummary(`Restore simulation completed for ${result.restoredRole} slot at ${result.restoredAt}.`);
      setEjectChecks((prev) => ({ ...prev, restoreTest: true }));
      setStage('eject');
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className={highContrast ? 'shell high-contrast' : 'shell'}>
      <section className="card" aria-live="polite">
        <h1>Vaultier</h1>
        <p className="subtitle">Portable encrypted backup vault for Citizen wallet recovery.</p>
        <div className="row controls-row">
          <label className="inline-control">
            <input type="checkbox" checked={highContrast} onChange={() => setHighContrast(!highContrast)} /> High contrast
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
          USB Target Path
          <input id="target-path" value={targetPath} onChange={(e) => setTargetPath(e.target.value)} aria-describedby="path-hint" />
        </label>
        <p id="path-hint" className="hint">Use mounted removable media path (Linux/macOS/Windows semantics supported by core adapter).</p>

        {stage === 'create' && (
          <>
            <div className="row">
              <label className="inline-control"><input type="checkbox" checked={selectedRoles.includes('decoy')} onChange={() => toggleRole('decoy')} /> Decoy slot</label>
              <label className="inline-control"><input type="checkbox" checked={selectedRoles.includes('critical')} onChange={() => toggleRole('critical')} /> Critical slot</label>
            </div>
            <div className="row">
              <label className="inline-control"><input type="checkbox" checked={includeConsentReceipts} onChange={() => setIncludeConsentReceipts(!includeConsentReceipts)} /> Include consent artifacts</label>
              <label className="inline-control"><input type="checkbox" checked={portableMode} onChange={() => setPortableMode(!portableMode)} /> Portable mode metadata</label>
            </div>
            <p className="hint">Create flow target: under 3 minutes with deterministic logs for operator review.</p>
            <button disabled={running || selectedRoles.length === 0} onClick={runCreateBackup}>{running ? 'Creating backup...' : 'Create Backup'}</button>
          </>
        )}

        {stage === 'verify' && (
          <>
            <p className="hint">Verify now to confirm vault integrity and version compatibility before relying on backup media.</p>
            <button disabled={running || !profile} onClick={runVerify}>{running ? 'Verifying...' : 'Verify Backup'}</button>
            {verifySummary && <p className="summary ok">{verifySummary}</p>}
            {verifyResult && (
              <div className="status-grid" role="status" aria-label="Verification checks">
                {verifyResult.checks.map((check) => (
                  <article key={check.label} className="status-card">
                    <strong>{check.label}</strong>
                    <p>{check.detail}</p>
                    <span className={check.status === 'ok' ? 'badge ok' : 'badge warn'}>{check.status}</span>
                  </article>
                ))}
              </div>
            )}
            <details>
              <summary>Deterministic technical checks</summary>
              <ul>
                <li>vault.verify.header_auth</li>
                <li>vault.verify.slot_inventory</li>
                <li>vault.verify.version_compatibility</li>
                <li>vault.verify.portable_profile</li>
              </ul>
            </details>
          </>
        )}

        {stage === 'restore' && (
          <>
            <p className="hint">Run a test restore to validate ordering and confirm key/receipt recovery intent.</p>
            <button disabled={running || !profile} onClick={runRestore}>{running ? 'Running restore test...' : 'Test Restore'}</button>
            {restoreSummary && <p className="summary ok">{restoreSummary}</p>}
            {restoreResult && (
              <div className="status-card">
                <strong>Recovered artifacts</strong>
                <p>{restoreResult.restoredArtifacts.join(', ') || 'No artifacts selected'}</p>
              </div>
            )}
            <details>
              <summary>Restore sequence details</summary>
              <ol>
                <li>Unlock role-specific slot</li>
                <li>Validate manifest checksums</li>
                <li>Apply identity keys</li>
                <li>Apply account keys</li>
                <li>Apply consent artifacts</li>
              </ol>
            </details>
          </>
        )}

        {stage === 'eject' && (
          <>
            <h2 className="h3">Safe removal checklist</h2>
            <ul className="checklist">
              <li><label className="inline-control"><input type="checkbox" checked={ejectChecks.verified} onChange={() => setEjectChecks((prev) => ({ ...prev, verified: !prev.verified }))} /> Verification completed on this media.</label></li>
              <li><label className="inline-control"><input type="checkbox" checked={ejectChecks.restoreTest} onChange={() => setEjectChecks((prev) => ({ ...prev, restoreTest: !prev.restoreTest }))} /> Restore test passed with expected artifacts.</label></li>
              <li><label className="inline-control"><input type="checkbox" checked={ejectChecks.flushComplete} onChange={() => setEjectChecks((prev) => ({ ...prev, flushComplete: !prev.flushComplete }))} /> Pending writes flushed before eject.</label></li>
              <li><label className="inline-control"><input type="checkbox" checked={ejectChecks.duplicateMedia} onChange={() => setEjectChecks((prev) => ({ ...prev, duplicateMedia: !prev.duplicateMedia }))} /> Duplicate backup media stored separately.</label></li>
            </ul>
            <p className={safeToEject ? 'summary ok' : 'summary warn'}>
              {safeToEject ? 'Checklist complete. Media is ready for safe removal.' : 'Complete all checklist items before removing media.'}
            </p>
            <p className="hint">Reminder: this vault does not protect against active malware on an unlocked host.</p>
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
          {logs.map((log) => (
            <li key={`${log.at}-${log.action}`}>{log.at} · {log.action} · {log.status} · {log.details}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
