import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const evidenceDir = path.join(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');

const osList = ['linux', 'macos', 'windows'];

function latestSmokeEvidenceForOs(os) {
  const prefix = 'TV3_PORTABLE_SMOKE_SUITE_';
  const files = fs.readdirSync(evidenceDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .reverse();

  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(path.join(evidenceDir, file), 'utf8'));
    if (payload.host_os === os) {
      return { file, payload };
    }
  }
  return null;
}

const today = new Date().toISOString().slice(0, 10);
const outputFiles = [];
for (const os of osList) {
  const latest = latestSmokeEvidenceForOs(os);
  const filename = `TV3_${os.toUpperCase()}_PORTABLE_SMOKE_SIGNED_EVIDENCE_${today}.md`;
  const body = `# TV3 ${os.toUpperCase()} Portable Smoke Signed Evidence\n\n- Evidence schema: \`citizen.wallet.desktop.tv3.portable-smoke.signed-evidence.v1\`\n- Target OS: \`${os}\`\n- Generated at: \`${new Date().toISOString()}\`\n\n## Required Immutable Links\n\n- Immutable signed smoke log URI (HTTPS): \`UNSET\`\n- Immutable digest URI (HTTPS): \`UNSET\`\n\n## Linked Smoke Suite Snapshot\n\n- Latest smoke suite JSON: \`${latest?.file ?? 'UNSET'}\`\n- Smoke suite status: \`${latest?.payload?.status ?? 'UNSET'}\`\n- Smoke suite timestamp: \`${latest?.payload?.generated_at ?? 'UNSET'}\`\n\n## Reviewer Sign-off\n\n- Reviewer name: \`UNSET\`\n- Reviewer role: \`UNSET\`\n- Reviewed on (YYYY-MM-DD): \`UNSET\`\n- Notes: \`UNSET\`\n`;

  fs.writeFileSync(path.join(evidenceDir, filename), body, 'utf8');
  outputFiles.push(filename);
}

console.log(JSON.stringify({
  status: 'ok',
  generated_at: new Date().toISOString(),
  output_files: outputFiles
}, null, 2));
