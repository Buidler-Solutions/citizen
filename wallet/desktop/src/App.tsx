import { useState } from "react";

type BackupResponse = {
  contract_version: string;
  status: string;
  error_id?: string | null;
  details: Record<string, unknown>;
};

type JsonRecord = Record<string, unknown>;

const backupCommands = [
  "backup_init",
  "backup_add_slot",
  "backup_export_credentials",
  "backup_verify",
  "backup_restore",
  "backup_diagnostics",
] as const;

const utilityCommands = ["discover_removable_drives", "flush_vault_writes", "safe_eject_media"] as const;

type DesktopCommand = (typeof backupCommands)[number] | (typeof utilityCommands)[number];

async function invokeDesktop(command: DesktopCommand, payload: JsonRecord = {}): Promise<unknown> {
  const tauriInvoke = (globalThis as { __TAURI__?: { core?: { invoke?: Function } } }).__TAURI__?.core?.invoke;
  if (!tauriInvoke) {
    return {
      contract_version: "citizen.wallet.backup.desktop.v1alpha1",
      status: "error",
      error_id: "tauri_unavailable",
      details: { message: "Tauri runtime unavailable. Run with `pnpm tauri:dev`." },
    } satisfies BackupResponse;
  }

  return tauriInvoke(command, { payload });
}

export function App() {
  const [selected, setSelected] = useState<DesktopCommand>("backup_init");
  const [response, setResponse] = useState<unknown>(null);
  const [targetPath, setTargetPath] = useState<string>("");

  async function runSelectedCommand() {
    const payload: JsonRecord = {
      source: "vaultier-desktop-ui",
      args: [],
    };

    if (selected === "flush_vault_writes" || selected === "safe_eject_media") {
      payload.targetPath = targetPath.trim();
    }

    const result = await invokeDesktop(selected, payload);
    setResponse(result);
  }

  return (
    <main className="shell">
      <h1>Vaultier Desktop Bridge</h1>
      <p>Desktop runtime for Citizen wallet backup operations (Tauri-first).</p>
      <div className="controls">
        <select value={selected} onChange={(e) => setSelected(e.target.value as DesktopCommand)}>
          <optgroup label="Wallet backup">
            {backupCommands.map((cmd) => (
              <option key={cmd} value={cmd}>
                {cmd}
              </option>
            ))}
          </optgroup>
          <optgroup label="USB safety utilities">
            {utilityCommands.map((cmd) => (
              <option key={cmd} value={cmd}>
                {cmd}
              </option>
            ))}
          </optgroup>
        </select>
        <button onClick={runSelectedCommand}>Run Command</button>
      </div>

      {(selected === "flush_vault_writes" || selected === "safe_eject_media") && (
        <label>
          Target path for removable media operation
          <input
            type="text"
            placeholder="/media/operator/citizen-backups"
            value={targetPath}
            onChange={(event) => setTargetPath(event.target.value)}
          />
        </label>
      )}

      <aside>
        <strong>USB safety:</strong> Always wait for flush completion before unplugging removable media,
        then use your OS safe-eject workflow.
      </aside>
      <pre>{response ? JSON.stringify(response, null, 2) : "No command executed yet."}</pre>
    </main>
  );
}
