export type RuntimeEntry = {
  entry_id: string;
  namespace: string;
  action: string;
  timestamp: number;
  author?: string;
  [key: string]: unknown;
};

export type RuntimeBlock = {
  hash?: string;
  header: {
    height: number;
    prev_hash: string;
    entry_root?: string;
    proposer?: string;
    timestamp: number;
    [key: string]: unknown;
  };
  entries: RuntimeEntry[];
  [key: string]: unknown;
};

export type IndexedBlock = {
  block_height: number;
  block_hash: string;
  prev_hash: string;
  proposer: string | null;
  committed_at: number;
  entry_count: number;
  block_weight_bytes: number;
  first_seen_at: number;
  updated_at: number;
};

export type IndexedEntry = {
  entry_id: string;
  block_height: number;
  entry_index: number;
  namespace: string;
  action: string;
  committed_at: number;
  entry_weight_bytes: number;
  signer: string | null;
  payload_commitment: string | null;
  first_seen_at: number;
  updated_at: number;
};

export type MetricWindowName = '10s' | '60s' | '5m' | '1h';

export type MetricWindow = {
  window_name: MetricWindowName;
  window_start: number;
  window_end: number;
  entries_committed: number;
  tps: number;
  computed_at: number;
  is_estimated: boolean;
};

export type PageInfo = {
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
};

export type PaginatedResult<T> = {
  data: T[];
  page: PageInfo;
};

export type CursorState = {
  last_indexed_height: number;
  last_indexed_block_hash: string | null;
  degraded: boolean;
  last_error: string | null;
  retry_count: number;
  updated_at: number | null;
};

export type IndexerSummary = {
  deployment: {
    profile: IndexerDeploymentProfile;
    metrics_auth_required: boolean;
    metrics_rate_limit_rpm: number;
    oncall_runbook: string;
    release_notes_checklist: string;
  };
  cursor: CursorState;
  counts: {
    indexed_blocks: number;
    indexed_entries: number;
  };
  lag: {
    runtime_latest_height: number;
    indexed_height: number;
    ingestion_lag_blocks: number;
  };
  poison_blocks: Array<{
    height: number;
    reason: string;
    detected_at: number;
  }>;
  late_data: {
    accepted_entries: number;
    latest_committed_at: number | null;
    allowed_lateness_seconds: number;
  };
  internal_metrics: {
    failed_block_count: number;
    retry_count_total: number;
    block_processing_latency_ms: LatencySnapshot;
    aggregation_job_latency_ms: LatencySnapshot;
  };
  slo: SloSnapshot;
  alerts: IndexerAlert[];
};

export type LatencySnapshot = {
  samples: number;
  avg: number;
  p95: number;
  max: number;
  last: number | null;
};

export type SloCheckStatus = 'pass' | 'warn' | 'fail';

export type SloCheck = {
  name: string;
  status: SloCheckStatus;
  target: string;
  observed: string;
};

export type SloSnapshot = {
  status: SloCheckStatus;
  checks: SloCheck[];
};

export type IndexerAlertSeverity = 'info' | 'warning' | 'critical';

export type IndexerDeploymentProfile = 'localnet' | 'shared-dev' | 'production-candidate';

export type IndexerAlert = {
  id: 'stalled_cursor' | 'sustained_lag' | 'checksum_mismatch';
  severity: IndexerAlertSeverity;
  active: boolean;
  message: string;
  observed: string;
  threshold: string;
  playbook: string[];
};

export type BackfillRunResult = {
  requested_from_height: number;
  requested_to_height: number;
  runtime_latest_height: number;
  indexed_start_height: number;
  indexed_end_height: number;
  processed_blocks: number;
  indexed_blocks: number;
  indexed_entries: number;
  started_at_ms: number;
  finished_at_ms: number;
  duration_ms: number;
  degraded: boolean;
  last_error: string | null;
};

export type VerificationSampleIssue = {
  height: number;
  issue:
    | 'missing_runtime_block'
    | 'missing_indexed_block'
    | 'entry_count_mismatch'
    | 'timestamp_mismatch'
    | 'block_weight_mismatch'
    | 'entry_weight_mismatch';
  details: string;
};

export type VerificationSampleReport = {
  requested_sample_count: number;
  sampled_heights: number[];
  matched_heights: number;
  failed_heights: number;
  issues: VerificationSampleIssue[];
  generated_at_ms: number;
};

export type TpsCrossCheckIssue = {
  window_name: MetricWindowName;
  window_start: number;
  issue: 'missing_materialized_window' | 'entries_committed_mismatch' | 'tps_mismatch';
  expected_entries_committed: number;
  actual_entries_committed: number | null;
  expected_tps: number;
  actual_tps: number | null;
};

export type TpsCrossCheckReport = {
  window_name: MetricWindowName;
  from: number | null;
  to: number | null;
  compared_windows: number;
  mismatch_windows: number;
  issues: TpsCrossCheckIssue[];
  generated_at_ms: number;
};

export type VerificationEvidenceBundle = {
  generated_at_ms: number;
  indexed_height: number;
  runtime_latest_height: number;
  block_checksum_sha256: string;
  entry_checksum_sha256: string;
  tps_window_checksums_sha256: Record<MetricWindowName, string>;
  summary: IndexerSummary;
};

export type IndexerMetricsSnapshot = {
  cursor: CursorState;
  indexed_blocks: IndexedBlock[];
  indexed_entries: IndexedEntry[];
  metric_windows: Record<MetricWindowName, MetricWindow[]>;
  poison_blocks: Array<{
    height: number;
    reason: string;
    detected_at: number;
  }>;
  latest_committed_at: number | null;
  late_entries_accepted: number;
  failed_block_count: number;
  retry_count_total: number;
  fetch_attempt_total: number;
  successful_block_count: number;
  consecutive_lag_polls: number;
  block_processing_latencies_ms: number[];
  aggregation_latencies_ms: number[];
};
