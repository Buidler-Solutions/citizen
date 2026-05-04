import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const evidenceDir = resolve(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');
const checklistPath = resolve(repoRoot, 'citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md');

function latestPortableSmokeSuite() {
  let latest = null;
  for (const name of readdirSync(evidenceDir)) {
    if (!name.startsWith('TV3_PORTABLE_SMOKE_SUITE_') || !name.endsWith('.json')) continue;
    const fullPath = join(evidenceDir, name);
    let payload;
    try {
      payload = JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch {
      continue;
    }
    if (payload?.schema !== 'citizen.wallet.desktop.tv3.portable-smoke-suite.v1') continue;
    const timestamp = String(payload.generated_at ?? '');
    if (!latest || timestamp > latest.timestamp) {
      latest = { name, payload, timestamp };
    }
  }
  return latest;
}

const smoke = latestPortableSmokeSuite();
const date = new Date().toISOString().slice(0, 10);
const outputPath = resolve(evidenceDir, `TV3_UX_SLEEK_SIGNOFF_TEMPLATE_${date}.md`);

const checklistReference = basename(checklistPath);
const body = `# TV3 UX “Working + Sleek” Sign-off Template (${date})

- Schema: \`citizen.wallet.desktop.tv3.ux-signoff.v1\`
- Checklist source: \`${checklistReference}\`
- Target gate: Portable Application Track -> UX review sign-off
- Generated at: \`${new Date().toISOString()}\`

## Scope

- Guided flow: create -> add-slot -> export -> verify -> restore -> safe-eject guidance
- Required UX acceptance target: first-time guided backup under 3 minutes, clear deterministic error copy, consistent visual hierarchy

## Evidence Inputs

- Latest portable smoke suite JSON: \`${smoke?.name ?? 'UNSET'}\`
- Portable smoke status: \`${smoke?.payload?.status ?? 'UNSET'}\`
- Portable smoke generated_at: \`${smoke?.payload?.generated_at ?? 'UNSET'}\`
- Linked walkthrough recording URI (immutable HTTPS): \`UNSET\`
- Linked screenshot set URI (immutable HTTPS): \`UNSET\`

## Time-to-complete Acceptance

- Measured guided backup duration (seconds): \`UNSET\`
- Meets < 180 seconds requirement: \`UNSET\`
- Measurement method notes: \`UNSET\`

## Error-copy Clarity Acceptance

- Ambiguous error copy count: \`UNSET\`
- Any non-deterministic/misleading wording found: \`UNSET\`
- Required fixes (if any): \`UNSET\`

## Visual Hierarchy Acceptance

- Critical actions visually distinct and ordered: \`UNSET\`
- Decoy/critical separation clarity confirmed: \`UNSET\`
- Accessibility/high-contrast review notes: \`UNSET\`

## Reviewer Sign-off

- Reviewer name: \`UNSET\`
- Reviewer role: \`UNSET\`
- Reviewed on (YYYY-MM-DD): \`UNSET\`
- Final decision (pass/fail): \`UNSET\`
- Blocking issues: \`UNSET\`
`;

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(outputPath, body, 'utf8');
console.log(`tv3-ux-signoff-template: wrote ${outputPath}`);
