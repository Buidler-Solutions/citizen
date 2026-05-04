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
const hostToEvidenceOs = { linux: 'linux', darwin: 'macos', win32: 'windows' };

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


function latestSignedEvidenceForOs(os) {
  const prefix = `TV3_${os.toUpperCase()}_PORTABLE_SMOKE_SIGNED_EVIDENCE_`;
  const files = readdirSync(evidenceDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .sort()
    .reverse();

  for (const file of files) {
    const body = readFileSync(path.join(evidenceDir, file), 'utf8');
    const immutableLog = /Immutable signed smoke log URI \(HTTPS\): `([^`]+)`/.exec(body)?.[1] ?? 'UNSET';
    const immutableDigest = /Immutable digest URI \(HTTPS\): `([^`]+)`/.exec(body)?.[1] ?? 'UNSET';
    const reviewer = /Reviewer name: `([^`]+)`/.exec(body)?.[1] ?? 'UNSET';
    const reviewedOn = /Reviewed on \(YYYY-MM-DD\): `([^`]+)`/.exec(body)?.[1] ?? 'UNSET';

    const complete = [immutableLog, immutableDigest, reviewer, reviewedOn].every((v) => v && v !== 'UNSET');
    return { file, complete, immutableLog, immutableDigest, reviewer, reviewedOn };
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

  let status = latest.data?.summary?.status === 'pass' ? 'pass' : 'fail';
  const signedEvidence = latestSignedEvidenceForOs(hostToEvidenceOs[host]);
  if (!signedEvidence) {
    status = 'missing';
  } else if (!signedEvidence.complete) {
    status = 'fail';
  }

  if (status !== 'pass') failed = true;
  report.targets.push({
    host,
    label: targetLabels[host],
    status,
    evidence_file: latest.file,
    signed_evidence_file: signedEvidence?.file ?? null,
    signed_evidence_complete: signedEvidence?.complete ?? false,
    generated_at: latest.data.generated_at ?? null,
    summary: latest.data.summary ?? null,
    reason: !signedEvidence
      ? 'signed smoke evidence markdown missing'
      : (signedEvidence.complete ? null : 'signed smoke evidence has UNSET required fields'),
  });
}

const strictStatus = failed ? 'fail' : 'pass';
const effectiveStatus = allowIncomplete && strictStatus === 'fail' ? 'warn' : strictStatus;

report.summary = {
  status: effectiveStatus,
  strict_status: strictStatus,
  passed: report.targets.filter((t) => t.status === 'pass').length,
  missing: report.targets.filter((t) => t.status === 'missing').length,
  failed: report.targets.filter((t) => t.status === 'fail').length,
  allow_incomplete_note: allowIncomplete && strictStatus === 'fail'
    ? 'non-pass status tolerated because --allow-incomplete was supplied'
    : null,
};

const outPath = path.join(evidenceDir, `TV3_CROSS_PLATFORM_SMOKE_GATE_${ts}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({ status: report.summary.status, report_path: outPath, summary: report.summary }, null, 2));
process.exit(failed && !allowIncomplete ? 1 : 0);
