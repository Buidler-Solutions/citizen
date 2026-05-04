#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const cliArgs = process.argv.slice(2);
const flagArgs = new Set(cliArgs.filter((arg) => arg.startsWith('--')));
const positionalArgs = cliArgs.filter((arg) => !arg.startsWith('--'));

const evidenceDir = positionalArgs[0]
  ? path.resolve(positionalArgs[0])
  : path.join(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault');
const outputPath = positionalArgs[1]
  ? path.resolve(positionalArgs[1])
  : path.join(evidenceDir, `TV3_COMPLETION_GATE_STATUS_${new Date().toISOString().slice(0, 10)}.json`);
const allowIncomplete = flagArgs.has('--allow-incomplete') || process.env.TV3_ALLOW_INCOMPLETE === '1';

const requiredArtifacts = {
  linux: /linux/i,
  macos: /(mac|darwin|osx)/i,
  windows: /(win|windows)/i,
};

const requiredManifestFields = [
  'filename',
  'sha256',
  'signing_identity',
  'build_timestamp',
  'target_os',
  'target_arch',
  'immutable_uri',
  'size_bytes',
];

const allowedTargetOs = new Set(['linux', 'macos', 'windows']);
const allowedTargetArch = new Set(['x86_64', 'aarch64']);

const requiredAuditPacketFields = [
  'contract',
  'generated_at',
  'review.owner_role',
  'review.signed_off_on',
  'artifacts.linux.immutable_uri',
  'artifacts.macos.immutable_uri',
  'artifacts.windows.immutable_uri',
];

const requiredAudits = {
  linux: /linux.*audit|audit.*linux/i,
  macos: /(mac|darwin|osx).*(audit)|audit.*(mac|darwin|osx)/i,
  windows: /windows.*audit|audit.*windows|win.*audit/i,
};

const requiredChecklistCrossLinks = {
  r9d_signoff: /R9-D.*(sign-?off|evidence).*https?:\/\//i,
  consolidated_signoff: /consolidated.*sign-?off.*https?:\/\//i,
};

const maxManifestAgeDays = Number.parseInt(process.env.TV3_MAX_MANIFEST_AGE_DAYS ?? '14', 10);

const checklistPath = path.join(
  repoRoot,
  'citizen-protocol/docs/WALLET_ENCRYPTED_BACKUP_VAULT_IMPLEMENTATION_CHECKLIST.md'
);

async function readManifests(dir) {
  const files = await fs.readdir(dir);
  const manifestNames = files.filter((name) => /TV3_ARTIFACT_MANIFEST_.*\.json$/i.test(name)).sort();
  const manifests = [];
  for (const name of manifestNames) {
    const full = path.join(dir, name);
    const raw = await fs.readFile(full, 'utf8');
    const parsed = JSON.parse(raw);
    manifests.push({ name, full, parsed });
  }
  return manifests;
}

function daysBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

function validateAuditEvidence(files) {
  const packets = files.filter((name) => /^TV3_BRIDGE_AUDIT_PACKET_.*\.json$/i.test(name)).sort();
  if (!packets.length) {
    return {
      present: false,
      valid: false,
      packet: null,
      packet_name: null,
      os_coverage: { linux: false, macos: false, windows: false },
      immutable_uris: { linux: false, macos: false, windows: false },
      reviewer_signoff: false,
    };
  }

  const latest = packets.at(-1);
  return { present: true, latest };
}


function extractMarkdownField(raw, label) {
  const rx = new RegExp(`-\\s+${label}:\\s+(.+)$`, 'im');
  const m = raw.match(rx);
  return m ? m[1].trim() : '';
}


async function validatePerOsSignedArtifactEvidence(dir) {
  const files = await fs.readdir(dir);
  const status = { linux: false, macos: false, windows: false };

  for (const os of Object.keys(status)) {
    const name = files
      .filter((entry) => new RegExp(`^TV3_${os.toUpperCase()}_SIGNED_ARTIFACT_EVIDENCE_.*\.md$`, 'i').test(entry))
      .sort()
      .at(-1);

    if (!name) continue;

    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    const immutable = extractMarkdownField(raw, 'Artifact immutable URI');
    const signingIdentity = extractMarkdownField(raw, 'Signing identity');
    const signedOffOn = extractMarkdownField(raw, 'Signed off on');

    status[os] =
      /^https:\/\//i.test(immutable) &&
      immutable !== 'UNSET' &&
      signingIdentity.length > 0 &&
      signingIdentity !== 'UNSET' &&
      /^\d{4}-\d{2}-\d{2}$/.test(signedOffOn) &&
      signedOffOn !== 'UNSET';
  }

  return status;
}

async function validatePerOsAuditEvidence(dir) {
  const files = await fs.readdir(dir);
  const status = { linux: false, macos: false, windows: false };

  for (const os of Object.keys(status)) {
    const name = files
      .filter((entry) => new RegExp(`^TV3_${os.toUpperCase()}_BRIDGE_AUDIT_EVIDENCE_.*\\.md$`, 'i').test(entry))
      .sort()
      .at(-1);

    if (!name) {
      continue;
    }

    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    const immutable = extractMarkdownField(raw, 'Bridge audit immutable URI');
    const ownerRole = extractMarkdownField(raw, 'Owner role');
    const signedOffOn = extractMarkdownField(raw, 'Signed off on');

    status[os] =
      /^https:\/\//i.test(immutable) &&
      immutable !== 'UNSET' &&
      ownerRole.length > 0 &&
      ownerRole !== 'UNSET' &&
      /^\d{4}-\d{2}-\d{2}$/.test(signedOffOn) &&
      signedOffOn !== 'UNSET';
  }

  return status;
}
(async () => {
  const files = await fs.readdir(evidenceDir);
  const checklistRaw = await fs.readFile(checklistPath, 'utf8');
  const manifests = await readManifests(evidenceDir);
  const latestManifest = manifests.at(-1);
  const auditPacketProbe = validateAuditEvidence(files);

  const artifactStatus = Object.fromEntries(
    Object.entries(requiredArtifacts).map(([os, rx]) => {
      const found = latestManifest?.parsed?.artifacts?.some((artifact) => {
        const filename = String(artifact.filename ?? '');
        const targetOs = String(artifact.target_os ?? '').toLowerCase();
        const signingIdentity = String(artifact.signing_identity ?? '');
        return targetOs === os && rx.test(filename) && signingIdentity && signingIdentity !== 'UNSET';
      });
      return [os, Boolean(found)];
    })
  );

  const manifestFieldStatus = Object.fromEntries(
    requiredManifestFields.map((field) => {
      const present = latestManifest?.parsed?.artifacts?.every((artifact) => {
        const value = artifact?.[field];
        return value !== undefined && value !== null && String(value).trim() !== '';
      });
      return [field, Boolean(present)];
    })
  );

  const manifestDigestStatus = Object.fromEntries(
    Object.keys(requiredArtifacts).map((os) => {
      const osArtifacts = (latestManifest?.parsed?.artifacts ?? []).filter(
        (artifact) => String(artifact.target_os ?? '').toLowerCase() === os
      );
      const allSha256 = osArtifacts.every((artifact) => /^[a-f0-9]{64}$/i.test(String(artifact.sha256 ?? '')));
      return [os, osArtifacts.length > 0 && allSha256];
    })
  );

  const manifestTargetOsStatus = Object.fromEntries(
    Object.keys(requiredArtifacts).map((os) => {
      const osArtifacts = (latestManifest?.parsed?.artifacts ?? []).filter(
        (artifact) => String(artifact.target_os ?? '').toLowerCase() === os
      );
      const validOsValues = osArtifacts.every((artifact) =>
        allowedTargetOs.has(String(artifact.target_os ?? '').toLowerCase())
      );
      return [os, osArtifacts.length > 0 && validOsValues];
    })
  );

  const manifestTargetArchStatus = Object.fromEntries(
    Object.keys(requiredArtifacts).map((os) => {
      const osArtifacts = (latestManifest?.parsed?.artifacts ?? []).filter(
        (artifact) => String(artifact.target_os ?? '').toLowerCase() === os
      );
      const validArchValues = osArtifacts.every((artifact) =>
        allowedTargetArch.has(String(artifact.target_arch ?? '').toLowerCase())
      );
      return [os, osArtifacts.length > 0 && validArchValues];
    })
  );


  const manifestArtifactCoverage = Object.fromEntries(
    Object.keys(requiredArtifacts).map((os) => {
      const osArtifacts = (latestManifest?.parsed?.artifacts ?? []).filter(
        (artifact) => String(artifact.target_os ?? '').toLowerCase() === os
      );
      return [os, osArtifacts.length > 0];
    })
  );

  const manifestUnexpectedTargets = (latestManifest?.parsed?.artifacts ?? []).filter((artifact) => {
    const os = String(artifact.target_os ?? '').toLowerCase();
    const arch = String(artifact.target_arch ?? '').toLowerCase();
    return !allowedTargetOs.has(os) || !allowedTargetArch.has(arch);
  });


  const immutableUriStatus = Object.fromEntries(
    Object.keys(requiredArtifacts).map((os) => {
      const osArtifacts = (latestManifest?.parsed?.artifacts ?? []).filter(
        (artifact) => String(artifact.target_os ?? '').toLowerCase() === os
      );
      const allImmutableUris = osArtifacts.every((artifact) =>
        /^https:\/\//i.test(String(artifact.immutable_uri ?? ''))
      );
      return [os, osArtifacts.length > 0 && allImmutableUris];
    })
  );

  const auditFilePresence = Object.fromEntries(
    Object.entries(requiredAudits).map(([os, rx]) => {
      const found = files.some((name) => rx.test(name));
      return [os, Boolean(found)];
    })
  );

  const perOsAuditEvidenceStatus = await validatePerOsAuditEvidence(evidenceDir);
  const perOsSignedArtifactEvidenceStatus = await validatePerOsSignedArtifactEvidence(evidenceDir);

  const auditStatus = Object.fromEntries(
    Object.keys(requiredAudits).map((os) => [os, Boolean(auditFilePresence[os] && perOsAuditEvidenceStatus[os])])
  );

  const checklistCrossLinkStatus = Object.fromEntries(
    Object.entries(requiredChecklistCrossLinks).map(([key, rx]) => [key, rx.test(checklistRaw)])
  );

  const manifestFreshness = (() => {
    const generatedAt = latestManifest?.parsed?.generated_at;
    if (!generatedAt) return false;
    const parsed = new Date(generatedAt);
    if (Number.isNaN(parsed.getTime())) return false;
    return daysBetween(new Date(), parsed) <= maxManifestAgeDays;
  })();

  let auditPacketStatus = {
    present: false,
    valid: false,
    packet_name: null,
    os_coverage: { linux: false, macos: false, windows: false },
    immutable_uris: { linux: false, macos: false, windows: false },
    reviewer_signoff: false,
    field_coverage: Object.fromEntries(requiredAuditPacketFields.map((field) => [field, false])),
    contract_version: false,
  };

  if (auditPacketProbe.present) {
    const auditRaw = await fs.readFile(path.join(evidenceDir, auditPacketProbe.latest), 'utf8');
    const audit = JSON.parse(auditRaw);
    const osCoverage = {
      linux: Boolean(audit?.artifacts?.linux),
      macos: Boolean(audit?.artifacts?.macos),
      windows: Boolean(audit?.artifacts?.windows),
    };
    const immutableUris = Object.fromEntries(
      Object.keys(osCoverage).map((os) => [os, /^https:\/\//i.test(String(audit?.artifacts?.[os]?.immutable_uri ?? ''))])
    );
    const reviewerSignoff =
      String(audit?.review?.owner_role ?? '').trim().length > 0 &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(audit?.review?.signed_off_on ?? ''));

    const auditPacketFieldCoverage = {
      contract: String(audit?.contract ?? '').trim().length > 0,
      generated_at: /^\d{4}-\d{2}-\d{2}T/.test(String(audit?.generated_at ?? '')),
      'review.owner_role': String(audit?.review?.owner_role ?? '').trim().length > 0,
      'review.signed_off_on': /^\d{4}-\d{2}-\d{2}$/.test(String(audit?.review?.signed_off_on ?? '')),
      'artifacts.linux.immutable_uri': /^https:\/\//i.test(String(audit?.artifacts?.linux?.immutable_uri ?? '')),
      'artifacts.macos.immutable_uri': /^https:\/\//i.test(String(audit?.artifacts?.macos?.immutable_uri ?? '')),
      'artifacts.windows.immutable_uri': /^https:\/\//i.test(String(audit?.artifacts?.windows?.immutable_uri ?? '')),
    };

    const contractVersion = String(audit?.contract ?? '') === 'citizen.wallet.desktop.tv3.bridge-audit-packet.v1';

    auditPacketStatus = {
      present: true,
      valid:
        Object.values(osCoverage).every(Boolean) &&
        Object.values(immutableUris).every(Boolean) &&
        reviewerSignoff &&
        contractVersion &&
        Object.values(auditPacketFieldCoverage).every(Boolean),
      packet_name: auditPacketProbe.latest,
      os_coverage: osCoverage,
      immutable_uris: immutableUris,
      reviewer_signoff: reviewerSignoff,
      field_coverage: auditPacketFieldCoverage,
      contract_version: contractVersion,
    };
  }

  const summary = {
    contract: 'citizen.wallet.desktop.tv3.gate-status.v1',
    generated_at: new Date().toISOString(),
    evidence_dir: evidenceDir,
    latest_artifact_manifest: latestManifest ? latestManifest.name : null,
    gates: {
      artifacts: artifactStatus,
      manifest_fields: manifestFieldStatus,
      manifest_sha256: manifestDigestStatus,
      manifest_target_os: manifestTargetOsStatus,
      manifest_target_arch: manifestTargetArchStatus,
      manifest_artifact_coverage: manifestArtifactCoverage,
      manifest_no_unexpected_targets: manifestUnexpectedTargets.length === 0,
      immutable_uris: immutableUriStatus,
      audits: auditStatus,
      signed_artifact_evidence: perOsSignedArtifactEvidenceStatus,
      checklist_cross_links: checklistCrossLinkStatus,
      manifest_freshness: manifestFreshness,
      audit_packet: auditPacketStatus,
      complete:
        Object.values(artifactStatus).every(Boolean) &&
        Object.values(manifestFieldStatus).every(Boolean) &&
        Object.values(manifestDigestStatus).every(Boolean) &&
        Object.values(manifestTargetOsStatus).every(Boolean) &&
        Object.values(manifestTargetArchStatus).every(Boolean) &&
        Object.values(manifestArtifactCoverage).every(Boolean) &&
        manifestUnexpectedTargets.length === 0 &&
        Object.values(immutableUriStatus).every(Boolean) &&
        Object.values(auditStatus).every(Boolean) &&
        Object.values(perOsSignedArtifactEvidenceStatus).every(Boolean) &&
        Object.values(checklistCrossLinkStatus).every(Boolean) &&
        manifestFreshness &&
        auditPacketStatus.valid,
    },
    next_actions: [
      ...Object.entries(artifactStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `attach signed ${os} artifact set with non-UNSET signing identity in latest TV3 artifact manifest`),
      ...Object.entries(manifestFieldStatus)
        .filter(([, ok]) => !ok)
        .map(([field]) => `populate required artifact manifest field: ${field}`),
      ...Object.entries(manifestDigestStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `ensure ${os} artifact entries contain valid 64-hex sha256 digests`),
      ...Object.entries(manifestTargetOsStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `ensure ${os} artifact entries use supported target_os values (linux|macos|windows)`),
      ...Object.entries(manifestTargetArchStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `ensure ${os} artifact entries use supported target_arch values (x86_64|aarch64)`),
      ...Object.entries(manifestArtifactCoverage)
        .filter(([, ok]) => !ok)
        .map(([os]) => `add at least one ${os} artifact entry in latest TV3 artifact manifest`),
      ...(manifestUnexpectedTargets.length > 0
        ? ['remove manifest entries with unsupported target_os/target_arch combinations']
        : []),
      ...Object.entries(immutableUriStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `attach immutable https digest links for ${os} artifacts in latest TV3 artifact manifest`),
      ...Object.entries(auditStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `attach ${os} bridge audit evidence file with immutable URI + reviewer fields in wallet-backup-vault evidence directory`),
      ...Object.entries(perOsSignedArtifactEvidenceStatus)
        .filter(([, ok]) => !ok)
        .map(([os]) => `attach ${os} signed artifact evidence markdown with immutable URI + signing identity + dated reviewer sign-off`),
      ...Object.entries(checklistCrossLinkStatus)
        .filter(([, ok]) => !ok)
        .map(([item]) =>
          item === 'r9d_signoff'
            ? 'add R9-D sign-off evidence line with immutable HTTPS URI into wallet backup checklist'
            : 'add consolidated maintainer sign-off line with immutable HTTPS URI into wallet backup checklist'
        ),
      ...(!manifestFreshness
        ? [`regenerate artifact manifest so generated_at is within ${maxManifestAgeDays} days of gate check`]
        : []),
      ...(!auditPacketStatus.present
        ? ['attach TV3 bridge audit packet JSON (TV3_BRIDGE_AUDIT_PACKET_YYYY-MM-DD.json) with per-OS immutable URIs and reviewer sign-off']
        : []),
      ...(auditPacketStatus.present && !auditPacketStatus.contract_version
        ? ['set TV3 bridge audit packet contract to citizen.wallet.desktop.tv3.bridge-audit-packet.v1']
        : []),
      ...(auditPacketStatus.present
        ? Object.entries(auditPacketStatus.field_coverage)
            .filter(([, ok]) => !ok)
            .map(([field]) => `populate required TV3 bridge audit packet field: ${field}`)
        : []),
      ...(auditPacketStatus.present && !auditPacketStatus.valid
        ? ['update latest TV3 bridge audit packet to include linux/macos/windows immutable HTTPS URIs and dated reviewer sign-off metadata']
        : []),
    ],
  };

  await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`tv3-completion-gate-check: wrote ${outputPath}`);

  if (!summary.gates.complete) {
    if (allowIncomplete) {
      console.log('tv3-completion-gate-check: incomplete gates allowed via --allow-incomplete/TV3_ALLOW_INCOMPLETE=1');
    } else {
      process.exitCode = 2;
    }
  }
})();
