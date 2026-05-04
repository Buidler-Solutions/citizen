#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const evidenceDir = path.resolve(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');
const now = new Date().toISOString();
const ts = now.replace(/[:]/g, '-');

const targets = [
  { host: 'linux', label: 'Linux' },
  { host: 'darwin', label: 'macOS' },
  { host: 'win32', label: 'Windows' },
];

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

const sections = targets.map((target) => {
  const latest = latestSmokeForHost(target.host);
  const summary = latest?.data?.summary ?? null;
  const checks = Array.isArray(latest?.data?.checks) ? latest.data.checks : [];
  const checkLines = checks.length
    ? checks.map((check) => `- ${check.id}: ${check.status} (command: \`${check.command}\`)`).join('\n')
    : '- UNSET: attach the latest smoke suite JSON for this host.';

  return [
    `### ${target.label}`,
    `- Latest smoke suite JSON: \`${latest?.file ?? 'UNSET'}\``,
    `- Generated at: ${latest?.data?.generated_at ?? 'UNSET'}`,
    `- Summary status: ${summary?.status ?? 'UNSET'}`,
    '- Immutable release artifact URI: UNSET',
    '- Reviewer sign-off (name/date): UNSET',
    '- Command checks:',
    checkLines,
  ].join('\n');
});

const body = [
  `# TV3 Portable Smoke Evidence Template (${now})`,
  '',
  'Schema: `citizen.wallet.desktop.tv3.portable-smoke-evidence.v1`',
  '',
  'Use this template to attach the first signed cross-platform smoke evidence snapshots referenced by the portable-track checklist.',
  '',
  '## Evidence Summary',
  '',
  sections.join('\n\n'),
  '',
  '## Checklist Cross-Links',
  '',
  '- Portable Application Track exit criteria smoke gate reference: citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md',
  '- R9-D release checklist sign-off packet: UNSET',
  '- Consolidated maintainer sign-off URI: UNSET',
  '',
].join('\n');

const outPath = path.join(evidenceDir, `TV3_PORTABLE_SMOKE_EVIDENCE_TEMPLATE_${ts}.md`);
writeFileSync(outPath, body, 'utf8');

console.log(JSON.stringify({ status: 'ok', report_path: outPath }, null, 2));
