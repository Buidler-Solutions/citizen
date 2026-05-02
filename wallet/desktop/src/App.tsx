import { useState } from "react";

type BackupResponse = {
  contract_version: string;
  status: string;
  error_id?: string | null;
  details: Record<string, unknown>;
};

const commands = [
  "backup_init",
  "backup_add_slot",
  "backup_export_credentials",
  "backup_verify",
  "backup_restore",
] as const;

async function invokeDesktop(command: string): Promise<BackupResponse> {
  const tauriInvoke = (globalThis as { __TAURI__?: { core?: { invoke?: Function } } }).__TAURI__?.core?.invoke;
  if (!tauriInvoke) {
    return {
      contract_version: "citizen.wallet.backup.desktop.v1alpha1",
      status: "error",
      error_id: "tauri_unavailable",
      details: { message: "Tauri runtime unavailable. Run with `pnpm tauri:dev`." },
    };
  }

  return tauriInvoke("run_backup_command", {
    request: { command, payload: { source: "vaultier-desktop-ui" } },
  });
}

export function App() {
  const [selected, setSelected] = useState<string>("backup_init");
  const [response, setResponse] = useState<BackupResponse | null>(null);

  return (
    <main className="shell">
      <h1>Vaultier Desktop Bridge</h1>
      <p>Desktop runtime for Citizen wallet backup operations (Tauri-first).</p>
      <div className="controls">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {commands.map((cmd) => (
            <option key={cmd} value={cmd}>
              {cmd}
            </option>
          ))}
        </select>
        <button
          onClick={async () => {
            const result = await invokeDesktop(selected);
            setResponse(result);
          }}
        >
          Run Command
        </button>
      </div>
      <pre>{response ? JSON.stringify(response, null, 2) : "No command executed yet."}</pre>
    </main>
  );
}
