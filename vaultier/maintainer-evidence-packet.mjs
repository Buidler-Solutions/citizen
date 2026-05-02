#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('.', import.meta.url).pathname, '..');
const outDir = resolve(repoRoot, 'citizen-protocol', 'docs', 'evidence', 'wallet-backup-vault');
mkdirSync(outDir, { recursive: true });

const commands = [
  {
    name: 'wallet-backup-regression',
    cmd: ['cargo', 'test', '-p', 'citizen-wallet', 'backup', '--', '--nocapture'],
    cwd: resolve(repoRoot, 'citizen-protocol'),
  },
  {
    name: 'wallet-backup-performance-harness',
    cmd: ['cargo', 'test', '-p', 'citizen-wallet', 'backup_command_path_performance_evidence_harness', '--', '--ignored', '--nocapture'],
    cwd: resolve(repoRoot, 'citizen-protocol'),
  },
  {
    name: 'vaultier-priority-gap',
    cmd: ['pnpm', 'check:priority-gap'],
    cwd: resolve(repoRoot, 'vaultier'),
  },
];

const now = new Date().toISOString().replace(/[:]/g, '-');
const packet = {
  generated_at: new Date().toISOString(),
  generated_by: 'vaultier/maintainer-evidence-packet.mjs',
  commands: [],
};

for (const entry of commands) {
  const [bin, ...args] = entry.cmd;
  const run = spawnSync(bin, args, {
    cwd: entry.cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });

  const commandLine = entry.cmd.join(' ');
  const logPath = resolve(outDir, `${now}-${entry.name}.log`);
  const combined = [`$ ${commandLine}`, '', run.stdout ?? '', run.stderr ?? ''].join('\n');
  writeFileSync(logPath, combined, 'utf8');

  packet.commands.push({
    name: entry.name,
    command: commandLine,
    cwd: entry.cwd,
    exit_code: run.status ?? 1,
    signal: run.signal ?? null,
    log_file: logPath,
    passed: run.status === 0,
  });
}

const summaryPath = resolve(outDir, `${now}-summary.json`);
writeFileSync(summaryPath, JSON.stringify(packet, null, 2), 'utf8');

const mdPath = resolve(outDir, `${now}-summary.md`);
const lines = [
  '# Wallet Backup Vault Maintainer Evidence Packet',
  '',
  `Generated at: ${packet.generated_at}`,
  '',
  '| Check | Command | Exit | Log |',
  '| --- | --- | --- | --- |',
  ...packet.commands.map((c) => `| ${c.name} | \`${c.command}\` | ${c.exit_code} | \`${c.log_file}\` |`),
  '',
  '> Note: a non-zero exit in `vaultier-priority-gap` is expected until Checkpoint 8.5 exit criteria are maintainer-approved.',
];
writeFileSync(mdPath, lines.join('\n'), 'utf8');

const failures = packet.commands.filter((c) => !c.passed && c.name !== 'vaultier-priority-gap');
console.log(`evidence packet summary: ${summaryPath}`);
console.log(`evidence packet markdown: ${mdPath}`);

if (failures.length > 0) {
  console.error('evidence packet generation failed due to required command failures:');
  for (const f of failures) {
    console.error(` - ${f.name} (exit ${f.exit_code})`);
  }
  process.exit(1);
}
