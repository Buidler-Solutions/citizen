#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const evidenceDir = path.resolve(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');
const cargoManifest = path.resolve(repoRoot, 'citizen-protocol/Cargo.toml');
const vaultierDir = path.resolve(repoRoot, 'vaultier');
const ts = new Date().toISOString().replace(/[:]/g, '-');

const allowFailures = process.argv.includes('--allow-failures');

const checks = [
  {
    id: 'wb_mode_contract_gate',
    command: ['pnpm', 'test:headless-contract'],
    cwd: vaultierDir,
    note: 'Exercises init/add-slot/export/verify/restore contract coverage and eject guidance copy checks.',
    recovery: ['pnpm', 'install', '--frozen-lockfile'],
  },
  {
    id: 'wallet_backup_regressions',
    command: ['cargo', 'test', '--manifest-path', cargoManifest, '-p', 'citizen-wallet', 'wallet_backup'],
    note: 'Covers wallet backup command-path regressions used by desktop runtime bridge parity checks.',
  },
];

function spawn(command, cwd) {
  const [bin, ...args] = command;
  const startedAt = new Date().toISOString();
  const result = spawnSync(bin, args, {
    cwd: cwd ?? repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const endedAt = new Date().toISOString();
  return {
    status: result.status === 0 ? 'pass' : 'fail',
    exit_code: result.status,
    started_at: startedAt,
    ended_at: endedAt,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal ?? null,
    error_message: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function run(check) {
  const firstAttempt = spawn(check.command, check.cwd);
  if (firstAttempt.status === 'pass' || !check.recovery) {
    return { ...firstAttempt, attempts: 1, recovered: false };
  }

  const recoveryAttempt = spawn(check.recovery, check.cwd);
  if (recoveryAttempt.status === 'fail') {
    return {
      ...firstAttempt,
      attempts: 2,
      recovered: false,
      recovery: {
        command: check.recovery.join(' '),
        ...recoveryAttempt,
      },
    };
  }

  const secondAttempt = spawn(check.command, check.cwd);
  return {
    ...secondAttempt,
    attempts: 2,
    recovered: secondAttempt.status === 'pass',
    recovery: {
      command: check.recovery.join(' '),
      ...recoveryAttempt,
    },
  };
}

if (!existsSync(cargoManifest)) {
  console.error(`portable-smoke-suite: missing cargo manifest at ${cargoManifest}`);
  process.exit(2);
}

const report = {
  schema: 'citizen.wallet.desktop.tv3.portable-smoke-suite.v1',
  generated_at: new Date().toISOString(),
  host: process.platform,
  allow_failures: allowFailures,
  checks: [],
};

let hasFailure = false;
for (const check of checks) {
  const result = run(check);
  report.checks.push({
    id: check.id,
    command: check.command.join(' '),
    note: check.note,
    ...result,
  });
  if (result.status !== 'pass') hasFailure = true;
}

report.summary = {
  total: report.checks.length,
  passed: report.checks.filter((c) => c.status === 'pass').length,
  failed: report.checks.filter((c) => c.status === 'fail').length,
  status: hasFailure ? 'fail' : 'pass',
};

mkdirSync(evidenceDir, { recursive: true });
const reportPath = path.join(evidenceDir, `TV3_PORTABLE_SMOKE_SUITE_${ts}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

if (hasFailure) {
  const failed = report.checks.filter((c) => c.status === 'fail');
  console.error('portable-smoke-suite: failing checks');
  for (const item of failed) {
    console.error(`- ${item.id} (exit=${item.exit_code}, signal=${item.signal ?? 'none'}, attempts=${item.attempts ?? 1})`);
    const combined = `${item.stderr || ''}\n${item.stdout || ''}`.trim();
    if (combined) {
      const tail = combined.split('\n').slice(-20).join('\n');
      console.error('  output tail:');
      console.error(tail.replace(/^/gm, '    '));
    }
    if (item.recovery?.status === 'fail') {
      console.error(`  recovery command failed: ${item.recovery.command}`);
    }
    if (item.error_message) {
      console.error(`  error: ${item.error_message}`);
    }
  }
}

console.log(JSON.stringify({ status: report.summary.status, report_path: reportPath, summary: report.summary }, null, 2));
process.exit(hasFailure && !allowFailures ? 1 : 0);
