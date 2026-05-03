import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const emitJson = process.argv.includes('--json');
const strictStaleUnchecked = process.argv.includes('--strict-stale-unchecked');
const includeFullSummary = process.argv.includes('--full-summary');
const emitMarkdown = process.argv.includes('--markdown');
const includeOpenItemDetails = process.argv.includes('--full-open-items');
const includeReconciliation = process.argv.includes('--reconciliation');
const markdownFileArg = process.argv.find((arg) => arg.startsWith('--markdown-file='));
const markdownOutputPath = markdownFileArg ? markdownFileArg.split('=')[1] : null;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const checklistPath = resolve(scriptDir, '../citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md');
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

const completionHints = /(implemented|now includes|now enforces|validated|captured|exists in-repo|documented|recorded|added|wired|published|confirmed|accept(ed|ance))/i;
const remainingWorkHints = /(pending|remains pending|still pending|remaining|follow-up|follow up|open|yet|not\s+yet|still requires|still open|before marking complete|until .* complete)/i;
const signoffGatedHints = /(for both CLI and extension|working and sleek|<3 minute|first-time backup flow under 3 minutes|all user-facing commands and JSON schema examples validated)/i;
const staleUnchecked = [];
const doneButPossiblyOverclaimed = [];
let sectionTitle = 'ROOT';

