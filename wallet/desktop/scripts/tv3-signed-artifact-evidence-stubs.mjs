#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const evidenceDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');
const generatedOn = new Date().toISOString().slice(0, 10);

const requiredOs = ['linux', 'macos', 'windows'];

async function readLatestManifest(dir) {
  const files = await fs.readdir(dir);
  const manifests = files.filter((name) => /TV3_ARTIFACT_MANIFEST_.*\.json$/i.test(name)).sort();
  if (!manifests.length) {
    throw new Error('missing TV3 artifact manifest; run pnpm tv3:evidence-pack first');
  }
  const latest = manifests.at(-1);
  const raw = await fs.readFile(path.join(dir, latest), 'utf8');
  return { name: latest, parsed: JSON.parse(raw) };
}

function pickArtifact(artifacts, os) {
  return artifacts.find((artifact) => String(artifact.target_os ?? '').toLowerCase() === os) ?? null;
}

(async () => {
  const { name: manifestName, parsed: manifest } = await readLatestManifest(evidenceDir);

  for (const os of requiredOs) {
    const artifact = pickArtifact(manifest.artifacts ?? [], os);
    const filename = `TV3_${os.toUpperCase()}_SIGNED_ARTIFACT_EVIDENCE_${generatedOn}.md`;
    const body = `# TV-3 ${os.toUpperCase()} Signed Artifact Evidence (${generatedOn})\n\n- Source manifest: ${manifestName}\n- Artifact filename: ${artifact?.filename ?? 'UNSET'}\n- SHA-256 digest: ${artifact?.sha256 ?? 'UNSET'}\n- Artifact immutable URI: ${artifact?.immutable_uri ?? 'UNSET'}\n- Artifact size bytes: ${artifact?.size_bytes ?? 'UNSET'}\n- Signing identity: ${artifact?.signing_identity ?? 'UNSET'}\n- Build timestamp (UTC): ${artifact?.build_timestamp ?? 'UNSET'}\n- Target tuple: ${(artifact?.target_os ?? 'UNSET')}/${(artifact?.target_arch ?? 'UNSET')}\n- Owner role: UNSET\n- Signed off on: UNSET\n\n## Notes\n\n- Replace all \`UNSET\` placeholders before running \`pnpm tv3:gate-check\`.\n`;
    await fs.writeFile(path.join(evidenceDir, filename), body, 'utf8');
    console.log(`tv3-signed-artifact-evidence-stubs: wrote ${filename}`);
  }
})();
