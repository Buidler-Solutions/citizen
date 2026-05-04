#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const checklistPath = path.join(
  repoRoot,
  'citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md',
);

const strict = process.argv.includes('--strict');
const allowIncomplete = process.argv.includes('--allow-incomplete');

const text = fs.readFileSync(checklistPath, 'utf8');
const lines = text.split('\n');

function isUnchecked(line, needle) {
  return line.includes(needle) && /^\s*[-*]\s*\[( |~)\]/.test(line);
}

const lanes = [
  {
    id: 'lane_a_tv3_packaging_evidence',
    label: 'Lane A — TV-3 Packaging Evidence (All OS)',
    checks: [
      'Attach first signed Linux artifact set + immutable digest links.',
      'Attach first signed macOS artifact set + immutable digest links.',
      'Attach first signed Windows artifact set + immutable digest links.',
      'Cross-link the published artifact manifest into checkpoint-9 R9-D sign-off evidence.',
    ],
  },
  {
    id: 'lane_b_bridge_audit_evidence',
    label: 'Lane B — Bridge Audit Evidence (All OS + Consolidated Sign-off)',
    checks: [
      'Attach Linux bridge audit packet evidence link.',
      'Attach macOS bridge audit packet evidence link.',
      'Attach Windows bridge audit packet evidence link.',
      'Attach consolidated wallet+desktop+security maintainer sign-off URI.',
    ],
  },
  {
    id: 'lane_c_r9d_release_signoff',
    label: 'Lane C — R9-D Release Checklist Sign-off Packet',
    checks: [
      'Collect signed packaging/reproducibility artifacts for Linux/macOS/Windows desktop distributions and link immutable artifact digests.',
      'Attach final bridge memory/logging audit evidence showing no plaintext secret exposure across runtime bridge logs, crash artifacts, or diagnostics exports.',
      'Record explicit maintainer approvals (wallet, desktop/runtime, security) on the release checklist with date-stamped sign-off.',
    ],
  },
  {
    id: 'lane_d_r9e_validation',
    label: 'Lane D — R9-E Post-rollout Validation',
    checks: [
      'Execute one full internal alpha drill cycle using the R9-B cadence and attach completed packet evidence for each target OS.',
      'Summarize local-only telemetry counters from the R9-C spec (success/failure/verification confidence) and document threshold pass/fail outcomes.',
      'Publish a dated validation summary in `citizen-protocol/docs/evidence/wallet-backup-vault/` and cross-link it here before enabling beta opt-in.',
    ],
  },
  {
    id: 'lane_e_checkpoint9_exit',
    label: 'Lane E — Checkpoint 9 Exit Criteria Closure',
    checks: [
      'Release checklist signed off.',
      'Post-rollout validation report completed.',
      'Beta promotion decision pack approved by wallet + desktop/runtime + security owners.',
    ],
  },
];

const laneStatus = lanes.map((lane) => {
  const unresolved = lane.checks.filter((c) => lines.some((line) => isUnchecked(line, c)));
  return {
    ...lane,
    unresolved,
    status: unresolved.length === 0 ? 'complete' : 'blocked',
  };
});

const firstBlocked = laneStatus.find((lane) => lane.status === 'blocked') ?? null;
const blockedCount = laneStatus.filter((x) => x.status === 'blocked').length;
const status = firstBlocked ? 'blocked' : 'ready_for_checkpoint9_closeout';

const report = {
  schema: 'citizen.wallet.desktop.tv3.unblock-priority.v1',
  generated_at: new Date().toISOString(),
  checklist_path: path.relative(repoRoot, checklistPath),
  mode: strict ? 'strict' : 'report_only',
  summary: {
    total_lanes: laneStatus.length,
    blocked_lanes: blockedCount,
    status,
  },
  next_lane: firstBlocked
    ? {
        id: firstBlocked.id,
        label: firstBlocked.label,
        unresolved: firstBlocked.unresolved,
      }
    : null,
  lanes: laneStatus.map(({ id, label, status: laneStatusValue, unresolved }) => ({
    id,
    label,
    status: laneStatusValue,
    unresolved,
  })),
};

console.log(JSON.stringify(report, null, 2));

if (allowIncomplete || !strict) {
  process.exit(0);
}

process.exit(firstBlocked ? 2 : 0);
