import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const checklistPath = resolve('../citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md');
const doc = readFileSync(checklistPath, 'utf8');

const priorityStart = doc.indexOf('## Checkpoint 8.5 — Priority Gate');
const portableStart = doc.indexOf('## Portable Application Track');
if (priorityStart === -1 || portableStart === -1 || portableStart <= priorityStart) {
  throw new Error('priority gate markers missing');
}

const section = doc.slice(priorityStart, portableStart);
const lines = section.split('\n');

const openItems = [];
const doneItems = [];
for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line.startsWith('- [')) continue;

  const status = line.slice(3, 4);
  const text = line.replace(/^- \[[ x~]\]\s*/, '');
  if (status === ' ' || status === '~') {
    openItems.push({ status, text });
  } else if (status === 'x') {
    doneItems.push(text);
  }
}

const pendingCount = openItems.filter((item) => item.status === ' ').length;
const partialCount = openItems.filter((item) => item.status === '~').length;

console.log(`checklist-gap-check: checkpoint-8.5 pending=${pendingCount} partial=${partialCount} complete=${doneItems.length}`);

if (openItems.length > 0) {
  console.log('checklist-gap-check: open priority-gate items:');
  for (const [index, item] of openItems.entries()) {
    const badge = item.status === '~' ? '[~]' : '[ ]';
    console.log(`  ${index + 1}. ${badge} ${item.text}`);
  }
  process.exitCode = 2;
} else {
  console.log('checklist-gap-check: priority gate complete; non-blocking tracks may proceed.');
}
