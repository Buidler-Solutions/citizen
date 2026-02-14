# Operator Disaster Recovery Runbook

This runbook defines the post-phase disaster-recovery workstream for both validator and observer operators.

It standardizes:
- scheduled RocksDB snapshot/restore drills,
- signed backup retention policy,
- quorum-safe regional restore execution,
- explicit RTO/RPO targets.

## 1) Scope and Objectives

- **Applies to:** all validator operators and all public/builder observer operators.
- **Data source:** node `data_dir` RocksDB state used by `citizen-node`.
- **Goal:** prove operators can restore from known-good backups without risking consensus safety or public query continuity.

## 2) Recovery Targets

### Validator Operator Targets
- **RPO target:** ≤ 5 minutes of data loss.
- **RTO target:** ≤ 30 minutes to rejoin as a healthy peer after incident declaration.

### Observer Operator Targets
- **RPO target:** ≤ 15 minutes of data loss.
- **RTO target:** ≤ 20 minutes to restore public read/query service.

## 3) Backup and Retention Policy

- **Snapshot cadence:** every 5 minutes for validators, every 15 minutes for observers.
- **Retention windows:**
  - Hourly snapshots retained for 48 hours.
  - Daily snapshots retained for 30 days.
  - Weekly snapshots retained for 12 weeks.
- **Integrity:** every archive MUST include a SHA-256 manifest and an operator signature over that manifest.
- **Storage profile:**
  - primary backup region + secondary region,
  - immutable/object-lock retention on at least one copy,
  - least-privilege restore credentials.

## 4) Drill Workflow (Snapshot → Verify → Restore)

Use `scripts/run_rocksdb_drill.sh` for reproducible drills.

### 4.1 Create Snapshot Artifact

```bash
scripts/run_rocksdb_drill.sh snapshot \
  --source data/validator-alpha \
  --out-dir backups \
  --node-id validator-alpha
```

Outputs:
- `*.tar.gz` backup archive
- `*.sha256` checksum manifest

### 4.2 Verify Artifact Integrity

```bash
scripts/run_rocksdb_drill.sh verify \
  --archive backups/<archive>.tar.gz \
  --manifest backups/<archive>.sha256
```

### 4.3 Restore into Drill Target

```bash
scripts/run_rocksdb_drill.sh restore \
  --archive backups/<archive>.tar.gz \
  --manifest backups/<archive>.sha256 \
  --target drills/validator-alpha-restore
```

## 5) Validator Quorum-Safe Regional Restore

When a region-wide event affects validator nodes:

1. **Freeze governance-sensitive actions** if quorum stability is uncertain.
2. **Restore no more than 20% of active validators concurrently** to avoid accidental quorum loss.
3. **Prioritize geographically diverse validator recovery batches** (do not recover one region entirely first).
4. **Require per-node restore verification** before re-admission:
   - snapshot checksum verified,
   - node API `/health` status OK,
   - peer admission allowlist unchanged from approved manifest,
   - finality/height progression confirmed against healthy peers.
5. **Record restoration evidence** (archive ID, checksum, signer, operator, start/end timestamps) in operations log for governance audit.

## 6) Observer/Public Query Restore Sequence

1. Restore observer node state from most recent signed snapshot.
2. Validate checksum and verify chain continuity against at least 2 healthy validators.
3. Re-enable public query endpoints only after block height drift is within operational tolerance.
4. Publish status update to builder/public channels with restored endpoint and snapshot age.

## 7) Mandatory Drill Cadence and Reporting

- **Validators:** one full restore drill per month per operator.
- **Observers:** one full restore drill per quarter per operator.
- **Release gate:** each release should include a drill report artifact confirming at least one validator and one observer successful restore in the previous cycle.

Minimum drill report fields:
- operator ID,
- node role (validator/observer),
- source snapshot ID + timestamp,
- checksum verification result,
- restore duration,
- observed RTO/RPO,
- remediation items.
