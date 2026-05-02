import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const emitJson = process.argv.includes('--json');
const checklistPath = resolve('../citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md');
const doc = readFileSync(checklistPath, 'utf8');

const sections = [];
let current = { title: 'ROOT', items: [] };
sections.push(current);

for (const rawLine of doc.split('\n')) {
  if (rawLine.startsWith('## ')) {
    current = { title: rawLine.replace(/^##\s+/, ''), items: [] };
    sections.push(current);
    continue;
  }

  const line = rawLine.trim();
  const m = line.match(/^- \[([ x~])\] (.+)$/);
  if (!m) continue;

  current.items.push({ status: m[1], text: m[2] });
}

const counts = { pending: 0, partial: 0, complete: 0 };
const staleUnchecked = [];
const completionHints = /(implemented|now includes|now enforces|validated|captured|exists in-repo|documented|recorded|added|wired|published|confirmed|accept(ed|ance))/i;
const remainingWorkHints = /(pending|remains pending|still pending|remaining|follow-up|follow up|open|yet|not\s+yet|still requires|still open|before marking complete|until .* complete)/i;

for (const section of sections) {
  for (const item of section.items) {
    if (item.status === ' ') counts.pending += 1;
    if (item.status === '~') counts.partial += 1;
    if (item.status === 'x') counts.complete += 1;

    if (item.status !== 'x' && completionHints.test(item.text) && !remainingWorkHints.test(item.text)) {
      staleUnchecked.push({
        section: section.title,
        status: item.status === '~' ? 'partial' : 'pending',
        text: item.text,
      });
    }
  }
}

const result = {
  checklist: 'WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST',
  counts,
  open: counts.pending + counts.partial,
  candidateStaleUnchecked: staleUnchecked,
};

if (emitJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`checklist-audit: pending=${counts.pending} partial=${counts.partial} complete=${counts.complete}`);
  if (staleUnchecked.length > 0) {
    console.log('checklist-audit: candidate stale unchecked items to review:');
    staleUnchecked.forEach((item, index) => {
      const badge = item.status === 'partial' ? '[~]' : '[ ]';
      console.log(`  ${index + 1}. ${badge} (${item.section}) ${item.text}`);
    });
  } else {
    console.log('checklist-audit: no likely stale unchecked checklist markers detected.');
  }
}
