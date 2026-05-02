import { useEffect, useMemo, useState } from 'react';
import { createBackup, discoverRemovableDrives, exportDiagnosticBundle, flushPendingWritesWithStrategy, getRuntimeShell, safeEjectMedia, testRestore, verifyBackup } from '../lib/mockVaultCore';
import { getRuntimeProfile, setRuntimeProfile } from '../lib/runtimeBridge';
import type { BackupRequest, CrashSafeWriteStep, DiagnosticBundle, DriveDiscoveryResult, OperationLog, PerformanceMeasurement, PortableProfile, RestoreResult, RuntimeProfile, RuntimeShell, VerifyResult, VaultRole } from '../lib/types';
import { ERROR_COPY, OPERATION_STATE_COPY, type ErrorIdentifier, type OperationState } from '../lib/operationState';
import { defaultReminderPolicy, getNextReminderAt, isReminderDue, loadPortableProfile, loadReminderSettings, savePortableProfile, saveReminderSettings, type ReminderPolicy } from '../lib/reminders';

type Stage = 'create' | 'verify' | 'restore' | 'eject';
const STAGES: Stage[] = ['create', 'verify', 'restore', 'eject'];
const MIN_CRITICAL_ENTROPY = 80;
const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000];
const PERFORMANCE_TARGETS = { create: 2000, verify: 1500, restore: 2500 } as const;
const REQUIRED_CRASH_SAFE_STEPS: CrashSafeWriteStep['step'][] = ['temp_write', 'fsync_file', 'atomic_rename', 'fsync_parent'];

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


const toUiError = (code: DriveDiscoveryResult['errors'][number]['code']): ErrorIdentifier => {
  switch (code) {
    case 'mount_unwritable':
      return 'mount_unwritable';
    case 'insufficient_space':
      return 'insufficient_space';
    case 'path_invalid':
      return 'path_invalid';
    case 'media_unavailable':
      return 'media_unavailable';
    case 'filesystem_incompatible':
      return 'filesystem_incompatible';
    default:
      return 'media_unavailable';
  }
};

const platformEjectGuidance: Record<string, string> = {
  macos: 'In Finder, click eject next to the USB volume and wait for disappear confirmation.',
  windows: 'Use Safely Remove Hardware in the system tray and wait for the safe-to-remove toast.',
  linux: 'Run a desktop eject action or `udisksctl power-off -b <device>` after unmount confirmation.',
};

