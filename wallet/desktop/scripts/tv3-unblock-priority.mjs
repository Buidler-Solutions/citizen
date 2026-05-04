#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const checklistPath = path.join(
  repoRoot,
  'citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md',
);
const laneStatusPath = path.join(
  repoRoot,
  'citizen-protocol/docs/evidence/wallet-backup-vault/TV3_LANE_EXECUTION_STATUS.json',
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

function parseLaneExecutionStatus() {
  if (!fs.existsSync(laneStatusPath)) {
    return {
      schema: null,
      lanes: {},
      warnings: [`missing lane execution status file: ${path.relative(repoRoot, laneStatusPath)}`],
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(laneStatusPath, 'utf8'));
    const laneMap = Object.fromEntries((parsed.lanes ?? []).map((lane) => [lane.id, lane]));
    return {
      schema: parsed.schema ?? null,
      lanes: laneMap,
      warnings: [],
    };
  } catch (error) {
    return {
      schema: null,
      lanes: {},
      warnings: [`failed to parse lane execution status file: ${error.message}`],
    };
  }
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const executionStatus = parseLaneExecutionStatus();
const now = new Date();

const firstBlocked = laneStatus.find((lane) => lane.status === 'blocked') ?? null;
const blockedCount = laneStatus.filter((x) => x.status === 'blocked').length;
const status = firstBlocked ? 'blocked' : 'ready_for_checkpoint9_closeout';

const laneOrder = new Map(lanes.map((lane, index) => [lane.id, index]));
const firstBlockedIndex = firstBlocked ? laneOrder.get(firstBlocked.id) : -1;

const laneGovernance = laneStatus.map((lane) => {
  const laneExec = executionStatus.lanes[lane.id] ?? null;
  const blockers = [];
  const owner = laneExec?.owner ?? 'UNSET';
  const backupOwner = laneExec?.backup_owner ?? 'UNSET';
  const lastHeartbeatUtc = laneExec?.last_heartbeat_utc ?? 'UNSET';
  const unresolvedEvidence = Array.isArray(laneExec?.unresolved_evidence) ? laneExec.unresolved_evidence : [];

  if (lane.status === 'complete' && unresolvedEvidence.length > 0) {
    blockers.push('unresolved_evidence must be empty when lane checklist is complete');
  }

  if (owner === 'UNSET') blockers.push('owner is UNSET');
  if (backupOwner === 'UNSET') blockers.push('backup_owner is UNSET');

  const heartbeatDate = parseIsoDate(lastHeartbeatUtc);
  const heartbeatAgeHours = heartbeatDate ? (now.getTime() - heartbeatDate.getTime()) / (1000 * 60 * 60) : null;
  const laneIndex = laneOrder.get(lane.id);
  const isActiveLane = firstBlockedIndex >= 0 ? laneIndex === firstBlockedIndex : false;

  if (isActiveLane) {
    if (!heartbeatDate) {
      blockers.push('active lane last_heartbeat_utc missing or invalid');
    } else if (heartbeatAgeHours > 24) {
      blockers.push(`active lane heartbeat older than 24h (${heartbeatAgeHours.toFixed(1)}h)`);
    }
  }

  unresolvedEvidence.forEach((item, idx) => {
    const updated = parseIsoDate(item?.updated_at_utc);
    const ageHours = updated ? (now.getTime() - updated.getTime()) / (1000 * 60 * 60) : null;
    if (!updated || ageHours > 48) {
      blockers.push(`unresolved evidence item ${idx + 1} violates 48h SLA`);
    }
  });

  if (isActiveLane && lane.status === 'blocked' && unresolvedEvidence.length === 0) {
    blockers.push('active blocked lane must list unresolved_evidence entries');
  }

  return {
    id: lane.id,
    owner,
    backup_owner: backupOwner,
    last_heartbeat_utc: lastHeartbeatUtc,
    unresolved_evidence_count: unresolvedEvidence.length,
    blockers,
  };
});

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
  anti_stall: {
    status_file: path.relative(repoRoot, laneStatusPath),
    warnings: executionStatus.warnings,
    lane_assignments: laneGovernance,
  },
};

console.log(JSON.stringify(report, null, 2));

if (allowIncomplete || !strict) {
  process.exit(0);
}

const hasGovernanceBlockers = laneGovernance.some((lane) => lane.blockers.length > 0);
process.exit(firstBlocked || hasGovernanceBlockers || executionStatus.warnings.length > 0 ? 2 : 0);
