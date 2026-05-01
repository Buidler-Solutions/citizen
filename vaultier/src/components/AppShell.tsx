import { useEffect, useMemo, useState } from 'react';
import { createBackup, discoverRemovableDrives, exportDiagnosticBundle, flushPendingWritesWithStrategy, getRuntimeShell, testRestore, verifyBackup } from '../lib/mockVaultCore';
import type { BackupRequest, CrashSafeWriteStep, DiagnosticBundle, DriveDiscoveryResult, OperationLog, PortableProfile, RestoreResult, RuntimeShell, VerifyResult, VaultRole } from '../lib/types';
import { ERROR_COPY, OPERATION_STATE_COPY, type ErrorIdentifier, type OperationState } from '../lib/operationState';
import { defaultReminderPolicy, getNextReminderAt, isReminderDue, loadReminderSettings, saveReminderSettings, type ReminderPolicy } from '../lib/reminders';

type Stage = 'create' | 'verify' | 'restore' | 'eject';
const STAGES: Stage[] = ['create', 'verify', 'restore', 'eject'];
const MIN_CRITICAL_ENTROPY = 80;

const estimateEntropyBits = (value: string) => {
  if (!value) return 0;
  let charset = 0;
  if (/[a-z]/.test(value)) charset += 26;
  if (/[A-Z]/.test(value)) charset += 26;
  if (/\d/.test(value)) charset += 10;
  if (/[^A-Za-z0-9]/.test(value)) charset += 32;
  return Math.round(value.length * Math.log2(Math.max(charset, 1)));
};

const entropyBand = (bits: number) => bits >= 80 ? { label: 'Strong (recommended >=80 bits)', className: 'ok' as const } : bits >= 60 ? { label: 'Moderate (minimum for decoy)', className: 'warn' as const } : { label: 'Weak (increase length + symbol variety)', className: 'bad' as const };
const isFilesystemRecommended = (fs: string) => ['exfat', 'ntfs', 'ext4', 'apfs'].includes(fs);

const platformEjectGuidance: Record<string, string> = {
  macos: 'In Finder, click eject next to the USB volume and wait for disappear confirmation.',
  windows: 'Use Safely Remove Hardware in the system tray and wait for the safe-to-remove toast.',
  linux: 'Run a desktop eject action or `udisksctl power-off -b <device>` after unmount confirmation.',
};

