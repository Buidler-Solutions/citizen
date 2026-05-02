import { useMemo, useState } from "react";

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

const commandArgHints: Record<DesktopCommand, string> = {
  backup_init: "--vault-path /media/operator/citizen-vault.json --role critical --json",
  backup_add_slot: "--vault-path /media/operator/citizen-vault.json --role decoy --json",
  backup_export_credentials:
    "--vault-path /media/operator/citizen-vault.json --role critical --include-identity --include-accounts --json",
  backup_verify: "--vault-path /media/operator/citizen-vault.json --role critical --json",
  backup_restore: "--vault-path /media/operator/citizen-vault.json --role critical --json",
  backup_diagnostics: "--vault-path /media/operator/citizen-vault.json --json",
  discover_removable_drives: "No args required.",
  flush_vault_writes: "Provide target path below and optionally set args such as --force.",
  safe_eject_media: "Provide target path below and optionally set args such as --force.",
};

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

function parseArgs(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  const args: string[] = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;

  for (const match of trimmed.matchAll(tokenPattern)) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }

  return args;
}

export function App() {
  const [selected, setSelected] = useState<DesktopCommand>("backup_init");
  const [response, setResponse] = useState<unknown>(null);
  const [targetPath, setTargetPath] = useState<string>("");
  const [argsInput, setArgsInput] = useState<string>(commandArgHints.backup_init);
  const [uiError, setUiError] = useState<string | null>(null);

  const isPathCommand = selected === "flush_vault_writes" || selected === "safe_eject_media";
  const argHint = useMemo(() => commandArgHints[selected], [selected]);

  async function runSelectedCommand() {
    setUiError(null);
    const payload: JsonRecord = {
      source: "vaultier-desktop-ui",
      args: parseArgs(argsInput),
    };

    if (isPathCommand) {
      const normalizedPath = targetPath.trim();
      if (!normalizedPath) {
        setUiError("Target path is required for removable-media commands.");
        return;
      }
      payload.targetPath = normalizedPath;
    }

    const result = await invokeDesktop(selected, payload);
    setResponse(result);
  }

  function handleCommandChange(next: DesktopCommand) {
    setSelected(next);
    setArgsInput(commandArgHints[next]);
    setResponse(null);
    setUiError(null);
  }

  return (
    <main className="shell">
      <h1>Vaultier Desktop Bridge</h1>
      <p>Desktop runtime for Citizen wallet backup operations (Tauri-first).</p>
      <div className="controls">
        <select value={selected} onChange={(e) => handleCommandChange(e.target.value as DesktopCommand)}>
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

      <label>
        CLI args passed via desktop bridge
        <input
          type="text"
          placeholder={argHint}
          value={argsInput}
          onChange={(event) => setArgsInput(event.target.value)}
        />
      </label>

      {isPathCommand && (
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

      {uiError && <p role="alert">{uiError}</p>}

      <aside>
        <strong>USB safety:</strong> Always wait for flush completion before unplugging removable media,
        then use your OS safe-eject workflow.
      </aside>
      <pre>{response ? JSON.stringify(response, null, 2) : "No command executed yet."}</pre>
    </main>
  );
}
