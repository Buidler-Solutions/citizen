import { useState } from 'react';
import { createBackup } from '../lib/mockVaultCore';
import type { BackupRequest, OperationLog, PortableProfile, VaultRole } from '../lib/types';

export function AppShell() {
  const [targetPath, setTargetPath] = useState('/Volumes/CITIZEN_USB');
  const [selectedRoles, setSelectedRoles] = useState<VaultRole[]>(['decoy', 'critical']);
  const [includeConsentReceipts, setIncludeConsentReceipts] = useState(true);
  const [portableMode, setPortableMode] = useState(true);
  const [running, setRunning] = useState(false);
  const [profile, setProfile] = useState<PortableProfile | null>(null);
  const [logs, setLogs] = useState<OperationLog[]>([]);

  const toggleRole = (role: VaultRole) => {
    setSelectedRoles((current) =>
      current.includes(role) ? current.filter((item) => item !== role) : [...current, role]
    );
  };

  const runCreateBackup = async () => {
    const request: BackupRequest = { targetPath, roles: selectedRoles, includeConsentReceipts, portableMode };
    setRunning(true);
    const result = await createBackup(request);
    setProfile(result.profile);
    setLogs(result.log);
    setRunning(false);
  };

  return (
    <main className="shell">
      <section className="card">
        <h1>Vaultier</h1>
        <p className="subtitle">Portable encrypted backup vault for Citizen wallet recovery.</p>
        <label>
          USB Target Path
          <input value={targetPath} onChange={(e) => setTargetPath(e.target.value)} />
        </label>
        <div className="row">
          <label><input type="checkbox" checked={selectedRoles.includes('decoy')} onChange={() => toggleRole('decoy')} /> Decoy slot</label>
          <label><input type="checkbox" checked={selectedRoles.includes('critical')} onChange={() => toggleRole('critical')} /> Critical slot</label>
        </div>
        <div className="row">
          <label><input type="checkbox" checked={includeConsentReceipts} onChange={() => setIncludeConsentReceipts(!includeConsentReceipts)} /> Include consent artifacts</label>
          <label><input type="checkbox" checked={portableMode} onChange={() => setPortableMode(!portableMode)} /> Portable mode metadata</label>
        </div>
        <button disabled={running || selectedRoles.length === 0} onClick={runCreateBackup}>
          {running ? 'Creating backup...' : 'Create Backup'}
        </button>
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
