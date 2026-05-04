#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const checklistPath = path.join(
  repoRoot,
  'citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md',
);

const text = fs.readFileSync(checklistPath, 'utf8');
const allowIncomplete = process.argv.includes('--allow-incomplete');
const strict = process.argv.includes('--strict');
const startMarker = '## Portable Application Track (Working + Sleek)';
const endMarker = '## Checkpoint 9 — Rollout Plan';
const start = text.indexOf(startMarker);
const end = text.indexOf(endMarker);

if (start === -1 || end === -1 || end <= start) {
  console.error(
    JSON.stringify(
      {
        schema: 'citizen.wallet.desktop.tv3.portable-track-gap-report.v1',
        status: 'error',
        error: 'portable_track_section_not_found',
        checklist_path: path.relative(repoRoot, checklistPath),
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const section = text.slice(start, end);
const lines = section.split('\n');
const pending = [];
const inProgress = [];

for (const line of lines) {
  const item = line.match(/^\s*[-*]\s*\[( |~)\]\s+(.*)$/);
  if (!item) continue;
  const status = item[1] === ' ' ? 'pending' : 'in_progress';
  const value = item[2].trim();
  if (status === 'pending') pending.push(value);
  else inProgress.push(value);
}

const report = {
  schema: 'citizen.wallet.desktop.tv3.portable-track-gap-report.v1',
  generated_at: new Date().toISOString(),
  checklist_path: path.relative(repoRoot, checklistPath),
  section: startMarker,
  summary: {
    pending_count: pending.length,
    in_progress_count: inProgress.length,
    status: pending.length === 0 && inProgress.length === 0 ? 'complete' : 'gaps_remaining',
  },
  pending,
  in_progress: inProgress,
};

console.log(JSON.stringify(report, null, 2));
if (allowIncomplete || !strict) {
  process.exit(0);
}
process.exit(report.summary.status === 'complete' ? 0 : 2);
