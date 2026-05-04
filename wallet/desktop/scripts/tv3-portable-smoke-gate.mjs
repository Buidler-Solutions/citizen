#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const evidenceDir = path.resolve(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');
const now = new Date().toISOString();
const ts = now.replace(/[:]/g, '-');
const allowIncomplete = process.argv.includes('--allow-incomplete');

const targets = ['linux', 'darwin', 'win32'];
const targetLabels = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

function latestSmokeForHost(host) {
  const prefix = 'TV3_PORTABLE_SMOKE_SUITE_';
  const files = readdirSync(evidenceDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .reverse();

  for (const file of files) {
    const data = JSON.parse(readFileSync(path.join(evidenceDir, file), 'utf8'));
    if (data?.schema !== 'citizen.wallet.desktop.tv3.portable-smoke-suite.v1') continue;
    if (data?.host !== host) continue;
    return { file, data };
  }
  return null;
}

const report = {
  schema: 'citizen.wallet.desktop.tv3.cross-platform-smoke-gate.v1',
  generated_at: now,
  allow_incomplete: allowIncomplete,
  targets: [],
};

let failed = false;
for (const host of targets) {
  const latest = latestSmokeForHost(host);
  if (!latest) {
    failed = true;
    report.targets.push({ host, label: targetLabels[host], status: 'missing', reason: 'no smoke evidence found' });
    continue;
  }

  const status = latest.data?.summary?.status === 'pass' ? 'pass' : 'fail';
  if (status !== 'pass') failed = true;
  report.targets.push({
    host,
    label: targetLabels[host],
    status,
    evidence_file: latest.file,
    generated_at: latest.data.generated_at ?? null,
    summary: latest.data.summary ?? null,
  });
}

report.summary = {
  status: failed ? 'fail' : 'pass',
  passed: report.targets.filter((t) => t.status === 'pass').length,
  missing: report.targets.filter((t) => t.status === 'missing').length,
  failed: report.targets.filter((t) => t.status === 'fail').length,
};

const outPath = path.join(evidenceDir, `TV3_CROSS_PLATFORM_SMOKE_GATE_${ts}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({ status: report.summary.status, report_path: outPath, summary: report.summary }, null, 2));
process.exit(failed && !allowIncomplete ? 1 : 0);
