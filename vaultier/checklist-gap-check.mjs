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
const pendingCount = (section.match(/- \[ \]/g) ?? []).length;
const partialCount = (section.match(/- \[~\]/g) ?? []).length;

console.log(`checklist-gap-check: checkpoint-8.5 pending=${pendingCount} partial=${partialCount}`);
if (pendingCount > 0 || partialCount > 0) {
  console.log('checklist-gap-check: priority gate still has open items; continue priority-first implementation order.');
}
