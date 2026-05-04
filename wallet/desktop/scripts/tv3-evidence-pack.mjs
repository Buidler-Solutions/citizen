#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const artifactsDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'wallet/desktop/dist-artifacts');
const outputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault', `TV3_ARTIFACT_MANIFEST_${new Date().toISOString().slice(0,10)}.json`);

async function sha256(filePath) {
  const data = await fs.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function collectArtifacts(root) {
  const names = await fs.readdir(root);
  const files = [];
  for (const name of names) {
    const filePath = path.join(root, name);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) continue;
    files.push({ name, filePath, size: stat.size, modified_at: stat.mtime.toISOString() });
  }
  return files;
}

const osFromName = (name) => {
  const v = name.toLowerCase();
  if (v.includes('linux')) return 'linux';
  if (v.includes('mac') || v.includes('darwin')) return 'macos';
  if (v.includes('win')) return 'windows';
  return 'unknown';
};

const archFromName = (name) => {
  const v = name.toLowerCase();
  if (v.includes('x64') || v.includes('amd64')) return 'x86_64';
  if (v.includes('arm64') || v.includes('aarch64')) return 'aarch64';
  return 'unknown';
};

(async () => {
  const artifacts = await collectArtifacts(artifactsDir);
  if (!artifacts.length) {
    throw new Error(`no files found in artifact directory: ${artifactsDir}`);
  }

  const manifest = {
    contract: 'citizen.wallet.desktop.release-artifacts.v1',
    generated_at: new Date().toISOString(),
    builder: {
      hostname: process.env.HOSTNAME ?? 'unknown',
      ci: Boolean(process.env.CI),
      git_sha: process.env.GIT_SHA ?? 'unknown',
    },
    artifacts: await Promise.all(
      artifacts.map(async (artifact) => ({
        filename: artifact.name,
        sha256: await sha256(artifact.filePath),
        size_bytes: artifact.size,
        build_timestamp: artifact.modified_at,
        target_os: osFromName(artifact.name),
        target_arch: archFromName(artifact.name),
        signing_identity: process.env.TV3_SIGNING_IDENTITY ?? 'UNSET',
      }))
    ),
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`tv3-evidence-pack: wrote ${outputPath} with ${manifest.artifacts.length} artifacts`);
})();
