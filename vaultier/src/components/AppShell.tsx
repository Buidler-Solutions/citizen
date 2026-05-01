import { useMemo, useState } from 'react';
import { createBackup, testRestore, verifyBackup } from '../lib/mockVaultCore';
import type { BackupRequest, OperationLog, PortableProfile, VaultRole } from '../lib/types';

type Stage = 'create' | 'verify' | 'restore' | 'eject';

export function AppShell() {
  const [stage, setStage] = useState<Stage>('create');
  const [targetPath, setTargetPath] = useState('/Volumes/CITIZEN_USB');
  const [selectedRoles, setSelectedRoles] = useState<VaultRole[]>(['decoy', 'critical']);
  const [includeConsentReceipts, setIncludeConsentReceipts] = useState(true);
  const [portableMode, setPortableMode] = useState(true);
  const [running, setRunning] = useState(false);
  const [profile, setProfile] = useState<PortableProfile | null>(null);
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [verifySummary, setVerifySummary] = useState<string>('');
  const [restoreSummary, setRestoreSummary] = useState<string>('');

  const canProceed = useMemo(() => !!profile, [profile]);

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
    const result = await createBackup(request);
    setProfile(result.profile);
    appendLogs(result.log);
    setStage('verify');
    setRunning(false);
  };

  const runVerify = async () => {
    if (!profile) return;
    setRunning(true);
    const result = await verifyBackup({ targetPath, expectedVaultVersion: profile.vaultVersion });
    appendLogs(result.log);
    setVerifySummary(`${result.checks.length} checks passed at ${result.verifiedAt}.`);
    setProfile({ ...profile, lastVerifiedAt: result.verifiedAt });
    setStage('restore');
    setRunning(false);
  };

  const runRestore = async () => {
    setRunning(true);
    const result = await testRestore({
      targetPath,
      role: 'critical',
      restoreIdentityKeys: true,
      restoreAccountKeys: true,
      restoreConsentReceipts: includeConsentReceipts,
    });
    appendLogs(result.log);
    setRestoreSummary(`Restore simulation completed for ${result.restoredRole} slot at ${result.restoredAt}.`);
    setStage('eject');
    setRunning(false);
  };

  return (
    <main className="shell">
      <section className="card" aria-live="polite">
        <h1>Vaultier</h1>
        <p className="subtitle">Portable encrypted backup vault for Citizen wallet recovery.</p>
        <nav className="stages" aria-label="Backup flow stages">
          {(['create', 'verify', 'restore', 'eject'] as Stage[]).map((item) => (
            <button key={item} className={stage === item ? 'pill active' : 'pill'} onClick={() => setStage(item)} disabled={!canProceed && item !== 'create'}>
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
              <label><input type="checkbox" checked={selectedRoles.includes('decoy')} onChange={() => toggleRole('decoy')} /> Decoy slot</label>
              <label><input type="checkbox" checked={selectedRoles.includes('critical')} onChange={() => toggleRole('critical')} /> Critical slot</label>
            </div>
            <div className="row">
              <label><input type="checkbox" checked={includeConsentReceipts} onChange={() => setIncludeConsentReceipts(!includeConsentReceipts)} /> Include consent artifacts</label>
              <label><input type="checkbox" checked={portableMode} onChange={() => setPortableMode(!portableMode)} /> Portable mode metadata</label>
            </div>
            <button disabled={running || selectedRoles.length === 0} onClick={runCreateBackup}>{running ? 'Creating backup...' : 'Create Backup'}</button>
          </>
        )}

        {stage === 'verify' && (
          <>
            <p className="hint">Verify now to confirm vault integrity and version compatibility before relying on backup media.</p>
            <button disabled={running || !profile} onClick={runVerify}>{running ? 'Verifying...' : 'Verify Backup'}</button>
            {verifySummary && <p>{verifySummary}</p>}
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
            {restoreSummary && <p>{restoreSummary}</p>}
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
          <ul className="checklist">
            <li><input type="checkbox" /> Verification completed on this media.</li>
            <li><input type="checkbox" /> Restore test passed with expected artifacts.</li>
            <li><input type="checkbox" /> Pending writes flushed before eject.</li>
            <li><input type="checkbox" /> Duplicate backup media stored separately.</li>
          </ul>
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
