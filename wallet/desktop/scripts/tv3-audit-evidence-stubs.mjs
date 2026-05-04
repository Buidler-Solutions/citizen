#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const evidenceDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');
const stamp = process.argv[3] ?? new Date().toISOString().slice(0, 10);

const latestByPrefix = async (prefix) => {
  const files = await fs.readdir(evidenceDir);
  return files.filter((name) => name.startsWith(prefix)).sort().at(-1) ?? null;
};

const readJson = async (name) => {
  if (!name) return null;
  const raw = await fs.readFile(path.join(evidenceDir, name), 'utf8');
  return JSON.parse(raw);
};

const render = ({ os, auditPacketName, auditPacket, manifestName, manifest }) => {
  const osArtifacts = (manifest?.artifacts ?? []).filter(
    (artifact) => String(artifact.target_os ?? '').toLowerCase() === os
  );
  const auditEntry = auditPacket?.artifacts?.[os] ?? {};

  const lines = [
    `# TV3 ${os.toUpperCase()} Bridge Audit Evidence (${stamp})`,
    '',
    '- Contract: `citizen.wallet.desktop.tv3.bridge-audit-evidence.v1`',
    `- Generated at: ${new Date().toISOString()}`,
    `- Source audit packet: ${auditPacketName ?? 'UNSET'}`,
    `- Source artifact manifest: ${manifestName ?? 'UNSET'}`,
    '',
    '## Immutable URIs',
    '',
    `- Bridge audit immutable URI: ${auditEntry.immutable_uri ?? 'UNSET'}`,
  ];

  if (osArtifacts.length) {
    lines.push('- Signed desktop artifacts:');
    for (const artifact of osArtifacts) {
      lines.push(
        `  - ${artifact.filename} | sha256=${artifact.sha256} | uri=${artifact.immutable_uri} | signing_identity=${artifact.signing_identity}`
      );
    }
  } else {
    lines.push('- Signed desktop artifacts: UNSET');
  }

  lines.push('', '## Reviewer', '', `- Owner role: ${auditPacket?.review?.owner_role ?? 'UNSET'}`);
  lines.push(`- Signed off on: ${auditPacket?.review?.signed_off_on ?? 'UNSET'}`);
  lines.push('', '> Fill UNSET fields before TV-3 completion gate evaluation.');

  return `${lines.join('\n')}\n`;
};

(async () => {
  await fs.mkdir(evidenceDir, { recursive: true });

  const auditPacketName = await latestByPrefix('TV3_BRIDGE_AUDIT_PACKET_');
  const manifestName = await latestByPrefix('TV3_ARTIFACT_MANIFEST_');
  const auditPacket = await readJson(auditPacketName);
  const manifest = await readJson(manifestName);

  for (const os of ['linux', 'macos', 'windows']) {
    const body = render({ os, auditPacketName, auditPacket, manifestName, manifest });
    const fileName = `TV3_${os.toUpperCase()}_BRIDGE_AUDIT_EVIDENCE_${stamp}.md`;
    await fs.writeFile(path.join(evidenceDir, fileName), body, 'utf8');
    console.log(`tv3-audit-evidence-stubs: wrote ${fileName}`);
  }
})();
