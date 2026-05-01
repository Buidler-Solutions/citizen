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
      <section className="card">
        <h1>Vaultier</h1>
        <p className="subtitle">Portable encrypted backup vault for Citizen wallet recovery.</p>
        <nav className="stages" aria-label="Backup flow stages">
          {(['create', 'verify', 'restore', 'eject'] as Stage[]).map((item) => (
            <button key={item} className={stage === item ? 'pill active' : 'pill'} onClick={() => setStage(item)} disabled={!canProceed && item !== 'create'}>
              {item}
            </button>
          ))}
        </nav>

        <label>
          USB Target Path
          <input value={targetPath} onChange={(e) => setTargetPath(e.target.value)} />
        </label>

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
            <p className="hint">Run guided integrity checks before relying on this backup.</p>
            <button disabled={running || !profile} onClick={runVerify}>{running ? 'Verifying...' : 'Verify Backup'}</button>
            {verifySummary && <p>{verifySummary}</p>}
          </>
        )}

        {stage === 'restore' && (
          <>
            <p className="hint">Simulate restore to validate deterministic recovery sequencing.</p>
            <button disabled={running || !profile} onClick={runRestore}>{running ? 'Running restore test...' : 'Test Restore'}</button>
            {restoreSummary && <p>{restoreSummary}</p>}
          </>
        )}

        {stage === 'eject' && (
          <ul>
            <li>Confirm verification completed on this media.</li>
            <li>Confirm restore test passed with expected artifacts.</li>
            <li>Flush pending writes before eject.</li>
            <li>Store duplicate backup media in a separate location.</li>
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
        <ul>
          {logs.map((log) => (
            <li key={`${log.at}-${log.action}`}>{log.at} · {log.action} · {log.status} · {log.details}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