for (const rawLine of doc.split('\n')) {
  if (rawLine.startsWith('## ')) {
    sectionTitle = rawLine.replace(/^##\s+/, '');
    continue;
  }

  const line = rawLine.trim();
  const match = line.match(/^- \[([ x~])\] (.+)$/);
  if (!match) continue;

  const status = match[1];
  const text = match[2];
  if (status === 'x') {
    if (remainingWorkHints.test(text) && !completionHints.test(text)) {
      doneButPossiblyOverclaimed.push({
        section: sectionTitle,
        checklistBadge: '[x]',
        text,
      });
    }
    continue;
  }
  if (signoffGatedHints.test(text)) continue;
  if (completionHints.test(text) && !remainingWorkHints.test(text)) {
    staleUnchecked.push({
      section: sectionTitle,
      status: status === '~' ? 'partial' : 'pending',
      checklistBadge: status === '~' ? '[~]' : '[ ]',
      text,
    });
  }
}


const fullSectionSummaries = [];
let currentFullSection = 'ROOT';
for (const rawLine of doc.split('\n')) {
  if (rawLine.startsWith('## ')) {
    currentFullSection = rawLine.replace(/^##\s+/, '');
    continue;
  }

  const line = rawLine.trim();
  const match = line.match(/^- \[([ x~])\] (.+)$/);
  if (!match) continue;

  const status = match[1];
  const text = match[2];
  const bucket =
    status === 'x'
      ? 'complete'
      : status === '~'
        ? 'partial'
        : 'pending';

  const existing = fullSectionSummaries.find((entry) => entry.section === currentFullSection);
  if (!existing) {
    fullSectionSummaries.push({
      section: currentFullSection,
      counts: { pending: 0, partial: 0, complete: 0 },
      openItems: [],
    });
  }

  const target = fullSectionSummaries.find((entry) => entry.section === currentFullSection);
  target.counts[bucket] += 1;
  if (bucket !== 'complete') {
    target.openItems.push({
      checklistBadge: bucket === 'partial' ? '[~]' : '[ ]',
      text,
      status: bucket,
    });
  }
}
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
  staleUncheckedCandidates: staleUnchecked,
  doneButPossiblyOverclaimed,
  fullSectionSummaries,
};



const markdownLines = [
  '# Wallet backup checklist gap report',
  '',
  `- Generated: ${new Date().toISOString()}`,
  `- Priority gate status: **${summary.status}**`,
  `- Checkpoint 8.5 counts: pending=${summary.counts.pending}, partial=${summary.counts.partial}, complete=${summary.counts.complete}`,
  '',
  '## Priority gate open items',
];

if (summary.openItems.length === 0) {
  markdownLines.push('- None.');
} else {
  for (const item of summary.openItems) {
    markdownLines.push(`- ${item.checklistBadge} ${item.text}`);
  }
}

markdownLines.push('', '## Full checklist section summary');
for (const section of fullSectionSummaries) {
  markdownLines.push(`- **${section.section}**: pending=${section.counts.pending}, partial=${section.counts.partial}, complete=${section.counts.complete}`);
}

markdownLines.push('', '## Potential stale unchecked markers');
if (staleUnchecked.length === 0) {
  markdownLines.push('- None detected.');
} else {
  for (const item of staleUnchecked) {
    markdownLines.push(`- ${item.checklistBadge} (${item.section}) ${item.text}`);
  }
}


markdownLines.push('', '## Potential over-checked markers');
if (doneButPossiblyOverclaimed.length === 0) {
  markdownLines.push('- None detected.');
} else {
  for (const item of doneButPossiblyOverclaimed) {
    markdownLines.push(`- ${item.checklistBadge} (${item.section}) ${item.text}`);
  }
}
if (emitMarkdown) {
  if (includeOpenItemDetails) {
    markdownLines.push('', '## Full checklist open items');
    for (const section of fullSectionSummaries) {
      if (section.openItems.length === 0) continue;
      markdownLines.push('', `### ${section.section}`);
      for (const item of section.openItems) {
        markdownLines.push(`- ${item.checklistBadge} ${item.text}`);
      }
    }
  }
  const markdownOutput = markdownLines.join('\n');
  if (markdownOutputPath) {
    const outputPath = resolve(process.cwd(), markdownOutputPath);
    writeFileSync(outputPath, `${markdownOutput}\n`, 'utf8');
    console.log(`checklist-gap-check: wrote markdown report to ${outputPath}`);
  } else {
    console.log(markdownOutput);
  }
}

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


  if (includeFullSummary) {
    console.log('checklist-gap-check: full checklist open-gap summary:');
    for (const section of fullSectionSummaries) {
      if (section.counts.pending === 0 && section.counts.partial === 0) continue;
      console.log(
        `  - ${section.section}: pending=${section.counts.pending} partial=${section.counts.partial} complete=${section.counts.complete}`
      );
    }
  }
  if (includeOpenItemDetails) {
    console.log('checklist-gap-check: full checklist open-item details:');
    for (const section of fullSectionSummaries) {
      if (section.openItems.length === 0) continue;
      console.log(`  ${section.section}:`);
      for (const item of section.openItems) {
        console.log(`    - ${item.checklistBadge} ${item.text}`);
      }
    }
  }

  if (staleUnchecked.length > 0) {
    console.log(`checklist-gap-check: stale unchecked candidates=${staleUnchecked.length} (review before continuing Tauri work):`);
    staleUnchecked.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.checklistBadge} (${item.section}) ${item.text}`);
    });
  } else {
    console.log('checklist-gap-check: no likely stale unchecked checklist markers detected.');
  }

  if (doneButPossiblyOverclaimed.length > 0) {
    console.log(`checklist-gap-check: possible over-checked markers=${doneButPossiblyOverclaimed.length} (review for completion drift):`);
    doneButPossiblyOverclaimed.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.checklistBadge} (${item.section}) ${item.text}`);
    });
  } else {
    console.log('checklist-gap-check: no likely over-checked checklist markers detected.');
  }

  if (includeReconciliation) {
    console.log('checklist-gap-check: reconciliation snapshot:');
    console.log(`  stale-unchecked=${staleUnchecked.length}`);
    console.log(`  potential-overchecked=${doneButPossiblyOverclaimed.length}`);
  }
}

if (openItems.length > 0 || (strictStaleUnchecked && staleUnchecked.length > 0)) {
  process.exitCode = 2;
}