export function AppShell() {
  const [stage, setStage] = useState<Stage>('create');
  const [targetPath, setTargetPath] = useState('/Volumes/CITIZEN_USB');
  const [discovery, setDiscovery] = useState<DriveDiscoveryResult>({ drives: [], errors: [] });
  const [selectedRoles, setSelectedRoles] = useState<VaultRole[]>(['decoy', 'critical']);
  const [includeConsentReceipts, setIncludeConsentReceipts] = useState(true);
  const [portableMode, setPortableMode] = useState(true);
  const [highContrast, setHighContrast] = useState(false);
  const [running, setRunning] = useState(false);
  const [profile, setProfile] = useState<PortableProfile | null>(null);
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [decoyPassphrase, setDecoyPassphrase] = useState('');
  const [criticalPassphrase, setCriticalPassphrase] = useState('');
  const [unlockFailures, setUnlockFailures] = useState(0);
  const [unlockDelayMs, setUnlockDelayMs] = useState(0);
  const [diagnosticBundle, setDiagnosticBundle] = useState<DiagnosticBundle | null>(null);
  const [activeError, setActiveError] = useState<ErrorIdentifier | null>(null);
  const [operationState, setOperationState] = useState<OperationState>('idle');
  const [ejectChecks, setEjectChecks] = useState({ verified: false, restoreTest: false, flushComplete: false, duplicateMedia: false });
  const [reminderPolicy, setReminderPolicy] = useState<ReminderPolicy>(defaultReminderPolicy());
  const [runtimeShell, setRuntimeShell] = useState<RuntimeShell>('web-mock');
  const [flushStrategy, setFlushStrategy] = useState<CrashSafeWriteStep[]>([]);

  useEffect(() => { discoverRemovableDrives().then(setDiscovery); }, []);
  useEffect(() => { setRuntimeShell(getRuntimeShell()); }, []);
  useEffect(() => { setReminderPolicy(loadReminderSettings()); }, []);
  useEffect(() => { saveReminderSettings(reminderPolicy); }, [reminderPolicy]);
  useEffect(() => { if (unlockDelayMs <= 0) return; const timer = setInterval(() => setUnlockDelayMs((v) => Math.max(0, v - 500)), 500); return () => clearInterval(timer); }, [unlockDelayMs]);

  const selectedDrive = useMemo(() => discovery.drives.find((d) => d.mountPath === targetPath), [discovery, targetPath]);
  const safeToEject = useMemo(() => Object.values(ejectChecks).every(Boolean), [ejectChecks]);
  const decoyEntropy = estimateEntropyBits(decoyPassphrase);
  const criticalEntropy = estimateEntropyBits(criticalPassphrase);
  const appendLogs = (next: OperationLog[]) => setLogs((current) => [...next, ...current]);
  const nextReminderAt = useMemo(() => profile?.lastVerifiedAt ? getNextReminderAt(profile.lastVerifiedAt, reminderPolicy) : null, [profile, reminderPolicy]);
  const reminderDue = useMemo(() => nextReminderAt ? isReminderDue(nextReminderAt) : false, [nextReminderAt]);

  const downloadDiagnosticBundle = () => {
    if (!diagnosticBundle) return;
    const file = new Blob([JSON.stringify(diagnosticBundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `vaultier-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const runCreateBackup = async () => {
    if (!selectedDrive) return setActiveError('path_invalid');
    if (!selectedDrive.writable) return setActiveError('mount_unwritable');
    if (selectedDrive.estimatedFreeGb < 4) return setActiveError('insufficient_space');
    if (selectedDrive && !isFilesystemRecommended(selectedDrive.filesystem)) return setActiveError('invalid_payload');
    if (selectedRoles.includes('critical') && criticalEntropy < MIN_CRITICAL_ENTROPY) return setActiveError('decrypt_failed');

    const request: BackupRequest = { targetPath, roles: selectedRoles, includeConsentReceipts, portableMode };
    setRunning(true); setActiveError(null); setOperationState('writing');
    try { const result = await createBackup(request); setProfile(result.profile); appendLogs(result.log); setStage('verify'); setOperationState('verify_required'); } finally { setRunning(false); }
  };

  const runVerify = async () => {
    if (!profile) return;
    setRunning(true); setActiveError(null); setOperationState('preflight');
    try { const result = await verifyBackup({ targetPath, expectedVaultVersion: profile.vaultVersion }); appendLogs(result.log); setVerifyResult(result); setProfile({ ...profile, lastVerifiedAt: result.verifiedAt }); setEjectChecks((p) => ({ ...p, verified: true })); setStage('restore'); setOperationState('completed'); } finally { setRunning(false); }
  };

  const runRestore = async () => {
    if (unlockDelayMs > 0) return;
    setRunning(true); setActiveError(null);
    try { const result = await testRestore({ targetPath, role: 'critical', restoreIdentityKeys: true, restoreAccountKeys: true, restoreConsentReceipts: includeConsentReceipts }); appendLogs(result.log); setRestoreResult(result); setUnlockFailures(0); setEjectChecks((p) => ({ ...p, restoreTest: true })); setStage('eject'); } finally { setRunning(false); }
  };

  const simulateFailedUnlock = () => { const nextFailures = unlockFailures + 1; const delay = Math.min(2 ** nextFailures * 500, 8000); setUnlockFailures(nextFailures); setUnlockDelayMs(delay); setActiveError('decrypt_failed'); };
  const runFlushWrites = async () => { setOperationState('flushing'); const result = await flushPendingWritesWithStrategy(targetPath); appendLogs(result.logs); setFlushStrategy(result.strategy); setEjectChecks((p) => ({ ...p, flushComplete: true })); setOperationState('completed'); };
  const runExportDiagnostics = async () => { if (profile) setDiagnosticBundle(await exportDiagnosticBundle(profile, logs.slice(0, 12))); };

  return <main className={highContrast ? 'shell high-contrast' : 'shell'}>
    <section className="card" aria-live="polite"><h1>Vaultier</h1><p className="subtitle">Portable encrypted backup vault for Citizen wallet recovery.</p>
      <article className="state-panel"><strong>{OPERATION_STATE_COPY[operationState].title}</strong><p className="hint">{OPERATION_STATE_COPY[operationState].detail}</p><p className="hint">Runtime shell: {runtimeShell === 'tauri' ? 'Tauri bridge' : 'Web mock adapter'}.</p>{activeError && <div className="error-panel"><strong>Error code: {activeError}</strong><p>{ERROR_COPY[activeError].headline}</p><p className="hint">Next action: {ERROR_COPY[activeError].nextAction}</p></div>}</article>
      {reminderDue && <p className="summary warn">Verification reminder is due. Run verify before relying on this media.</p>}
      <label className="inline-control"><input type="checkbox" checked={highContrast} onChange={() => setHighContrast(!highContrast)} />High contrast</label>
      <nav className="stages">{STAGES.map((item) => <button key={item} className={stage === item ? 'pill active' : 'pill'} onClick={() => setStage(item)} disabled={!profile && item !== 'create'}>{item}</button>)}</nav>
      <label>Detected removable drives<select value={targetPath} onChange={(e) => setTargetPath(e.target.value)}>{discovery.drives.map((d) => <option key={d.id} value={d.mountPath}>{d.label} · {d.mountPath} · {d.filesystem} · {d.estimatedFreeGb}GB free</option>)}</select></label>
      {selectedDrive && <p className="hint">Filesystem policy: <strong>{isFilesystemRecommended(selectedDrive.filesystem) ? 'Recommended' : 'Higher risk'}</strong> · {selectedDrive.filesystem.toUpperCase()}</p>}
      {discovery.errors.length > 0 && <p className="summary warn">Adapter notices: {discovery.errors.map((err) => `${err.code} (${err.mountPath})`).join(', ')}.</p>}

      {stage === 'create' && <><div className="row"><label className="inline-control"><input type="checkbox" checked={selectedRoles.includes('decoy')} onChange={() => setSelectedRoles((c) => c.includes('decoy') ? c.filter((x) => x !== 'decoy') : [...c, 'decoy'])} />Decoy slot</label><label className="inline-control"><input type="checkbox" checked={selectedRoles.includes('critical')} onChange={() => setSelectedRoles((c) => c.includes('critical') ? c.filter((x) => x !== 'critical') : [...c, 'critical'])} />Critical slot</label></div>
      <div className="row"><label className="inline-control"><input type="checkbox" checked={includeConsentReceipts} onChange={() => setIncludeConsentReceipts((v) => !v)} />Include consent receipts</label><label className="inline-control"><input type="checkbox" checked={portableMode} onChange={() => setPortableMode((v) => !v)} />Portable mode metadata</label></div>
      <div className="status-grid"><article className="status-card"><label>Decoy passphrase<input type="password" value={decoyPassphrase} onChange={(e) => setDecoyPassphrase(e.target.value)} /></label><progress max={100} value={Math.min(decoyEntropy, 100)} /><p className={`summary ${entropyBand(decoyEntropy).className}`}>Entropy {decoyEntropy} bits · {entropyBand(decoyEntropy).label}</p></article><article className="status-card"><label>Critical passphrase<input type="password" value={criticalPassphrase} onChange={(e) => setCriticalPassphrase(e.target.value)} /></label><progress max={100} value={Math.min(criticalEntropy, 100)} /><p className={`summary ${entropyBand(criticalEntropy).className}`}>Entropy {criticalEntropy} bits · {entropyBand(criticalEntropy).label}</p></article></div>
      <button disabled={running || selectedRoles.length === 0} onClick={runCreateBackup}>Create Backup</button></>}
      {stage === 'verify' && <><button disabled={running || !profile} onClick={runVerify}>Verify Backup</button>{verifyResult && <p className="summary ok">{verifyResult.checks.length} checks passed at {verifyResult.verifiedAt}.</p>}</>}
      {stage === 'restore' && <><div className="row"><button onClick={simulateFailedUnlock}>Simulate wrong passphrase</button><button disabled={running || unlockDelayMs > 0} onClick={runRestore}>Test Restore</button></div>{unlockDelayMs > 0 && <p className="summary warn">Backoff active: {unlockDelayMs}ms. Repeated failures intentionally slow unlock retries.</p>}{restoreResult && <p className="summary ok">Recovered: {restoreResult.restoredArtifacts.join(', ')}</p>}</>}
      {stage === 'eject' && <><button onClick={runFlushWrites}>Flush pending writes</button><label className="inline-control"><input type="checkbox" checked={ejectChecks.duplicateMedia} onChange={() => setEjectChecks((p) => ({ ...p, duplicateMedia: !p.duplicateMedia }))} />Duplicate backup stored separately</label><p className={safeToEject ? 'summary ok' : 'summary warn'}>{safeToEject ? 'Checklist complete. Safe to eject.' : 'Complete all checklist steps before ejection.'}</p>
      {selectedDrive && <p className="hint">Safe eject guidance: {platformEjectGuidance[selectedDrive.platform]}</p>}
      {flushStrategy.length > 0 && <details><summary>Crash-safe write strategy</summary><ul>{flushStrategy.map((step) => <li key={step.step}>{step.step} · {step.status} · {step.detail}</li>)}</ul></details>}</>}
    </section>
    <section className="card"><h2>Portable profile</h2>{profile ? <ul><li>USB Label: {profile.usbLabel}</li><li>Vault Format: {profile.vaultVersion}</li><li>Created: {profile.createdAt}</li><li>Last Verification: {profile.lastVerifiedAt}</li><li>Next verification reminder: {nextReminderAt ?? 'Pending first verify'}</li></ul> : <p className="hint">Create a backup to generate a profile.</p>}
      <h3>Reminder policy</h3>
      <label className="inline-control"><input type="checkbox" checked={reminderPolicy.enabled} onChange={() => setReminderPolicy((p) => ({ ...p, enabled: !p.enabled }))} />Enable verification reminders</label>
      <label>Reminder cadence (days)<input type="number" min={7} max={365} value={reminderPolicy.cadenceDays} onChange={(e) => setReminderPolicy((p) => ({ ...p, cadenceDays: Number(e.target.value) || p.cadenceDays }))} /></label>
      <h3>Operation log</h3><ul className="log-list">{logs.map((entry) => <li key={`${entry.at}-${entry.action}`}>{entry.at} · {entry.action} · {entry.status} · {entry.details}</li>)}</ul><div className="row"><button disabled={!profile} onClick={runExportDiagnostics}>Export diagnostics</button><button disabled={!diagnosticBundle} onClick={downloadDiagnosticBundle}>Download JSON</button></div>{diagnosticBundle && <details><summary>Latest diagnostic bundle</summary><pre>{JSON.stringify(diagnosticBundle, null, 2)}</pre></details>}</section>
    <section className="card">
      <h2>What this cannot protect against</h2>
      <ul className="log-list">
        <li>Malware running on an unlocked host that captures passphrases or screenshots.</li>
        <li>Coercion or legal compulsion; decoy workflows reduce disclosure pressure but are not absolute protection.</li>
        <li>Destructive media failure without a second verified backup copy on separate hardware.</li>
        <li>Operator mistakes after restore (e.g., not rotating credentials for suspected compromise scenarios).</li>
      </ul>
      <p className="hint">Always keep at least two verified removable backups stored in different physical locations.</p>
    </section>
  </main>;
}
