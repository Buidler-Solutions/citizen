import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const emitJson = process.argv.includes('--json');
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
  if (text.endsWith(':')) {
    continue;
  }
  if (status === ' ' || status === '~') {
    openItems.push({ status, text });
  } else if (status === 'x') {
    doneItems.push(text);
  }
}

const pendingItems = openItems.filter((item) => item.status === ' ');
const partialItems = openItems.filter((item) => item.status === '~');

const summary = {
  checkpoint: '8.5',
  status: openItems.length === 0 ? 'complete' : 'blocked',
  counts: {
    pending: pendingItems.length,
    partial: partialItems.length,
    complete: doneItems.length,
  },
  openItems: openItems.map((item, index) => ({
    index: index + 1,
    status: item.status === '~' ? 'partial' : 'pending',
    checklistBadge: item.status === '~' ? '[~]' : '[ ]',
    text: item.text,
  })),
};

if (emitJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `checklist-gap-check: checkpoint-8.5 pending=${summary.counts.pending} partial=${summary.counts.partial} complete=${summary.counts.complete}`,
  );

  if (openItems.length > 0) {
    console.log('checklist-gap-check: open priority-gate items:');
    for (const item of summary.openItems) {
      console.log(`  ${item.index}. ${item.checklistBadge} ${item.text}`);
    }
  } else {
    console.log('checklist-gap-check: priority gate complete; non-blocking tracks may proceed.');
  }
}

if (openItems.length > 0) {
  process.exitCode = 2;
}
