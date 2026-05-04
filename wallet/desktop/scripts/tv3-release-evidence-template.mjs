#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const evidenceDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');

const dateStamp = new Date().toISOString().slice(0, 10);

function normalizeOs(value) {
  const os = String(value ?? '').toLowerCase();
  if (os === 'darwin' || os === 'osx') return 'macos';
  return os;
}

async function readLatestManifest(dir) {
  const names = (await fs.readdir(dir))
    .filter((name) => /^TV3_ARTIFACT_MANIFEST_.*\.json$/i.test(name))
    .sort();

  if (!names.length) {
    throw new Error('no TV3 artifact manifest found in evidence directory');
  }

  const latest = names.at(-1);
  const fullPath = path.join(dir, latest);
  const raw = await fs.readFile(fullPath, 'utf8');
  return { name: latest, fullPath, parsed: JSON.parse(raw) };
}

function latestAuditFile(files, os) {
  const pattern = new RegExp(`^TV3_${os.toUpperCase()}_BRIDGE_AUDIT_EVIDENCE_.*\\.md$`, 'i');
  return files.filter((name) => pattern.test(name)).sort().at(-1) ?? `TV3_${os.toUpperCase()}_BRIDGE_AUDIT_EVIDENCE_${dateStamp}.md`;
}

function buildArtifactLines(artifacts) {
  if (!artifacts.length) {
    return ['- No artifact entries found in latest manifest.'];
  }

  return artifacts.map((artifact) => {
    const filename = String(artifact.filename ?? 'UNSET');
    const sha = String(artifact.sha256 ?? 'UNSET');
    const signedBy = String(artifact.signing_identity ?? 'UNSET');
    const target = `${String(artifact.target_os ?? 'UNSET')}/${String(artifact.target_arch ?? 'UNSET')}`;
    const immutableUri = String(artifact.immutable_uri ?? 'UNSET');
    const sizeBytes = String(artifact.size_bytes ?? 'UNSET');

    return `- ${filename} | target=${target} | sha256=${sha} | signing_identity=${signedBy} | size_bytes=${sizeBytes} | immutable_uri=${immutableUri}`;
  });
}

(async () => {
  const manifest = await readLatestManifest(evidenceDir);
  const files = await fs.readdir(evidenceDir);

  const osBuckets = { linux: [], macos: [], windows: [] };
  for (const artifact of manifest.parsed.artifacts ?? []) {
    const os = normalizeOs(artifact.target_os);
    if (os in osBuckets) {
      osBuckets[os].push(artifact);
    }
  }

  const outputPath = path.join(evidenceDir, `TV3_RELEASE_EVIDENCE_TEMPLATE_${dateStamp}.md`);
  const lines = [
    '# TV-3 Release Evidence Template',
    '',
    `- Generated on: ${new Date().toISOString()}`,
    `- Source manifest: ${manifest.name}`,
    '',
    '## Packaging Evidence Cross-links',
    '',
    '- R9-D sign-off URI: UNSET',
    '- Consolidated maintainer sign-off URI: UNSET',
    '',
    '## Per-OS Signed Artifact Sets',
    '',
    '### Linux artifacts',
    ...buildArtifactLines(osBuckets.linux),
    '',
    '### macOS artifacts',
    ...buildArtifactLines(osBuckets.macos),
    '',
    '### Windows artifacts',
    ...buildArtifactLines(osBuckets.windows),
    '',
    '## Required Bridge Audit Evidence Files',
    '',
    `- Linux audit evidence file: ${latestAuditFile(files, 'linux')}`,
    `- macOS audit evidence file: ${latestAuditFile(files, 'macos')}`,
    `- Windows audit evidence file: ${latestAuditFile(files, 'windows')}`,
    '',
    '## Completion Notes',
    '',
    '- Replace all `UNSET` values before checkpoint-9 R9-D handoff.',
    '- Keep immutable HTTPS links aligned with the latest TV3 artifact manifest entries.',
  ];

  await fs.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`tv3-release-evidence-template: wrote ${outputPath}`);
})();
