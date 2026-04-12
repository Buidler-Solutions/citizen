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
};