const usbDurabilityProfile = [
  'Capacity headroom: keep at least 2x projected backup size free (minimum 4 GB free).',
  'Endurance: prefer high-endurance or enterprise-grade USB flash media rated for frequent rewrite cycles.',
  'Filesystem support: exFAT for cross-platform portability, APFS/ext4/NTFS for single-platform fleets.',
  'Write performance target: sustained sequential write >= 20 MB/s to reduce exposure window during flush.',
  'Operational policy: maintain two verified copies on separate devices with independent storage locations.',
];

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
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreBackoffEnabled, setRestoreBackoffEnabled] = useState(true);
  const [diagnosticBundle, setDiagnosticBundle] = useState<DiagnosticBundle | null>(null);
  const [activeError, setActiveError] = useState<ErrorIdentifier | null>(null);
  const [errorHistory, setErrorHistory] = useState<ErrorIdentifier[]>([]);
  const [operationState, setOperationState] = useState<OperationState>('idle');
  const [ejectChecks, setEjectChecks] = useState({ verified: false, restoreTest: false, flushComplete: false, duplicateMedia: false });
  const [reminderPolicy, setReminderPolicy] = useState<ReminderPolicy>(defaultReminderPolicy());
  const [runtimeShell, setRuntimeShell] = useState<RuntimeShell>('web-mock');
  const [runtimeProfile, setRuntimeProfileState] = useState<RuntimeProfile>('wb-simulation');
  const [flushStrategy, setFlushStrategy] = useState<CrashSafeWriteStep[]>([]);
  const [ejectCompleted, setEjectCompleted] = useState(false);
  const [performanceMeasurements, setPerformanceMeasurements] = useState<PerformanceMeasurement[]>([]);

  useEffect(() => {
    discoverRemovableDrives().then((result) => {
      setDiscovery(result);
      if (result.errors.length > 0) setActiveError(toUiError(result.errors[0].code));
    });
  }, []);
  useEffect(() => { setRuntimeProfileState(getRuntimeProfile()); setRuntimeShell(getRuntimeShell()); }, []);
  useEffect(() => { setReminderPolicy(loadReminderSettings()); setProfile(loadPortableProfile()); }, []);
  useEffect(() => { saveReminderSettings(reminderPolicy); }, [reminderPolicy]);
  useEffect(() => { if (profile) savePortableProfile(profile); }, [profile]);
  useEffect(() => { if (unlockDelayMs <= 0) return; const timer = setInterval(() => setUnlockDelayMs((v) => Math.max(0, v - 500)), 500); return () => clearInterval(timer); }, [unlockDelayMs]);
  useEffect(() => {
    if (!targetPath || discovery.drives.length === 0) return;
    const stillMounted = discovery.drives.some((drive) => drive.mountPath === targetPath);
    if (!stillMounted) {
      setActiveError('media_unavailable');
      setOperationState('action_required');
      setLogs((current) => [
        {
          at: new Date().toISOString(),
          action: 'media.disconnect.detected',
          status: 'warn',
          details: `Selected removable media ${targetPath} is no longer mounted. Reconnect before create/verify/restore.`,
        },
        ...current,
      ]);
    }
  }, [discovery, targetPath]);

  const selectedDrive = useMemo(() => discovery.drives.find((d) => d.mountPath === targetPath), [discovery, targetPath]);
  const mockRuntimeBlocked = runtimeShell !== 'tauri';
  const runtimeShellLabel = runtimeShell === 'tauri' ? 'Tauri bridge active' : 'WB simulation adapter';
  const safeToEject = useMemo(() => Object.values(ejectChecks).every(Boolean), [ejectChecks]);
  const decoyEntropy = estimateEntropyBits(decoyPassphrase);
  const criticalEntropy = estimateEntropyBits(criticalPassphrase);
  const appendLogs = (next: OperationLog[]) => setLogs((current) => [...next, ...current]);
  const nextReminderAt = useMemo(() => profile?.lastVerifiedAt ? getNextReminderAt(profile.lastVerifiedAt, reminderPolicy) : null, [profile, reminderPolicy]);
  const reminderDue = useMemo(() => nextReminderAt ? isReminderDue(nextReminderAt) : false, [nextReminderAt]);

  const recordPerformance = (operation: PerformanceMeasurement['operation'], elapsedMs: number, thresholdMs: number) => {
    const measurement: PerformanceMeasurement = {
      operation,
      elapsedMs,
      thresholdMs,
      status: elapsedMs <= thresholdMs ? 'ok' : 'warn',
      measuredAt: new Date().toISOString(),
    };
    setPerformanceMeasurements((current) => [measurement, ...current].slice(0, 12));
  };
  const hasCompleteFlushStrategy = (strategy: CrashSafeWriteStep[]) => {
    const seen = new Set(strategy.filter((step) => step.status === 'ok').map((step) => step.step));
    return REQUIRED_CRASH_SAFE_STEPS.every((step) => seen.has(step));
  };

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
    if (mockRuntimeBlocked) return setActiveError('media_unavailable');
    if (!selectedDrive) return setActiveError('path_invalid');
    if (!selectedDrive.writable) return setActiveError('mount_unwritable');
    if (selectedDrive.estimatedFreeGb < 4) return setActiveError('insufficient_space');
    if (selectedDrive && !isFilesystemRecommended(selectedDrive.filesystem)) return setActiveError('filesystem_incompatible');
    if (selectedRoles.includes('critical') && criticalEntropy < MIN_CRITICAL_ENTROPY) return setActiveError('critical_entropy_too_low');

    const request: BackupRequest = { targetPath, roles: selectedRoles, includeConsentReceipts, portableMode };
    setRunning(true); setActiveError(null); setOperationState('writing');
    const startedAt = performance.now();
    try { const result = await createBackup(request); setProfile(result.profile); appendLogs(result.log); setStage('verify'); setOperationState('verify_required');
      const elapsedMs = Math.round(performance.now() - startedAt);
      recordPerformance('create', elapsedMs, PERFORMANCE_TARGETS.create);
    } finally { setRunning(false); }
  };

  const runVerify = async () => {
    if (mockRuntimeBlocked) return setActiveError('media_unavailable');
    if (!profile) return;
    setRunning(true); setActiveError(null); setOperationState('preflight');
    const startedAt = performance.now();
    try {
      const result = await verifyBackup({
        targetPath,
        expectedVaultVersion: profile.schemaVersion,
        requireSignedManifest: true,
        manifestSignatureKeyId: 'citizen-wallet-maintainers:v1',
      });
      appendLogs(result.log); setVerifyResult(result); setProfile({ ...profile, lastVerifiedAt: result.verifiedAt });
      const tamperSignal = result.checks.find((check) => check.status === 'warn' && ['Header integrity', 'Slot inventory', 'Rollback counter'].includes(check.label));
      if (tamperSignal?.label === 'Header integrity') setActiveError('header_auth_failed');
      if (tamperSignal?.label === 'Slot inventory') setActiveError('slot_table_tampered');
      if (tamperSignal?.label === 'Rollback counter') setActiveError('rollback_counter_mismatch');
      setEjectChecks((p) => ({ ...p, verified: result.manifest.verified }));
      setStage('restore'); setOperationState(result.manifest.verified ? 'verified' : 'action_required');
      const elapsedMs = Math.round(performance.now() - startedAt);
      recordPerformance('verify', elapsedMs, PERFORMANCE_TARGETS.verify);
    } finally { setRunning(false); }
  };

  const runRestore = async () => {
    if (mockRuntimeBlocked) return setActiveError('media_unavailable');
    if (unlockDelayMs > 0) return;
    const expectedPassphrase = selectedRoles.includes('critical') ? criticalPassphrase : decoyPassphrase;
    if (!restorePassphrase || restorePassphrase !== expectedPassphrase) {
      if (restoreBackoffEnabled) {
        const nextFailures = unlockFailures + 1;
        const delay = BACKOFF_STEPS_MS[Math.min(nextFailures - 1, BACKOFF_STEPS_MS.length - 1)];
        setUnlockFailures(nextFailures);
        setUnlockDelayMs(delay);
      }
      setActiveError('decrypt_failed');
      return;
    }
    setRunning(true); setActiveError(null);
    const startedAt = performance.now();
    try { const result = await testRestore({ targetPath, role: 'critical', restoreIdentityKeys: true, restoreAccountKeys: true, restoreConsentReceipts: includeConsentReceipts }); appendLogs(result.log); setRestoreResult(result); setUnlockFailures(0); setEjectChecks((p) => ({ ...p, restoreTest: true })); setStage('eject');
      const elapsedMs = Math.round(performance.now() - startedAt);
      recordPerformance('restore', elapsedMs, PERFORMANCE_TARGETS.restore);
    } finally { setRunning(false); }
  };

  const simulateFailedUnlock = () => {
    const nextFailures = unlockFailures + 1;
    const delay = BACKOFF_STEPS_MS[Math.min(nextFailures - 1, BACKOFF_STEPS_MS.length - 1)];
    setUnlockFailures(nextFailures);
    setUnlockDelayMs(delay);
    setActiveError('decrypt_failed');
  };
  const runFlushWrites = async () => {
    setOperationState('flushing');
    const result = await flushPendingWritesWithStrategy(targetPath);
    appendLogs(result.logs);
    setFlushStrategy(result.strategy);
    const strategyComplete = hasCompleteFlushStrategy(result.strategy);
    setEjectChecks((p) => ({ ...p, flushComplete: strategyComplete }));
    if (!strategyComplete) {
      setActiveError('media_unavailable');
      setOperationState('action_required');
      return;
    }
    setOperationState('completed');
  };
  const runExportDiagnostics = async () => { if (profile) setDiagnosticBundle(await exportDiagnosticBundle(profile, logs.slice(0, 12), errorHistory, performanceMeasurements)); };
  const runSafeEject = async () => {
    const result = await safeEjectMedia(targetPath);
    appendLogs(result.logs);
    setEjectCompleted(result.ok);
  };
  const runRefreshDrives = async () => {
    const result = await discoverRemovableDrives();
    setDiscovery(result);
    if (result.errors.length > 0) {
      setActiveError(toUiError(result.errors[0].code));
      return;
    }
    if (result.drives.length === 0) {
      setActiveError('media_unavailable');
    }
  };

  useEffect(() => {
    if (!activeError) return;
    setOperationState('action_required');
    setErrorHistory((current) => [activeError, ...current].slice(0, 10));
  }, [activeError]);

  return <main className={highContrast ? 'shell high-contrast' : 'shell'}>
    <section className="hero card">
      <div>
        <p className="eyebrow">Citizen Recovery Vault</p>
        <h1>Vaultier</h1>
        <p className="subtitle">Portable encrypted backup vault for Citizen wallet recovery.</p>
      </div>
      <div className="hero-chips">
        <span className={runtimeShell === 'tauri' ? 'badge ok' : 'badge warn'}>{runtimeShellLabel}</span>
        <span className={safeToEject ? 'badge ok' : 'badge warn'}>{safeToEject ? 'Eject checklist complete' : 'Eject checklist pending'}</span>
        <span className={reminderDue ? 'badge warn' : 'badge ok'}>{reminderDue ? 'Verification due' : 'Verification cadence healthy'}</span>
      </div>
    </section>
    <section className="card" aria-live="polite"><h2>Backup workflow</h2><p className="subtitle">Portable encrypted backup vault for Citizen wallet recovery.</p>
      <article className="state-panel"><strong>{OPERATION_STATE_COPY[operationState].title}</strong><p className="hint">{OPERATION_STATE_COPY[operationState].detail}</p><p className="hint">Runtime shell: {runtimeShellLabel}.</p>{runtimeShell !== 'tauri' && <p className="summary warn">Production-grade USB write/flush protections require Tauri runtime bridge evidence. Mock runtime is for UX rehearsal only.</p>}{activeError && <div className="error-panel"><strong>Error code: {activeError}</strong><p>{ERROR_COPY[activeError].headline}</p><p className="hint">Next action: {ERROR_COPY[activeError].nextAction}</p></div>}</article>
      {runtimeShell !== 'tauri' && <p className="summary warn">Create/verify/restore/eject operations are blocked in web-mock mode. Launch under Tauri bridge for real media operations.</p>}
      {reminderDue && <p className="summary warn">Verification reminder is due. Run verify before relying on this media.</p>}
      <label>Runtime profile<select value={runtimeProfile} onChange={(e) => { const profile = e.target.value as RuntimeProfile; setRuntimeProfile(profile); setRuntimeProfileState(profile); setRuntimeShell(getRuntimeShell()); }}><option value="wb-simulation">WB simulation (default)</option><option value="tauri-runtime">Tauri runtime bridge</option></select></label>
      <label className="inline-control"><input type="checkbox" checked={highContrast} onChange={() => setHighContrast(!highContrast)} />High contrast</label>
      <nav className="stages">{STAGES.map((item) => <button key={item} className={stage === item ? 'pill active' : 'pill'} onClick={() => setStage(item)} disabled={!profile && item !== 'create'}>{item}</button>)}</nav>
      <label>Detected removable drives<select value={targetPath} onChange={(e) => setTargetPath(e.target.value)}>{discovery.drives.map((d) => <option key={d.id} value={d.mountPath}>{d.label} · {d.mountPath} · {d.filesystem} · {d.estimatedFreeGb}GB free</option>)}</select></label>
      <button onClick={runRefreshDrives} disabled={running}>Refresh media</button>
      {selectedDrive && <p className="hint">Filesystem policy: <strong>{isFilesystemRecommended(selectedDrive.filesystem) ? 'Recommended' : 'Higher risk'}</strong> · {selectedDrive.filesystem.toUpperCase()}</p>}
      <details>
        <summary>Recommended USB durability profile</summary>
        <ul className="log-list">{usbDurabilityProfile.map((item) => <li key={item}>{item}</li>)}</ul>
      </details>
      {discovery.errors.length > 0 && <p className="summary warn">Adapter notices: {discovery.errors.map((err) => `${err.code} (${err.mountPath})`).join(', ')}.</p>}

      {stage === 'create' && <><div className="row"><label className="inline-control"><input type="checkbox" checked={selectedRoles.includes('decoy')} onChange={() => setSelectedRoles((c) => c.includes('decoy') ? c.filter((x) => x !== 'decoy') : [...c, 'decoy'])} />Decoy slot</label><label className="inline-control"><input type="checkbox" checked={selectedRoles.includes('critical')} onChange={() => setSelectedRoles((c) => c.includes('critical') ? c.filter((x) => x !== 'critical') : [...c, 'critical'])} />Critical slot</label></div>
      <div className="row"><label className="inline-control"><input type="checkbox" checked={includeConsentReceipts} onChange={() => setIncludeConsentReceipts((v) => !v)} />Include consent receipts</label><label className="inline-control"><input type="checkbox" checked={portableMode} onChange={() => setPortableMode((v) => !v)} />Portable mode metadata</label></div>
      <div className="status-grid"><article className="status-card"><label>Decoy passphrase<input type="password" value={decoyPassphrase} onChange={(e) => setDecoyPassphrase(e.target.value)} /></label><progress max={100} value={Math.min(decoyEntropy, 100)} /><p className={`summary ${entropyBand(decoyEntropy).className}`}>Entropy {decoyEntropy} bits · {entropyBand(decoyEntropy).label}</p></article><article className="status-card"><label>Critical passphrase<input type="password" value={criticalPassphrase} onChange={(e) => setCriticalPassphrase(e.target.value)} /></label><progress max={100} value={Math.min(criticalEntropy, 100)} /><p className={`summary ${entropyBand(criticalEntropy).className}`}>Entropy {criticalEntropy} bits · {entropyBand(criticalEntropy).label}</p></article></div>
      <button disabled={running || selectedRoles.length === 0 || mockRuntimeBlocked} onClick={runCreateBackup}>Create Backup</button></>}
      {stage === 'verify' && <><button disabled={running || !profile || mockRuntimeBlocked} onClick={runVerify}>Verify Backup</button>{verifyResult && <><p className={verifyResult.checks.some((check) => check.status === 'warn') ? 'summary warn' : 'summary ok'}>{verifyResult.checks.length} deterministic checks completed at {verifyResult.verifiedAt}.</p><ul className="log-list">{verifyResult.checks.map((check) => <li key={check.label}>{check.label}: {check.status.toUpperCase()} · {check.detail}</li>)}</ul><p className={verifyResult.manifest.verified ? 'summary ok' : 'summary warn'}>Signed manifest: {verifyResult.manifest.verified ? `verified (${verifyResult.manifest.signatureKeyId})` : 'verification failed'}.</p></>}</>}
      {stage === 'restore' && <><label>Restore passphrase<input type="password" value={restorePassphrase} onChange={(e) => setRestorePassphrase(e.target.value)} /></label><label className="inline-control"><input type="checkbox" checked={restoreBackoffEnabled} onChange={() => setRestoreBackoffEnabled((value) => !value)} />Enable unlock retry backoff (CLI-aligned default)</label><div className="row"><button onClick={simulateFailedUnlock}>Simulate wrong passphrase</button><button disabled={running || unlockDelayMs > 0 || mockRuntimeBlocked} onClick={runRestore}>Test Restore</button></div>{unlockDelayMs > 0 && <p className="summary warn">Backoff active: {unlockDelayMs}ms. Repeated failures intentionally slow unlock retries.</p>}<p className="hint">Backoff schedule: {BACKOFF_STEPS_MS.join('ms -> ')}ms.</p>{restoreResult && <p className="summary ok">Recovered: {restoreResult.restoredArtifacts.join(', ')}</p>}</>}
      {stage === 'eject' && <><button onClick={runFlushWrites}>Flush pending writes</button><button onClick={runSafeEject} disabled={!safeToEject}>Run safe eject</button><label className="inline-control"><input type="checkbox" checked={ejectChecks.duplicateMedia} onChange={() => setEjectChecks((p) => ({ ...p, duplicateMedia: !p.duplicateMedia }))} />Duplicate backup stored separately</label><p className={safeToEject ? 'summary ok' : 'summary warn'}>{safeToEject ? 'Checklist complete. Safe to eject.' : 'Complete all checklist steps before ejection.'}</p>
      {ejectCompleted && <p className="summary ok">Safe eject completed. You can now remove the media.</p>}
      <p className="summary warn">Do not unplug during write/flush operations. Unexpected removal can corrupt vault headers and slot metadata.</p>
      {selectedDrive && <p className="hint">Safe eject guidance: {platformEjectGuidance[selectedDrive.platform]}</p>}
      {selectedDrive && <p className="hint">Filesystem compatibility note: preferred formats are exFAT, NTFS, APFS, or ext4 for cross-machine restore reliability.</p>}
      {flushStrategy.length > 0 && <details><summary>Crash-safe write strategy</summary><ul>{flushStrategy.map((step) => <li key={step.step}>{step.step} · {step.status} · {step.detail}</li>)}</ul></details>}</>}
    </section>
    <section className="card"><h2>Portable profile</h2>{profile ? <ul><li>Portable label: {profile.portableLabel}</li><li>Schema version: {profile.schemaVersion}</li><li>Created: {profile.createdAt}</li><li>Last Verification: {profile.lastVerifiedAt}</li><li>Next verification reminder: {nextReminderAt ?? 'Pending first verify'}</li></ul> : <p className="hint">Create a backup to generate a profile.</p>}
      <h3>Reminder policy</h3>
      <label className="inline-control"><input type="checkbox" checked={reminderPolicy.enabled} onChange={() => setReminderPolicy((p) => ({ ...p, enabled: !p.enabled }))} />Enable verification reminders</label>
      <label>Reminder cadence (days)<input type="number" min={7} max={365} value={reminderPolicy.cadenceDays} onChange={(e) => setReminderPolicy((p) => ({ ...p, cadenceDays: Number(e.target.value) || p.cadenceDays }))} /></label>
      <h3>Performance envelope</h3><p className="hint">Targets: create ≤ {PERFORMANCE_TARGETS.create}ms, verify ≤ {PERFORMANCE_TARGETS.verify}ms, restore ≤ {PERFORMANCE_TARGETS.restore}ms.</p>{performanceMeasurements.length > 0 ? <ul className="log-list">{performanceMeasurements.map((m) => <li key={`${m.operation}-${m.measuredAt}`}>{m.measuredAt} · {m.operation} · {m.elapsedMs}ms / {m.thresholdMs}ms · {m.status.toUpperCase()}</li>)}</ul> : <p className="hint">Run create/verify/restore to collect deterministic timing evidence logs.</p>}
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
