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

const requiredManifestFields = [
  'filename',
  'sha256',
  'signing_identity',
  'build_timestamp',
  'target_os',
  'target_arch',
  'immutable_uri',
];

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
      const found = latestManifest?.parsed?.artifacts?.some((artifact) => {
        const filename = String(artifact.filename ?? '');
        const signingIdentity = String(artifact.signing_identity ?? '');
        return rx.test(filename) && signingIdentity && signingIdentity !== 'UNSET';
      });
      return [os, Boolean(found)];
    })
  );

  const manifestFieldStatus = Object.fromEntries(
    requiredManifestFields.map((field) => {
      const present = latestManifest?.parsed?.artifacts?.every((artifact) => {
        const value = artifact?.[field];
        return value !== undefined && value !== null && String(value).trim() !== '';
      });
      return [field, Boolean(present)];
    })
  );

  const manifestDigestStatus = Object.fromEntries(
    Object.keys(requiredArtifacts).map((os) => {
      const osArtifacts = (latestManifest?.parsed?.artifacts ?? []).filter(
        (artifact) => String(artifact.target_os ?? '').toLowerCase() === os
      );
      const allSha256 = osArtifacts.every((artifact) => /^[a-f0-9]{64}$/i.test(String(artifact.sha256 ?? '')));
      return [os, osArtifacts.length > 0 && allSha256];
    })
  );


  const immutableUriStatus = Object.fromEntries(
    Object.keys(requiredArtifacts).map((os) => {
      const osArtifacts = (latestManifest?.parsed?.artifacts ?? []).filter(
        (artifact) => String(artifact.target_os ?? '').toLowerCase() === os
      );
      const allImmutableUris = osArtifacts.every((artifact) =>
        /^https:\/\//i.test(String(artifact.immutable_uri ?? ''))
      );
      return [os, osArtifacts.length > 0 && allImmutableUris];
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
      manifest_fields: manifestFieldStatus,
      manifest_sha256: manifestDigestStatus,
      immutable_uris: immutableUriStatus,
      audits: auditStatus,
      complete:
        Object.values(artifactStatus).every(Boolean) &&
        Object.values(manifestFieldStatus).every(Boolean) &&
        Object.values(manifestDigestStatus).every(Boolean) &&
        Object.values(immutableUriStatus).every(Boolean) &&
        Object.values(auditStatus).every(Boolean),
    },
    next_actions: [
      ...Object.entries(artifactStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `attach signed ${os} artifact set with non-UNSET signing identity in latest TV3 artifact manifest`),
      ...Object.entries(manifestFieldStatus)
        .filter(([, ok]) => !ok)
        .map(([field]) => `populate required artifact manifest field: ${field}`),
      ...Object.entries(manifestDigestStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `ensure ${os} artifact entries contain valid 64-hex sha256 digests`),
      ...Object.entries(immutableUriStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `attach immutable https digest links for ${os} artifacts in latest TV3 artifact manifest`),
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
