#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const evidenceDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');
const outputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(evidenceDir, `TV3_COMPLETION_GATE_STATUS_${new Date().toISOString().slice(0, 10)}.json`);

const requiredArtifacts = {
  linux: /linux/i,
  macos: /(mac|darwin|osx)/i,
  windows: /(win|windows)/i,
};

const requiredAudits = {
  linux: /linux.*audit|audit.*linux/i,
  macos: /(mac|darwin|osx).*(audit)|audit.*(mac|darwin|osx)/i,
  windows: /windows.*audit|audit.*windows|win.*audit/i,
};

async function readManifests(dir) {
  const files = await fs.readdir(dir);
  const manifestNames = files.filter((name) => /TV3_ARTIFACT_MANIFEST_.*\.json$/i.test(name)).sort();
  const manifests = [];
  for (const name of manifestNames) {
    const full = path.join(dir, name);
    const raw = await fs.readFile(full, 'utf8');
    const parsed = JSON.parse(raw);
    manifests.push({ name, full, parsed });
  }
  return manifests;
}

(async () => {
  const files = await fs.readdir(evidenceDir);
  const manifests = await readManifests(evidenceDir);
  const latestManifest = manifests.at(-1);

  const artifactStatus = Object.fromEntries(
    Object.entries(requiredArtifacts).map(([os, rx]) => {
      const found = latestManifest?.parsed?.artifacts?.some((artifact) => rx.test(String(artifact.filename ?? '')));
      return [os, Boolean(found)];
    })
  );

  const auditStatus = Object.fromEntries(
    Object.entries(requiredAudits).map(([os, rx]) => {
      const found = files.some((name) => rx.test(name));
      return [os, Boolean(found)];
    })
  );

  const summary = {
    contract: 'citizen.wallet.desktop.tv3.gate-status.v1',
    generated_at: new Date().toISOString(),
    evidence_dir: evidenceDir,
    latest_artifact_manifest: latestManifest ? latestManifest.name : null,
    gates: {
      artifacts: artifactStatus,
      audits: auditStatus,
      complete:
        Object.values(artifactStatus).every(Boolean) &&
        Object.values(auditStatus).every(Boolean),
    },
    next_actions: [
      ...Object.entries(artifactStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `attach signed ${os} artifact set in latest TV3 artifact manifest`),
      ...Object.entries(auditStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `attach ${os} bridge audit evidence file in wallet-backup-vault evidence directory`),
    ],
  };

  await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`tv3-completion-gate-check: wrote ${outputPath}`);

  if (!summary.gates.complete) {
    process.exitCode = 2;
  }
})();
