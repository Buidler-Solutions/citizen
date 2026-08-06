use axum::extract::{DefaultBodyLimit, Path, Query};
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{serve, Json, Router};
use chrono::Utc;
use citizen_crypto::{
    canonical_json, hash_block_header, parse_verifying_key, sha256_hex, verify_signature,
};
use citizen_ledger::Ledger;
use citizen_storage::LedgerStorage;
use citizen_types::{
    BlockchainMode, Block, BlockHeader, BlockHeight, CommitProof, ConsentPolicyCheck, ConsentReceipt,
    DeterministicReceipt, DidDocument, DidStatus, FinalityProof, LedgerEntry,
    MultisigValidationSummary, NamespaceRuleset, OffchainCommitmentSummary,
    PayloadFieldCommitmentSummary, ProtocolError, ReceiptStatus, SignedEnvelope, ValidationSummary,
};
use ed25519_dalek::Signature;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use uuid::Uuid;

#[derive(Clone)]
pub struct ApiServer<S: LedgerStorage + 'static> {
    ledger: Arc<Ledger<S>>,
    edge: Arc<ApiEdgeState>,
}

#[derive(Clone, Debug)]
pub struct ApiEdgeConfig {
    pub write_enabled: bool,
    pub auth_required: bool,
    pub max_write_requests_per_minute: usize,
    pub namespace_rate_limits: HashMap<String, usize>,
    pub namespace_max_entry_bytes: HashMap<String, usize>,
    pub max_pending_entries: usize,
    pub offchain_encrypted_files_v1_enabled: bool,
    pub enforce_manifest_payload_binding: bool,
    pub require_builder_credit_for_all_writes: bool,
    pub blockchain_mode: BlockchainMode,
    pub clients: BTreeMap<String, ApiClientProfile>,
}

#[derive(Clone, Debug)]
pub struct ApiClientProfile {
    pub scopes: BTreeSet<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct BlocksQueryParams {
    cursor: Option<BlockHeight>,
    limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
struct DataHashQueryParams {
    q: Option<String>,
}

impl ApiClientProfile {
    pub fn with_scopes(scopes: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            scopes: scopes.into_iter().map(Into::into).collect(),
        }
    }
}

impl Default for ApiEdgeConfig {
    fn default() -> Self {
        Self {
            write_enabled: true,
            auth_required: false,
            max_write_requests_per_minute: 120,
            namespace_rate_limits: HashMap::new(),
            namespace_max_entry_bytes: HashMap::new(),
            max_pending_entries: 10_000,
            offchain_encrypted_files_v1_enabled: false,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: false,
            blockchain_mode: BlockchainMode::default(),
            clients: BTreeMap::new(),
        }
    }
}

struct ApiEdgeState {
    config: ApiEdgeConfig,
    object_store: Arc<dyn OffchainObjectStore>,
    write_windows: Mutex<BTreeMap<String, Vec<i64>>>,
    file_intents: Mutex<BTreeMap<Uuid, StoredFileIntent>>,
    committed_file_intents: Mutex<BTreeMap<Uuid, String>>,
    file_commit_idempotency: Mutex<BTreeMap<String, IdempotencyRecord>>,
    payload_commit_idempotency: Mutex<BTreeMap<String, IdempotencyRecord>>,
    file_manifests: Mutex<BTreeMap<String, StoredFileManifest>>,
    payload_field_refs: Mutex<BTreeMap<String, EncryptedFieldRef>>,
    file_access_alerts: Mutex<Vec<FileAccessAlert>>,
}

#[derive(Clone, Debug)]
struct IdempotencyRecord {
    request_hash: String,
    response: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
struct FileAccessAlert {
    alert_type: String,
    manifest_id: String,
    namespace: String,
    object_id: String,
    reader_did: String,
    detected_at: i64,
    detail: String,
}

#[derive(Clone, Debug)]
struct StoredFileManifest {
    manifest: serde_json::Value,
    intent: FileIntentRequest,
    committed_at: i64,
}

impl ApiEdgeState {
    fn new(config: ApiEdgeConfig, object_store: Arc<dyn OffchainObjectStore>) -> Self {
        Self {
            config,
            object_store,
            write_windows: Mutex::new(BTreeMap::new()),
            file_intents: Mutex::new(BTreeMap::new()),
            committed_file_intents: Mutex::new(BTreeMap::new()),
            file_commit_idempotency: Mutex::new(BTreeMap::new()),
            payload_commit_idempotency: Mutex::new(BTreeMap::new()),
            file_manifests: Mutex::new(BTreeMap::new()),
            payload_field_refs: Mutex::new(BTreeMap::new()),
            file_access_alerts: Mutex::new(Vec::new()),
        }
    }
}

#[derive(Clone, Debug)]
struct UploadIntentRequest {
    intent_id: Uuid,
    namespace: String,
    object_id: String,
    author_did: String,
    mime_type: String,
    file_size_bytes: u64,
    encryption_mode: String,
}

#[derive(Clone, Debug)]
struct UploadIntent {
    object_ref: String,
    upload_url: String,
    expires_at: i64,
}

#[derive(Clone, Debug)]
pub struct MinioOffchainObjectStoreConfig {
    pub endpoint: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub use_tls: bool,
    pub path_style: bool,
    pub key_prefix: String,
}

impl MinioOffchainObjectStoreConfig {
    pub fn new(
        endpoint: impl Into<String>,
        bucket: impl Into<String>,
        access_key: impl Into<String>,
        secret_key: impl Into<String>,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            bucket: bucket.into(),
            access_key: access_key.into(),
            secret_key: secret_key.into(),
            use_tls: true,
            path_style: true,
            key_prefix: "citizen/offchain-encrypted-files/v1".to_string(),
        }
    }
}

trait OffchainObjectStore: Send + Sync {
    fn create_upload_intent(&self, request: &UploadIntentRequest) -> Result<UploadIntent, String>;
    fn validate_object_ref(&self, namespace: &str, object_ref: &str) -> Result<(), String>;
}

#[derive(Clone, Debug, Default)]
struct LocalOffchainObjectStore;

impl OffchainObjectStore for LocalOffchainObjectStore {
    fn create_upload_intent(&self, request: &UploadIntentRequest) -> Result<UploadIntent, String> {
        let namespace_slug = urlencoding::encode(&request.namespace);
        let object_slug = urlencoding::encode(&request.object_id);
        let object_ref = format!(
            "blob://local/{}/{}/{}.cipher",
            namespace_slug, object_slug, request.intent_id
        );
        let upload_url = format!(
            "/api/v1/files/upload/local/{}/{}/{}?mime={}&mode={}&author={}&size={}",
            namespace_slug,
            object_slug,
            request.intent_id,
            urlencoding::encode(&request.mime_type),
            urlencoding::encode(&request.encryption_mode),
            urlencoding::encode(&request.author_did),
            request.file_size_bytes,
        );
        Ok(UploadIntent {
            object_ref,
            upload_url,
            expires_at: Utc::now().timestamp() + 900,
        })
    }

    fn validate_object_ref(&self, namespace: &str, object_ref: &str) -> Result<(), String> {
        let prefix = format!("blob://local/{}/", urlencoding::encode(namespace));
        if object_ref.starts_with(&prefix) {
            Ok(())
        } else {
            Err("manifest file_ref is not accepted by local storage policy".to_string())
        }
    }
}

#[derive(Clone, Debug)]
struct MinioOffchainObjectStore {
    endpoint: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    use_tls: bool,
    path_style: bool,
    key_prefix: String,
}

impl MinioOffchainObjectStore {
    fn from_config(config: MinioOffchainObjectStoreConfig) -> Result<Self, String> {
        if config.endpoint.trim().is_empty() {
            return Err("minio endpoint must not be empty".to_string());
        }
        if config.bucket.trim().is_empty() {
            return Err("minio bucket must not be empty".to_string());
        }
        if config.access_key.trim().is_empty() {
            return Err("minio access_key must not be empty".to_string());
        }
        if config.secret_key.trim().is_empty() {
            return Err("minio secret_key must not be empty".to_string());
        }
        let key_prefix = config.key_prefix.trim_matches('/').to_string();
        if key_prefix.is_empty() {
            return Err("minio key_prefix must not be empty".to_string());
        }
        Ok(Self {
            endpoint: config.endpoint,
            bucket: config.bucket,
            access_key: config.access_key,
            secret_key: config.secret_key,
            use_tls: config.use_tls,
            path_style: config.path_style,
            key_prefix,
        })
    }

    fn key_for(&self, namespace: &str, object_id: &str, intent_id: Uuid) -> String {
        format!(
            "{}/{}/{}/{}.cipher",
            self.key_prefix,
            urlencoding::encode(namespace),
            urlencoding::encode(object_id),
            intent_id
        )
    }

    fn expected_prefix_for_namespace(&self, namespace: &str) -> String {
        format!(
            "s3://{}/{}/{}/",
            self.bucket,
            self.key_prefix,
            urlencoding::encode(namespace)
        )
    }
}

impl OffchainObjectStore for MinioOffchainObjectStore {
    fn create_upload_intent(&self, request: &UploadIntentRequest) -> Result<UploadIntent, String> {
        let object_key = self.key_for(&request.namespace, &request.object_id, request.intent_id);
        let object_ref = format!("s3://{}/{}", self.bucket, object_key);
        let scheme = if self.use_tls { "https" } else { "http" };
        let base_url = if self.path_style {
            format!(
                "{scheme}://{}/{}/{}",
                self.endpoint, self.bucket, object_key
            )
        } else {
            format!(
                "{scheme}://{}.{}/{}",
                self.bucket, self.endpoint, object_key
            )
        };
        let upload_url = format!(
            "{base_url}?x-citizen-intent={}&x-citizen-namespace={}&x-citizen-author={}&x-citizen-mode={}&x-citizen-size={}",
            request.intent_id,
            urlencoding::encode(&request.namespace),
            urlencoding::encode(&request.author_did),
            urlencoding::encode(&request.encryption_mode),
            request.file_size_bytes
        );
        let _credential_hint = format!("{}:{}", self.access_key, self.secret_key.len());
        Ok(UploadIntent {
            object_ref,
            upload_url,
            expires_at: Utc::now().timestamp() + 900,
        })
    }

    fn validate_object_ref(&self, namespace: &str, object_ref: &str) -> Result<(), String> {
        let prefix = self.expected_prefix_for_namespace(namespace);
        if object_ref.starts_with(&prefix) {
            Ok(())
        } else {
            Err("manifest file_ref is not accepted by minio storage policy".to_string())
        }
    }
}

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

#[derive(Clone, Debug, Deserialize)]
struct FileIntentRequest {
    namespace: String,
    object_id: String,
    author_did: String,
    mime_type: String,
    file_size_bytes: u64,
    encryption_mode: String,
    consent_receipt: ConsentReceipt,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct FileCommitRequest {
    intent_id: Uuid,
    manifest: serde_json::Value,
    envelope: SignedEnvelope<LedgerEntry>,
}

#[derive(Clone, Debug, Deserialize)]
struct FileReadRequest {
    manifest_id: String,
    reader_did: String,
    consent_receipt: ConsentReceipt,
    observed_ciphertext_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct FileRevokeRequest {
    manifest_id: String,
    reader_did: String,
    envelope: SignedEnvelope<LedgerEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PayloadCommitRequest {
    namespace: String,
    object_id: String,
    author_did: String,
    #[serde(default = "default_payload_policy_version")]
    policy_version: u32,
    consent_receipt: ConsentReceipt,
    encrypted_field_refs: Vec<EncryptedFieldRef>,
    #[serde(default)]
    linked_manifest_ids: Vec<String>,
    envelope: SignedEnvelope<LedgerEntry>,
}

#[derive(Clone, Debug)]
struct PayloadFieldPolicyConfig {
    policy_version: u32,
    min_supported_policy_version: u32,
    migration_guide_ref: Option<String>,
    offchain_encrypted_fields: Vec<String>,
}

fn default_payload_policy_version() -> u32 {
    1
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct EncryptedFieldRef {
    field_path: String,
    blob_ref: String,
    ciphertext_hash: String,
    payload_commitment: String,
}

#[derive(Clone, Debug)]
struct StoredFileIntent {
    request: FileIntentRequest,
    created_at: i64,
    object_ref: String,
}

impl<S: LedgerStorage + 'static> ApiServer<S> {
    pub fn new(ledger: Arc<Ledger<S>>) -> Self {
        Self::with_edge_config(ledger, ApiEdgeConfig::default())
    }

    pub fn with_edge_config(ledger: Arc<Ledger<S>>, edge_config: ApiEdgeConfig) -> Self {
        Self::with_edge_config_and_store(ledger, edge_config, Arc::new(LocalOffchainObjectStore))
    }

    pub fn with_edge_config_and_minio_store(
        ledger: Arc<Ledger<S>>,
        edge_config: ApiEdgeConfig,
        store_config: MinioOffchainObjectStoreConfig,
    ) -> Result<Self, String> {
        let store = MinioOffchainObjectStore::from_config(store_config)?;
        Ok(Self::with_edge_config_and_store(
            ledger,
            edge_config,
            Arc::new(store),
        ))
    }

    pub(crate) fn with_edge_config_and_store(
        ledger: Arc<Ledger<S>>,
        edge_config: ApiEdgeConfig,
        object_store: Arc<dyn OffchainObjectStore>,
    ) -> Self {
        Self {
            ledger,
            edge: Arc::new(ApiEdgeState::new(edge_config, object_store)),
        }
    }

    pub async fn serve(self, addr: SocketAddr) -> JoinHandle<()> {
        let router = self.router();
        info!(%addr, "starting API server");
        tokio::spawn(async move {
            match TcpListener::bind(addr).await {
                Ok(listener) => {
                    if let Err(err) = serve(listener, router).await {
                        tracing::error!(?err, "api server error");
                    }
                }
                Err(err) => tracing::error!(?err, "failed to bind api server"),
            }
        })
    }

    fn router(&self) -> Router {
        let blocks_ledger = Arc::clone(&self.ledger);
        let blocks_list_ledger = Arc::clone(&self.ledger);
        let namespaces_ledger = Arc::clone(&self.ledger);
        let entries_ledger = Arc::clone(&self.ledger);
        let resolve_did_ledger = Arc::clone(&self.ledger);
        let consent_check_ledger = Arc::clone(&self.ledger);
        let submit_ledger = Arc::clone(&self.ledger);
        let submit_edge = Arc::clone(&self.edge);
        let submit_envelope_ledger = Arc::clone(&self.ledger);
        let submit_envelope_edge = Arc::clone(&self.edge);
        let submit_envelope_batch_ledger = Arc::clone(&self.ledger);
        let submit_envelope_batch_edge = Arc::clone(&self.edge);
        let file_intent_ledger = Arc::clone(&self.ledger);
        let file_intent_edge = Arc::clone(&self.edge);
        let file_commit_ledger = Arc::clone(&self.ledger);
        let file_commit_edge = Arc::clone(&self.edge);
        let payload_commit_ledger = Arc::clone(&self.ledger);
        let payload_commit_edge = Arc::clone(&self.edge);
        let payload_fields_edge = Arc::clone(&self.edge);
        let payload_data_hash_ledger = Arc::clone(&self.ledger);
        let payload_data_hash_edge = Arc::clone(&self.edge);
        let payload_data_hash_query_ledger = Arc::clone(&self.ledger);
        let payload_data_hash_query_edge = Arc::clone(&self.edge);
        let file_read_ledger = Arc::clone(&self.ledger);
        let file_read_edge = Arc::clone(&self.edge);
        let file_revoke_ledger = Arc::clone(&self.ledger);
        let file_revoke_edge = Arc::clone(&self.edge);
        let file_manifest_metadata_ledger = Arc::clone(&self.ledger);
        let file_manifest_metadata_edge = Arc::clone(&self.edge);
        let file_alerts_edge = Arc::clone(&self.edge);
        let get_receipt_ledger = Arc::clone(&self.ledger);
        let builder_credits_ledger = Arc::clone(&self.ledger);
        let asset_positions_ledger = Arc::clone(&self.ledger);
        let module_runtime_ledger = Arc::clone(&self.ledger);
        let module_execute_ledger = Arc::clone(&self.ledger);
        let interop_status_ledger = Arc::clone(&self.ledger);
        let governance_proposals_ledger = Arc::clone(&self.ledger);
        let civic_proposals_ledger = Arc::clone(&self.ledger);
        let civic_proposal_detail_ledger = Arc::clone(&self.ledger);
        let civic_tally_ledger = Arc::clone(&self.ledger);
        let civic_elections_ledger = Arc::clone(&self.ledger);
        let civic_election_detail_ledger = Arc::clone(&self.ledger);
        let civic_election_tally_ledger = Arc::clone(&self.ledger);
        let civic_election_ballots_ledger = Arc::clone(&self.ledger);
        let ctzn_token_status_ledger = Arc::clone(&self.ledger);
        let ctzn_token_holders_ledger = Arc::clone(&self.ledger);
        let ctzn_token_check_ledger = Arc::clone(&self.ledger);
        let civic_admin_check_ledger = Arc::clone(&self.ledger);
        let civic_kyc_pk_ledger = Arc::clone(&self.ledger);
        let civic_registry_ledger = Arc::clone(&self.ledger);
        let civic_eligibility_ledger = Arc::clone(&self.ledger);
        let identity_kyc_ledger = Arc::clone(&self.ledger);
        let identity_kyc_list_ledger = Arc::clone(&self.ledger);
        Router::new()
            .route("/health", get(Self::health))
            .route(
                "/blocks",
                get(move |Query(query): Query<BlocksQueryParams>| {
                    let ledger = Arc::clone(&blocks_list_ledger);
                    async move { Self::handle_list_blocks(ledger, query).await }
                }),
            )
            .route(
                "/blocks/:height",
                get(move |Path(height): Path<BlockHeight>| {
                    let ledger = Arc::clone(&blocks_ledger);
                    async move { Self::handle_get_block(ledger, height).await }
                }),
            )
            .route(
                "/namespaces",
                get(move || {
                    let ledger = Arc::clone(&namespaces_ledger);
                    async move { Self::handle_list_namespaces(ledger).await }
                }),
            )
            .route(
                "/entries/:namespace",
                get(move |Path(namespace): Path<String>| {
                    let ledger = Arc::clone(&entries_ledger);
                    async move { Self::handle_list_entries(ledger, namespace).await }
                }),
            )
            .route(
                "/api/v1/identity/:did",
                get(move |Path(did): Path<String>| {
                    let ledger = Arc::clone(&resolve_did_ledger);
                    async move { Self::handle_resolve_did(ledger, did).await }
                }),
            )
            .route(
                "/api/v1/consent/check",
                post(move |Json(receipt): Json<ConsentReceipt>| {
                    let ledger = Arc::clone(&consent_check_ledger);
                    async move { Self::handle_check_consent(ledger, receipt).await }
                }),
            )
            .route(
                "/api/v1/entries/submit",
                post(move |headers: HeaderMap, Json(entry): Json<LedgerEntry>| {
                    let ledger = Arc::clone(&submit_ledger);
                    let edge = Arc::clone(&submit_edge);
                    async move { Self::handle_submit_entry(ledger, edge, headers, entry).await }
                }),
            )
            .route(
                "/api/v1/envelopes/submit",
                post(
                    move |headers: HeaderMap, Json(envelope): Json<SignedEnvelope<LedgerEntry>>| {
                        let ledger = Arc::clone(&submit_envelope_ledger);
                        let edge = Arc::clone(&submit_envelope_edge);
                        async move {
                            Self::handle_submit_envelope(ledger, edge, headers, envelope).await
                        }
                    },
                ),
            )
            .route(
                "/api/v1/envelopes/submit-batch",
                post(
                    move |headers: HeaderMap,
                          Json(envelopes): Json<Vec<SignedEnvelope<LedgerEntry>>>| {
                        let ledger = Arc::clone(&submit_envelope_batch_ledger);
                        let edge = Arc::clone(&submit_envelope_batch_edge);
                        async move {
                            Self::handle_submit_envelope_batch(ledger, edge, headers, envelopes).await
                        }
                    },
                ),
            )
            .route(
                "/api/v1/files/intents",
                post(
                    move |headers: HeaderMap, Json(request): Json<FileIntentRequest>| {
                        let ledger = Arc::clone(&file_intent_ledger);
                        let edge = Arc::clone(&file_intent_edge);
                        async move {
                            Self::handle_create_file_intent(ledger, edge, headers, request).await
                        }
                    },
                ),
            )
            .route(
                "/api/v1/files/commit",
                post(move |headers: HeaderMap, Json(request): Json<FileCommitRequest>| {
                    let ledger = Arc::clone(&file_commit_ledger);
                    let edge = Arc::clone(&file_commit_edge);
                    async move { Self::handle_commit_file(ledger, edge, headers, request).await }
                }),
            )
            .route(
                "/api/v1/payloads/commit",
                post(
                    move |headers: HeaderMap, Json(request): Json<PayloadCommitRequest>| {
                        let ledger = Arc::clone(&payload_commit_ledger);
                        let edge = Arc::clone(&payload_fields_edge);
                        async move { Self::handle_commit_payload(ledger, edge, headers, request).await }
                    },
                ),
            )
            .route(
                "/api/v1/files/read",
                post(move |headers: HeaderMap, Json(request): Json<FileReadRequest>| {
                    let ledger = Arc::clone(&file_read_ledger);
                    let edge = Arc::clone(&file_read_edge);
                    async move { Self::handle_read_file(ledger, edge, headers, request).await }
                }),
            )
            .route(
                "/api/v1/files/revoke",
                post(move |headers: HeaderMap, Json(request): Json<FileRevokeRequest>| {
                    let ledger = Arc::clone(&file_revoke_ledger);
                    let edge = Arc::clone(&file_revoke_edge);
                    async move { Self::handle_revoke_file_reader(ledger, edge, headers, request).await }
                }),
            )
            .route(
                "/api/v1/files/manifests/:manifest_id",
                get(move |Path(manifest_id): Path<String>| {
                    let ledger = Arc::clone(&file_manifest_metadata_ledger);
                    let edge = Arc::clone(&file_manifest_metadata_edge);
                    async move { Self::handle_get_file_manifest_metadata(ledger, edge, manifest_id).await }
                }),
            )
            .route(
                "/api/v1/files/alerts",
                get(move |headers: HeaderMap| {
                    let edge = Arc::clone(&file_alerts_edge);
                    async move { Self::handle_list_file_access_alerts(edge, headers).await }
                }),
            )
            .route(
                "/api/v1/payloads/fields/:entry_id/:namespace",
                get(move |Path((entry_id, namespace)): Path<(Uuid, String)>| {
                    let edge = Arc::clone(&payload_commit_edge);
                    async move {
                        Self::handle_get_payload_field_refs(edge, entry_id, namespace).await
                    }
                }),
            )
            .route(
                "/api/v1/payloads/data-hash/:data_hash",
                get(move |Path(data_hash): Path<String>| {
                    let ledger = Arc::clone(&payload_data_hash_ledger);
                    let edge = Arc::clone(&payload_data_hash_edge);
                    async move { Self::handle_get_payload_data_hash(ledger, edge, data_hash).await }
                }),
            )
            .route(
                "/data-hash",
                get(move |Query(query): Query<DataHashQueryParams>| {
                    let ledger = Arc::clone(&payload_data_hash_query_ledger);
                    let edge = Arc::clone(&payload_data_hash_query_edge);
                    async move { Self::handle_get_payload_data_hash_query(ledger, edge, query).await }
                }),
            )
            .route(
                "/api/v1/receipts/:receipt_id",
                get(move |Path(receipt_id): Path<Uuid>| {
                    let ledger = Arc::clone(&get_receipt_ledger);
                    async move { Self::handle_get_receipt(ledger, receipt_id).await }
                }),
            )
            .route(
                "/api/v1/builder-credits/:builder_id",
                get(move |Path(builder_id): Path<String>| {
                    let ledger = Arc::clone(&builder_credits_ledger);
                    async move { Self::handle_get_builder_credits(ledger, builder_id).await }
                }),
            )
            .route(
                "/api/v1/assets/:account_id",
                get(move |Path(account_id): Path<String>| {
                    let ledger = Arc::clone(&asset_positions_ledger);
                    async move { Self::handle_get_asset_positions(ledger, account_id).await }
                }),
            )
            .route(
                "/api/v1/modules/:module_id",
                get(move |Path(module_id): Path<String>| {
                    let ledger = Arc::clone(&module_runtime_ledger);
                    async move { Self::handle_get_module_runtime(ledger, module_id).await }
                }),
            )
            .route(
                "/api/v1/modules/:module_id/execute",
                post(move |Path(module_id): Path<String>, Json(body): Json<serde_json::Value>| {
                    let ledger = Arc::clone(&module_execute_ledger);
                    async move { Self::handle_module_execute(ledger, module_id, body).await }
                }),
            )
            .route(
                "/api/v1/interop/:object_id",
                get(move |Path(object_id): Path<String>| {
                    let ledger = Arc::clone(&interop_status_ledger);
                    async move { Self::handle_get_interop_status(ledger, object_id).await }
                }),
            )
            .route(
                "/api/v1/governance/proposals",
                get(move || {
                    let ledger = Arc::clone(&governance_proposals_ledger);
                    async move { Self::handle_get_governance_proposals(ledger).await }
                }),
            )
            .route(
                "/api/v1/civic/proposals",
                get(move || {
                    let ledger = Arc::clone(&civic_proposals_ledger);
                    async move { Self::handle_list_civic_proposals(ledger).await }
                }),
            )
            .route(
                "/api/v1/civic/proposals/:proposal_id",
                get(move |Path(proposal_id): Path<String>| {
                    let ledger = Arc::clone(&civic_proposal_detail_ledger);
                    async move { Self::handle_get_civic_proposal(ledger, proposal_id).await }
                }),
            )
            .route(
                "/api/v1/civic/proposals/:proposal_id/tally",
                get(move |Path(proposal_id): Path<String>| {
                    let ledger = Arc::clone(&civic_tally_ledger);
                    async move { Self::handle_get_civic_tally(ledger, proposal_id).await }
                }),
            )
            .route(
                "/api/v1/civic/elections",
                get(move || {
                    let ledger = Arc::clone(&civic_elections_ledger);
                    async move { Self::handle_list_civic_elections(ledger).await }
                }),
            )
            .route(
                "/api/v1/civic/elections/:election_id",
                get(move |Path(election_id): Path<String>| {
                    let ledger = Arc::clone(&civic_election_detail_ledger);
                    async move { Self::handle_get_civic_election(ledger, election_id).await }
                }),
            )
            .route(
                "/api/v1/civic/elections/:election_id/tally",
                get(move |Path(election_id): Path<String>| {
                    let ledger = Arc::clone(&civic_election_tally_ledger);
                    async move { Self::handle_get_civic_election_tally(ledger, election_id).await }
                }),
            )
            .route(
                "/api/v1/civic/elections/:election_id/ballots",
                get(move |Path(election_id): Path<String>| {
                    let ledger = Arc::clone(&civic_election_ballots_ledger);
                    async move { Self::handle_get_civic_election_ballots(ledger, election_id).await }
                }),
            )
            .route(
                "/api/v1/ctzn/:module_id/status",
                get(move |Path(module_id): Path<String>| {
                    let ledger = Arc::clone(&ctzn_token_status_ledger);
                    async move { Self::handle_ctzn_status(ledger, module_id).await }
                }),
            )
            .route(
                "/api/v1/ctzn/:module_id/holders",
                get(move |Path(module_id): Path<String>| {
                    let ledger = Arc::clone(&ctzn_token_holders_ledger);
                    async move { Self::handle_ctzn_holders(ledger, module_id).await }
                }),
            )
            .route(
                "/api/v1/ctzn/:module_id/check/:did",
                get(move |Path((module_id, did)): Path<(String, String)>| {
                    let ledger = Arc::clone(&ctzn_token_check_ledger);
                    async move { Self::handle_ctzn_check(ledger, module_id, did).await }
                }),
            )
            .route(
                "/api/v1/civic/admin/check/:did",
                get(move |Path(did): Path<String>| {
                    let ledger = Arc::clone(&civic_admin_check_ledger);
                    async move { Self::handle_civic_admin_check(ledger, did).await }
                }),
            )
            .route(
                "/api/v1/civic/admin/kyc-public-key",
                get(move || {
                    let ledger = Arc::clone(&civic_kyc_pk_ledger);
                    async move { Self::handle_kyc_public_key(ledger).await }
                }),
            )
            .route(
                "/api/v1/civic/registry/:did",
                get(move |Path(did): Path<String>| {
                    let ledger = Arc::clone(&civic_registry_ledger);
                    async move { Self::handle_civic_registry_check(ledger, did).await }
                }),
            )
            .route(
                "/api/v1/civic/elections/:election_id/eligibility/:did",
                get(move |Path((election_id, did)): Path<(String, String)>| {
                    let ledger = Arc::clone(&civic_eligibility_ledger);
                    async move { Self::handle_voter_eligibility(ledger, election_id, did).await }
                }),
            )
            .route(
                "/api/v1/identity/kyc/:did",
                get(move |Path(did): Path<String>| {
                    let ledger = Arc::clone(&identity_kyc_ledger);
                    async move { Self::handle_kyc_status(ledger, did).await }
                }),
            )
            .route(
                "/api/v1/identity/kyc",
                get(move || {
                    let ledger = Arc::clone(&identity_kyc_list_ledger);
                    async move { Self::handle_kyc_list(ledger).await }
                }),
            )
            .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
            .layer(
                CorsLayer::new()
                    .allow_origin(Any)
                    .allow_methods(Any)
                    .allow_headers(Any),
            )
    }

    async fn health() -> Json<serde_json::Value> {
        Json(serde_json::json!({"status": "ok"}))
    }

    async fn handle_get_block(
        ledger: Arc<Ledger<S>>,
        height: BlockHeight,
    ) -> Json<serde_json::Value> {
        let block = ledger.storage().get_block(height).unwrap_or(None);
        Json(serde_json::json!({"height": height, "block": block}))
    }

    async fn handle_list_blocks(
        ledger: Arc<Ledger<S>>,
        query: BlocksQueryParams,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let limit = query.limit.unwrap_or(20);
        if limit == 0 || limit > 100 {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":"limit must be an integer between 1 and 100"})),
            );
        }

        let latest_height = ledger.storage().latest_height().unwrap_or(0);
        let has_any_blocks = ledger
            .storage()
            .get_block(latest_height)
            .unwrap_or(None)
            .is_some();

        if !has_any_blocks {
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "items": [],
                    "next_cursor": null,
                    "has_more": false
                })),
            );
        }

        let mut current_height =
            std::cmp::min(query.cursor.unwrap_or(latest_height), latest_height);
        let mut items = Vec::new();
        let mut scanned = 0usize;
        let mut exhausted_at_genesis = false;

        while scanned < limit {
            if let Some(block) = ledger.storage().get_block(current_height).unwrap_or(None) {
                items.push(serde_json::json!({
                    "height": current_height,
                    "header": block.header,
                    "entry_count": block.entries.len()
                }));
                scanned += 1;
            }

            if current_height == 0 {
                exhausted_at_genesis = true;
                break;
            }

            current_height -= 1;
        }

        let has_more = !exhausted_at_genesis && current_height <= latest_height;
        let next_cursor = if has_more {
            serde_json::Value::from(current_height)
        } else {
            serde_json::Value::Null
        };

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "items": items,
                "next_cursor": next_cursor,
                "has_more": has_more
            })),
        )
    }

    async fn handle_list_namespaces(ledger: Arc<Ledger<S>>) -> Json<serde_json::Value> {
        let namespaces = ledger.storage().namespace_registry().unwrap_or_default();
        Json(serde_json::json!({"namespaces": namespaces}))
    }

    async fn handle_list_entries(
        ledger: Arc<Ledger<S>>,
        namespace: String,
    ) -> Json<serde_json::Value> {
        let entries = ledger
            .storage()
            .namespace_entries(&namespace)
            .unwrap_or_default();
        Json(serde_json::json!({"namespace": namespace, "entries": entries}))
    }

    async fn handle_submit_entry(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        entry: LedgerEntry,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "entries.submit").await
        {
            return response;
        }
        if let Err(response) = Self::check_namespace_rate_limit(&edge, &entry.namespace).await {
            return response;
        }
        if let Err(response) = Self::check_namespace_entry_size(&edge, &entry) {
            return response;
        }
        if let Err(response) =
            Self::authorize_builder_credit_gate(Arc::clone(&edge), Arc::clone(&ledger), &entry)
        {
            return response;
        }
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: entry.author.clone(),
            signature: entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: Utc::now(),
            payload: entry,
        };
        Self::process_envelope_submission(ledger, envelope).await
    }

    async fn handle_resolve_did(
        ledger: Arc<Ledger<S>>,
        did: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let encoded_did = urlencoding::decode(&did)
            .map(|value| value.into_owned())
            .unwrap_or(did);
        let entries = ledger
            .storage()
            .namespace_entries(&"identity.citizen".to_string())
            .unwrap_or_default();
        let did_doc = Self::build_did_document(&encoded_did, &entries);
        match did_doc {
            Some(document) => (
                StatusCode::OK,
                Json(serde_json::json!({"did_document": document})),
            ),
            None => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "did not found"})),
            ),
        }
    }

    async fn handle_check_consent(
        ledger: Arc<Ledger<S>>,
        receipt: ConsentReceipt,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let now = Utc::now().timestamp();
        let check = Self::evaluate_consent_receipt(ledger, &receipt, now);
        let status = if check.valid {
            StatusCode::OK
        } else {
            StatusCode::UNPROCESSABLE_ENTITY
        };
        (status, Json(serde_json::json!({"result": check})))
    }

    async fn handle_submit_envelope(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        envelope: SignedEnvelope<LedgerEntry>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "envelopes.submit").await
        {
            return response;
        }
        if let Err(response) = Self::check_namespace_rate_limit(&edge, &envelope.payload.namespace).await {
            return response;
        }
        if let Err(response) = Self::check_namespace_entry_size(&edge, &envelope.payload) {
            return response;
        }
        if let Err(response) = Self::authorize_builder_credit_gate(
            Arc::clone(&edge),
            Arc::clone(&ledger),
            &envelope.payload,
        ) {
            return response;
        }
        Self::process_envelope_submission(ledger, envelope).await
    }

    async fn handle_submit_envelope_batch(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        envelopes: Vec<SignedEnvelope<LedgerEntry>>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "envelopes.submit").await
        {
            return response;
        }

        for envelope in &envelopes {
            if let Err(response) = Self::authorize_builder_credit_gate(
                Arc::clone(&edge),
                Arc::clone(&ledger),
                &envelope.payload,
            ) {
                return response;
            }
        }

        Self::process_envelope_batch_submission(ledger, envelopes).await
    }

    fn authorize_builder_credit_gate(
        edge: Arc<ApiEdgeState>,
        ledger: Arc<Ledger<S>>,
        entry: &LedgerEntry,
    ) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
        if !edge.config.require_builder_credit_for_all_writes {
            return Ok(());
        }
        if entry.namespace == "builder.credits"
            && matches!(
                entry.action.as_str(),
                "MULTISIG_CREDIT_GRANT" | "PROGRAMMABLE_CREDIT_GRANT"
            )
        {
            return Ok(());
        }

        let credit_grant_id = entry
            .payload
            .get("credit_grant_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({
                        "error": "builder credit grant required for all writes",
                        "detail": "payload.credit_grant_id is required",
                    })),
                )
            })?;

        let sponsoring_builder = entry
            .payload
            .get("sponsor_builder_id")
            .and_then(|value| value.as_str())
            .unwrap_or(entry.author.as_str());

        let grants = ledger
            .storage()
            .namespace_entries(&"builder.credits".to_string())
            .unwrap_or_default();
        let grant_exists = grants.iter().any(|existing| {
            existing.entry_id.to_string() == credit_grant_id
                && existing.object_id == sponsoring_builder
                && matches!(
                    existing.action.as_str(),
                    "MULTISIG_CREDIT_GRANT" | "PROGRAMMABLE_CREDIT_GRANT"
                )
        });

        if !grant_exists {
            return Err((
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "builder credit grant required for all writes",
                    "detail": "payload.credit_grant_id must reference an active builder grant for payload.sponsor_builder_id (or entry.author when sponsor_builder_id is omitted)",
                })),
            ));
        }

        Ok(())
    }

    async fn handle_create_file_intent(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        request: FileIntentRequest,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if !edge.config.offchain_encrypted_files_v1_enabled {
            return Self::offchain_feature_disabled_response();
        }

        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "files.intents.create").await
        {
            return response;
        }

        let Some(ruleset) = ledger.namespace_ruleset(&request.namespace) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "namespace not found"})),
            );
        };

        let Some(policy) = ruleset
            .validators
            .iter()
            .find(|rule| rule.name == "offchain_encrypted_file_policy")
            .map(|rule| &rule.config)
        else {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "namespace is missing offchain_encrypted_file_policy"
                })),
            );
        };

        if policy.get("enabled").and_then(|value| value.as_bool()) == Some(false) {
            return (
                StatusCode::FORBIDDEN,
                Json(
                    serde_json::json!({"error": "off-chain encrypted files are disabled for namespace"}),
                ),
            );
        }

        if let Some(max_size) = policy
            .get("max_file_size_bytes")
            .and_then(|value| value.as_u64())
        {
            if request.file_size_bytes > max_size {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(serde_json::json!({
                        "error": "file size exceeds namespace policy limit",
                        "max_file_size_bytes": max_size
                    })),
                );
            }
        }

        if let Some(allowed_mimes) = policy
            .get("allowed_mime_types")
            .and_then(|value| value.as_array())
        {
            let mime_allowed = allowed_mimes
                .iter()
                .filter_map(|value| value.as_str())
                .any(|value| value == request.mime_type);
            if !mime_allowed {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(
                        serde_json::json!({"error": "mime type is not allowed by namespace policy"}),
                    ),
                );
            }
        }

        if let Some(allowed_modes) = policy
            .get("allowed_encryption_modes")
            .and_then(|value| value.as_array())
        {
            let mode_allowed = allowed_modes
                .iter()
                .filter_map(|value| value.as_str())
                .any(|value| value == request.encryption_mode);
            if !mode_allowed {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(
                        serde_json::json!({"error": "encryption mode is not allowed by namespace policy"}),
                    ),
                );
            }
        }

        if let Err(error) = Self::validate_required_consent_policy(policy, &request.consent_receipt)
        {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error": error})),
            );
        }

        let now = Utc::now().timestamp();
        let consent_status =
            Self::evaluate_consent_receipt(Arc::clone(&ledger), &request.consent_receipt, now);
        if !consent_status.valid {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": consent_status
                        .reason
                        .unwrap_or_else(|| "consent check failed".to_string())
                })),
            );
        }

        let intent_id = Uuid::new_v4();
        let upload_intent = match edge
            .object_store
            .create_upload_intent(&UploadIntentRequest {
                intent_id,
                namespace: request.namespace.clone(),
                object_id: request.object_id.clone(),
                author_did: request.author_did.clone(),
                mime_type: request.mime_type.clone(),
                file_size_bytes: request.file_size_bytes,
                encryption_mode: request.encryption_mode.clone(),
            }) {
            Ok(intent) => intent,
            Err(message) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({"error": message})),
                )
            }
        };

        edge.file_intents.lock().await.insert(
            intent_id,
            StoredFileIntent {
                request: request.clone(),
                created_at: now,
                object_ref: upload_intent.object_ref.clone(),
            },
        );

        (
            StatusCode::CREATED,
            Json(serde_json::json!({
                "intent_id": intent_id,
                "namespace": request.namespace,
                "object_id": request.object_id,
                "author_did": request.author_did,
                "upload": {
                    "object_ref": upload_intent.object_ref,
                    "upload_url": upload_intent.upload_url,
                    "expires_at": upload_intent.expires_at,
                },
                "constraints": {
                    "max_file_size_bytes": policy.get("max_file_size_bytes").cloned().unwrap_or(serde_json::Value::Null),
                    "allowed_mime_types": policy.get("allowed_mime_types").cloned().unwrap_or_else(|| serde_json::json!([])),
                    "allowed_encryption_modes": policy.get("allowed_encryption_modes").cloned().unwrap_or_else(|| serde_json::json!([])),
                }
            })),
        )
    }

    async fn handle_commit_file(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        request: FileCommitRequest,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if !edge.config.offchain_encrypted_files_v1_enabled {
            return Self::offchain_feature_disabled_response();
        }

        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "files.commit").await
        {
            return response;
        }

        let idempotency_key = match Self::required_idempotency_key(&headers) {
            Ok(key) => key,
            Err(response) => return response,
        };

        let request_value = match serde_json::to_value(&request) {
            Ok(value) => value,
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": format!("failed to canonicalize file commit request: {err}")
                    })),
                )
            }
        };
        let request_hash = sha256_hex(&canonical_json(&request_value));

        if let Some(cached) = edge
            .file_commit_idempotency
            .lock()
            .await
            .get(&idempotency_key)
            .cloned()
        {
            if cached.request_hash != request_hash {
                return (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "error": "idempotency key reuse with different request payload",
                        "idempotency_key": idempotency_key,
                    })),
                );
            }
            return (StatusCode::OK, Json(cached.response));
        }

        if let Some(manifest_id) = edge
            .committed_file_intents
            .lock()
            .await
            .get(&request.intent_id)
            .cloned()
        {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "file intent already committed",
                    "intent_id": request.intent_id,
                    "manifest_id": manifest_id,
                })),
            );
        }

        let intent = {
            let intents = edge.file_intents.lock().await;
            intents.get(&request.intent_id).cloned()
        };

        let Some(intent) = intent else {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "file intent not found"})),
            );
        };

        if request.envelope.payload.namespace != intent.request.namespace
            || request.envelope.payload.object_id != intent.request.object_id
            || request.envelope.payload.author != intent.request.author_did
        {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error": "file commit envelope does not match intent"})),
            );
        }

        let Some(ruleset) = ledger.namespace_ruleset(&intent.request.namespace) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "namespace not found"})),
            );
        };

        let Some(policy) = ruleset
            .validators
            .iter()
            .find(|rule| rule.name == "offchain_encrypted_file_policy")
            .map(|rule| &rule.config)
        else {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "namespace is missing offchain_encrypted_file_policy"
                })),
            );
        };

        let allowed_actions = Self::allowed_file_actions(policy);
        if !allowed_actions
            .iter()
            .any(|action| action == request.envelope.payload.action.as_str())
        {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "file commit envelope action is not allowed by namespace policy",
                    "allowed_actions": allowed_actions,
                })),
            );
        }

        if let Err(message) = Self::validate_manifest_against_intent(
            &request.manifest,
            &intent.request,
            policy,
            &intent.object_ref,
            edge.object_store.as_ref(),
        ) {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({ "error": message })),
            );
        }

        let manifest_commitment = sha256_hex(&canonical_json(&request.manifest));
        let manifest_id = manifest_commitment.clone();
        let now = Utc::now().timestamp();

        if edge.config.enforce_manifest_payload_binding {
            let envelope_manifest_id = request
                .envelope
                .payload
                .payload
                .get("manifest_id")
                .and_then(serde_json::Value::as_str);
            if envelope_manifest_id != Some(manifest_id.as_str()) {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(serde_json::json!({
                        "error": "file commit envelope payload.manifest_id must equal canonical manifest_id",
                        "expected_manifest_id": manifest_id,
                    })),
                );
            }
        }

        if let Err(response) = Self::authorize_builder_credit_gate(
            Arc::clone(&edge),
            Arc::clone(&ledger),
            &request.envelope.payload,
        ) {
            return response;
        }

        let (status, Json(base)) =
            Self::process_envelope_submission(ledger, request.envelope).await;
        if status != StatusCode::ACCEPTED {
            return (status, Json(base));
        }

        edge.file_manifests.lock().await.insert(
            manifest_id.clone(),
            StoredFileManifest {
                manifest: request.manifest.clone(),
                intent: intent.request.clone(),
                committed_at: now,
            },
        );
        edge.file_intents.lock().await.remove(&request.intent_id);
        edge.committed_file_intents
            .lock()
            .await
            .insert(request.intent_id, manifest_id.clone());

        let response = serde_json::json!({
            "status": "accepted",
            "intent_id": request.intent_id,
            "manifest_id": manifest_id,
            "manifest_commitment": manifest_commitment,
            "intent_created_at": intent.created_at,
            "result": base,
        });
        edge.file_commit_idempotency.lock().await.insert(
            idempotency_key,
            IdempotencyRecord {
                request_hash,
                response: response.clone(),
            },
        );

        (StatusCode::ACCEPTED, Json(response))
    }

    async fn handle_commit_payload(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        request: PayloadCommitRequest,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if !edge.config.offchain_encrypted_files_v1_enabled {
            return Self::offchain_feature_disabled_response();
        }

        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "payloads.commit").await
        {
            return response;
        }

        let idempotency_key = match Self::required_idempotency_key(&headers) {
            Ok(key) => key,
            Err(response) => return response,
        };

        let request_value = match serde_json::to_value(&request) {
            Ok(value) => value,
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": format!("failed to canonicalize payload commit request: {err}")
                    })),
                )
            }
        };
        let request_hash = sha256_hex(&canonical_json(&request_value));

        if let Some(cached) = edge
            .payload_commit_idempotency
            .lock()
            .await
            .get(&idempotency_key)
            .cloned()
        {
            if cached.request_hash != request_hash {
                return (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "error": "idempotency key reuse with different request payload",
                        "idempotency_key": idempotency_key,
                    })),
                );
            }
            return (StatusCode::OK, Json(cached.response));
        }

        let now = Utc::now().timestamp();
        let consent_status =
            Self::evaluate_consent_receipt(Arc::clone(&ledger), &request.consent_receipt, now);
        if !consent_status.valid {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": consent_status
                        .reason
                        .unwrap_or_else(|| "consent check failed".to_string())
                })),
            );
        }

        if request.envelope.payload.namespace != request.namespace
            || request.envelope.payload.object_id != request.object_id
            || request.envelope.payload.author != request.author_did
        {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(
                    serde_json::json!({"error": "payload commit envelope does not match request"}),
                ),
            );
        }

        if request.envelope.payload.action != "ENCRYPTED_PAYLOAD_FIELD_COMMIT" {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "payload commit envelope action must be ENCRYPTED_PAYLOAD_FIELD_COMMIT"
                })),
            );
        }

        let Some(ruleset) = ledger.namespace_ruleset(&request.namespace) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "namespace not found"})),
            );
        };

        if let Some(file_policy) = ruleset
            .validators
            .iter()
            .find(|rule| rule.name == "offchain_encrypted_file_policy")
            .map(|rule| &rule.config)
        {
            if let Err(error) =
                Self::validate_required_consent_policy(file_policy, &request.consent_receipt)
            {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(serde_json::json!({"error": error})),
                );
            }
        }

        let Some(payload_field_policy) = Self::parse_payload_field_policy(&ruleset) else {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "namespace is missing offchain_encrypted_payload_field_policy"
                })),
            );
        };

        if request.policy_version < payload_field_policy.min_supported_policy_version {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "submitted payload policy version is below namespace minimum",
                    "submitted_policy_version": request.policy_version,
                    "min_supported_policy_version": payload_field_policy.min_supported_policy_version,
                    "migration_guide_ref": payload_field_policy.migration_guide_ref,
                })),
            );
        }

        if request.policy_version != payload_field_policy.policy_version {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "submitted payload policy version does not match namespace policy",
                    "submitted_policy_version": request.policy_version,
                    "expected_policy_version": payload_field_policy.policy_version,
                    "migration_guide_ref": payload_field_policy.migration_guide_ref,
                })),
            );
        }

        let required_fields = payload_field_policy.offchain_encrypted_fields;

        let submitted_fields: BTreeSet<String> = request
            .encrypted_field_refs
            .iter()
            .map(|field| field.field_path.clone())
            .collect();

        let missing: Vec<String> = required_fields
            .iter()
            .filter(|field| !submitted_fields.contains(field.as_str()))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "missing encrypted field references required by namespace policy",
                    "missing_fields": missing,
                })),
            );
        }

        let unexpected: Vec<String> = submitted_fields
            .iter()
            .filter(|field| !required_fields.iter().any(|required| required == *field))
            .cloned()
            .collect();
        if !unexpected.is_empty() {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "encrypted field references include paths not allowed by namespace policy",
                    "unexpected_fields": unexpected,
                })),
            );
        }

        let plaintext_conflicts: Vec<String> = required_fields
            .iter()
            .filter(|field| Self::json_path_exists(&request.envelope.payload.payload, field))
            .cloned()
            .collect();
        if !plaintext_conflicts.is_empty() {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "required encrypted fields must not appear in plaintext payload",
                    "plaintext_fields": plaintext_conflicts,
                })),
            );
        }

        let invalid_blob_refs: Vec<serde_json::Value> = request
            .encrypted_field_refs
            .iter()
            .filter_map(|field_ref| {
                edge.object_store
                    .validate_object_ref(&request.namespace, &field_ref.blob_ref)
                    .err()
                    .map(|reason| {
                        serde_json::json!({
                            "field_path": field_ref.field_path,
                            "blob_ref": field_ref.blob_ref,
                            "reason": reason,
                        })
                    })
            })
            .collect();
        if !invalid_blob_refs.is_empty() {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "encrypted field blob_ref is not accepted by storage policy",
                    "invalid_blob_refs": invalid_blob_refs,
                })),
            );
        }

        let linked_manifests: Vec<StoredFileManifest> = if request.linked_manifest_ids.is_empty() {
            Vec::new()
        } else {
            let manifests = edge.file_manifests.lock().await;
            let mut missing = Vec::new();
            let mut linked = Vec::new();
            for manifest_id in &request.linked_manifest_ids {
                let Some(stored_manifest) = manifests.get(manifest_id) else {
                    missing.push(manifest_id.clone());
                    continue;
                };
                if stored_manifest.intent.namespace != request.namespace
                    || stored_manifest.intent.object_id != request.object_id
                {
                    return (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        Json(serde_json::json!({
                            "error": "linked manifest namespace/object mismatch for payload commit",
                            "manifest_id": manifest_id,
                        })),
                    );
                }
                linked.push(stored_manifest.clone());
            }
            if !missing.is_empty() {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(serde_json::json!({
                        "error": "linked manifest not found for payload commit",
                        "missing_manifest_ids": missing,
                    })),
                );
            }
            linked
        };

        if !linked_manifests.is_empty() {
            let allowed_refs: BTreeSet<String> = linked_manifests
                .iter()
                .filter_map(|stored_manifest| {
                    stored_manifest
                        .manifest
                        .get("file_ref")
                        .and_then(serde_json::Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .collect();
            let unlinked_blob_refs: Vec<String> = request
                .encrypted_field_refs
                .iter()
                .filter(|field_ref| !allowed_refs.contains(&field_ref.blob_ref))
                .map(|field_ref| field_ref.blob_ref.clone())
                .collect();
            if !unlinked_blob_refs.is_empty() {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(serde_json::json!({
                        "error": "payload encrypted field blob_ref must reference a linked committed manifest",
                        "unlinked_blob_refs": unlinked_blob_refs,
                    })),
                );
            }
        }

        let entry_id = request.envelope.payload.entry_id.to_string();
        let commitment_mismatches: Vec<serde_json::Value> = request
            .encrypted_field_refs
            .iter()
            .filter_map(|field_ref| {
                let expected = Self::compute_payload_field_commitment(
                    &request.namespace,
                    &entry_id,
                    request.policy_version,
                    &field_ref.field_path,
                    &field_ref.ciphertext_hash,
                );
                if expected == field_ref.payload_commitment {
                    None
                } else {
                    Some(serde_json::json!({
                        "field_path": field_ref.field_path,
                        "provided_payload_commitment": field_ref.payload_commitment,
                        "expected_payload_commitment": expected,
                    }))
                }
            })
            .collect();
        if !commitment_mismatches.is_empty() {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "encrypted field payload_commitment does not match canonical commitment derivation",
                    "mismatches": commitment_mismatches,
                })),
            );
        }

        let entry_id = request.envelope.payload.entry_id;
        if let Err(response) = Self::authorize_builder_credit_gate(
            Arc::clone(&edge),
            Arc::clone(&ledger),
            &request.envelope.payload,
        ) {
            return response;
        }

        let (status, Json(base)) =
            Self::process_envelope_submission(ledger, request.envelope).await;
        if status != StatusCode::ACCEPTED {
            return (status, Json(base));
        }

        {
            let mut refs = edge.payload_field_refs.lock().await;
            for field_ref in &request.encrypted_field_refs {
                let refs_key = format!(
                    "{}:{}:{}",
                    entry_id, request.namespace, field_ref.field_path
                );
                refs.insert(refs_key, field_ref.clone());
            }
        }

        let response = serde_json::json!({
            "status": "accepted",
            "namespace": request.namespace,
            "object_id": request.object_id,
            "linked_manifest_ids": request.linked_manifest_ids,
            "encrypted_field_refs": request.encrypted_field_refs,
            "result": base,
        });
        edge.payload_commit_idempotency.lock().await.insert(
            idempotency_key,
            IdempotencyRecord {
                request_hash,
                response: response.clone(),
            },
        );

        (StatusCode::ACCEPTED, Json(response))
    }

    async fn handle_read_file(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        request: FileReadRequest,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if !edge.config.offchain_encrypted_files_v1_enabled {
            return Self::offchain_feature_disabled_response();
        }

        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "files.read").await
        {
            return response;
        }

        let stored_manifest = {
            let manifests = edge.file_manifests.lock().await;
            manifests.get(&request.manifest_id).cloned()
        };

        let Some(stored_manifest) = stored_manifest else {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "file manifest not found"})),
            );
        };

        let now = Utc::now().timestamp();
        let consent_status =
            Self::evaluate_consent_receipt(Arc::clone(&ledger), &request.consent_receipt, now);
        if !consent_status.valid {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": consent_status
                        .reason
                        .unwrap_or_else(|| "consent check failed".to_string())
                })),
            );
        }

        if request.consent_receipt.subject_did != stored_manifest.intent.object_id {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "consent subject_did does not match file object_id"
                })),
            );
        }

        if !request.consent_receipt.authorized_readers.is_empty()
            && !request
                .consent_receipt
                .authorized_readers
                .iter()
                .any(|reader| reader == &request.reader_did)
        {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "reader DID is not authorized by consent receipt"
                })),
            );
        }

        let revoked = ledger
            .storage()
            .namespace_entries(&stored_manifest.intent.namespace)
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| {
                entry.object_id == stored_manifest.intent.object_id
                    && entry.action == "ENCRYPTED_FILE_REVOKE"
            })
            .any(|entry| {
                entry
                    .payload
                    .get("manifest_id")
                    .and_then(|value| value.as_str())
                    == Some(request.manifest_id.as_str())
                    && entry
                        .payload
                        .get("reader_did")
                        .and_then(|value| value.as_str())
                        .map(|reader| reader == request.reader_did)
                        .unwrap_or(true)
            });

        if revoked {
            Self::record_file_access_alert(
                Arc::clone(&edge),
                FileAccessAlert {
                    alert_type: "revocation_conflict".to_string(),
                    manifest_id: request.manifest_id.clone(),
                    namespace: stored_manifest.intent.namespace.clone(),
                    object_id: stored_manifest.intent.object_id.clone(),
                    reader_did: request.reader_did.clone(),
                    detected_at: now,
                    detail:
                        "reader requested a manifest that has an active ENCRYPTED_FILE_REVOKE event"
                            .to_string(),
                },
            )
            .await;
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "file read access revoked for reader DID"
                })),
            );
        }

        let manifest = stored_manifest.manifest;
        let file_ref = manifest
            .get("file_ref")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let ciphertext_hash = manifest
            .get("ciphertext_hash")
            .and_then(|value| value.as_str())
            .unwrap_or_default();

        if let Some(observed_ciphertext_hash) = request.observed_ciphertext_hash.as_deref() {
            if observed_ciphertext_hash != ciphertext_hash {
                Self::record_file_access_alert(
                    Arc::clone(&edge),
                    FileAccessAlert {
                        alert_type: "commitment_mismatch".to_string(),
                        manifest_id: request.manifest_id.clone(),
                        namespace: stored_manifest.intent.namespace.clone(),
                        object_id: stored_manifest.intent.object_id.clone(),
                        reader_did: request.reader_did.clone(),
                        detected_at: now,
                        detail: format!(
                            "observed ciphertext hash {} did not match committed {}",
                            observed_ciphertext_hash, ciphertext_hash
                        ),
                    },
                )
                .await;
                return (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "error": "ciphertext hash mismatch for manifest",
                        "manifest_id": request.manifest_id,
                    })),
                );
            }
        }

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "ok",
                "manifest_id": request.manifest_id,
                "namespace": stored_manifest.intent.namespace,
                "object_id": stored_manifest.intent.object_id,
                "reader_did": request.reader_did,
                "committed_at": stored_manifest.committed_at,
                "file_ref": file_ref,
                "ciphertext_hash": ciphertext_hash,
                "revoked": false,
            })),
        )
    }

    async fn handle_revoke_file_reader(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        request: FileRevokeRequest,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if !edge.config.offchain_encrypted_files_v1_enabled {
            return Self::offchain_feature_disabled_response();
        }

        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "files.revoke").await
        {
            return response;
        }

        let stored_manifest = {
            let manifests = edge.file_manifests.lock().await;
            manifests.get(&request.manifest_id).cloned()
        };

        let Some(stored_manifest) = stored_manifest else {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "file manifest not found"})),
            );
        };

        let payload = &request.envelope.payload;
        if payload.namespace != stored_manifest.intent.namespace
            || payload.object_id != stored_manifest.intent.object_id
        {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "revoke envelope must target manifest namespace/object"
                })),
            );
        }

        if payload.action != "ENCRYPTED_FILE_REVOKE" {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "revoke envelope action must be ENCRYPTED_FILE_REVOKE"
                })),
            );
        }

        let manifest_match = payload
            .payload
            .get("manifest_id")
            .and_then(|value| value.as_str())
            .map(|manifest_id| manifest_id == request.manifest_id)
            .unwrap_or(false);
        if !manifest_match {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "revoke envelope payload.manifest_id must match request manifest_id"
                })),
            );
        }

        let reader_match = payload
            .payload
            .get("reader_did")
            .and_then(|value| value.as_str())
            .map(|reader_did| reader_did == request.reader_did)
            .unwrap_or(false);
        if !reader_match {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": "revoke envelope payload.reader_did must match request reader_did"
                })),
            );
        }

        if let Err(response) = Self::authorize_builder_credit_gate(
            Arc::clone(&edge),
            Arc::clone(&ledger),
            &request.envelope.payload,
        ) {
            return response;
        }

        let (status, Json(base)) =
            Self::process_envelope_submission(Arc::clone(&ledger), request.envelope).await;
        if status != StatusCode::ACCEPTED {
            return (status, Json(base));
        }

        let now = Utc::now().timestamp();
        Self::record_file_access_alert(
            Arc::clone(&edge),
            FileAccessAlert {
                alert_type: "reader_revoked".to_string(),
                manifest_id: request.manifest_id.clone(),
                namespace: stored_manifest.intent.namespace,
                object_id: stored_manifest.intent.object_id,
                reader_did: request.reader_did.clone(),
                detected_at: now,
                detail: "reader access revoked via ENCRYPTED_FILE_REVOKE event".to_string(),
            },
        )
        .await;

        (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "status": "accepted",
                "manifest_id": request.manifest_id,
                "reader_did": request.reader_did,
                "result": base,
            })),
        )
    }

    async fn handle_get_file_manifest_metadata(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        manifest_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if !edge.config.offchain_encrypted_files_v1_enabled {
            return Self::offchain_feature_disabled_response();
        }

        let stored_manifest = {
            let manifests = edge.file_manifests.lock().await;
            manifests.get(&manifest_id).cloned()
        };

        let Some(stored_manifest) = stored_manifest else {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "file manifest not found"})),
            );
        };

        let now = Utc::now().timestamp();
        let consent_status = Self::evaluate_consent_receipt(
            Arc::clone(&ledger),
            &stored_manifest.intent.consent_receipt,
            now,
        );

        let revoked_readers = ledger
            .storage()
            .namespace_entries(&stored_manifest.intent.namespace)
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| {
                entry.object_id == stored_manifest.intent.object_id
                    && entry.action == "ENCRYPTED_FILE_REVOKE"
            })
            .filter(|entry| {
                entry
                    .payload
                    .get("manifest_id")
                    .and_then(|value| value.as_str())
                    == Some(manifest_id.as_str())
            })
            .filter_map(|entry| {
                entry
                    .payload
                    .get("reader_did")
                    .and_then(|value| value.as_str().map(ToOwned::to_owned))
            })
            .collect::<Vec<String>>();

        let manifest = stored_manifest.manifest;
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "manifest_id": manifest_id,
                "namespace": stored_manifest.intent.namespace,
                "object_id": stored_manifest.intent.object_id,
                "committed_at": stored_manifest.committed_at,
                "encryption_mode": manifest.get("encryption_mode").cloned().unwrap_or(serde_json::Value::Null),
                "ciphertext_hash": manifest.get("ciphertext_hash").cloned().unwrap_or(serde_json::Value::Null),
                "payload_commitment": manifest.get("payload_commitment").cloned().unwrap_or(serde_json::Value::Null),
                "consent_receipt_ref": manifest.get("consent_receipt_ref").cloned().unwrap_or(serde_json::Value::Null),
                "consent_state": if consent_status.valid { "active" } else { "invalid" },
                "consent_state_reason": consent_status.reason,
                "revoked_readers": revoked_readers,
            })),
        )
    }

    async fn handle_list_file_access_alerts(
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if !edge.config.offchain_encrypted_files_v1_enabled {
            return Self::offchain_feature_disabled_response();
        }

        if let Err(response) =
            Self::authorize_scope(Arc::clone(&edge), &headers, "files.alerts.read", false).await
        {
            return response;
        }

        let alerts = edge.file_access_alerts.lock().await.clone();
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "alerts": alerts,
            })),
        )
    }

    async fn handle_get_payload_field_refs(
        edge: Arc<ApiEdgeState>,
        entry_id: Uuid,
        namespace: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if !edge.config.offchain_encrypted_files_v1_enabled {
            return Self::offchain_feature_disabled_response();
        }

        let refs = edge.payload_field_refs.lock().await;
        let prefix = format!("{entry_id}:{namespace}:");
        let mut field_refs: Vec<EncryptedFieldRef> = refs
            .iter()
            .filter_map(|(key, value)| {
                if key.starts_with(&prefix) {
                    Some(value.clone())
                } else {
                    None
                }
            })
            .collect();

        if field_refs.is_empty() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "encrypted payload field refs not found",
                    "entry_id": entry_id,
                    "namespace": namespace,
                })),
            );
        }

        field_refs.sort_by(|left, right| left.field_path.cmp(&right.field_path));

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "entry_id": entry_id,
                "namespace": namespace,
                "field_refs": field_refs,
            })),
        )
    }

    async fn handle_get_payload_data_hash(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        data_hash: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let _ = edge;

        let normalized_data_hash = Self::normalize_data_hash(&data_hash);
        let mut matches = Vec::new();
        let namespaces = ledger.storage().namespace_registry().unwrap_or_default();

        for descriptor in namespaces {
            let entries = ledger
                .storage()
                .namespace_entries(&descriptor.namespace)
                .unwrap_or_default();
            for entry in entries {
                let matched_payload_commitment = entry.payload_commitment.as_deref()
                    == Some(data_hash.as_str())
                    || entry.payload_commitment.as_deref() == Some(normalized_data_hash.as_str());
                if matched_payload_commitment {
                    matches.push(serde_json::json!({
                        "entry_id": entry.entry_id,
                        "namespace": entry.namespace,
                        "action": entry.action,
                        "object_id": entry.object_id,
                        "timestamp": entry.timestamp,
                        "source": "payload_commitment",
                    }));
                }

                if entry.namespace == "consent.receipt"
                    && (entry
                        .payload
                        .get("data_hash")
                        .and_then(|value| value.as_str())
                        == Some(data_hash.as_str())
                        || entry
                            .payload
                            .get("data_hash")
                            .and_then(|value| value.as_str())
                            == Some(normalized_data_hash.as_str()))
                {
                    matches.push(serde_json::json!({
                        "entry_id": entry.entry_id,
                        "namespace": entry.namespace,
                        "action": entry.action,
                        "object_id": entry.object_id,
                        "timestamp": entry.timestamp,
                        "source": "consent_receipt.data_hash",
                    }));
                }

                let payload_data_hash = entry
                    .payload
                    .get("data_hash")
                    .and_then(|value| value.as_str());
                let nested_payload_data_hash = entry
                    .payload
                    .get("payload")
                    .and_then(|value| value.as_object())
                    .and_then(|payload| payload.get("data_hash"))
                    .and_then(|value| value.as_str());

                if entry.namespace != "consent.receipt"
                    && !matched_payload_commitment
                    && (payload_data_hash == Some(data_hash.as_str())
                        || payload_data_hash == Some(normalized_data_hash.as_str())
                        || nested_payload_data_hash == Some(data_hash.as_str())
                        || nested_payload_data_hash == Some(normalized_data_hash.as_str()))
                {
                    matches.push(serde_json::json!({
                        "entry_id": entry.entry_id,
                        "namespace": entry.namespace,
                        "action": entry.action,
                        "object_id": entry.object_id,
                        "timestamp": entry.timestamp,
                        "source": "payload.data_hash",
                    }));
                }
            }
        }

        if matches.is_empty() {
            let latest_height = ledger.storage().latest_height().unwrap_or(0);
            for height in 0..=latest_height {
                let block = ledger.storage().get_block(height).unwrap_or(None);
                let Some(block) = block else {
                    continue;
                };

                for entry in block.entries {
                    let matched_payload_commitment = entry.payload_commitment.as_deref()
                        == Some(data_hash.as_str())
                        || entry.payload_commitment.as_deref()
                            == Some(normalized_data_hash.as_str());
                    if matched_payload_commitment {
                        matches.push(serde_json::json!({
                            "entry_id": entry.entry_id,
                            "namespace": entry.namespace,
                            "action": entry.action,
                            "object_id": entry.object_id,
                            "timestamp": entry.timestamp,
                            "source": "payload_commitment",
                        }));
                    }

                    if entry.namespace == "consent.receipt"
                        && (entry
                            .payload
                            .get("data_hash")
                            .and_then(|value| value.as_str())
                            == Some(data_hash.as_str())
                            || entry
                                .payload
                                .get("data_hash")
                                .and_then(|value| value.as_str())
                                == Some(normalized_data_hash.as_str()))
                    {
                        matches.push(serde_json::json!({
                            "entry_id": entry.entry_id,
                            "namespace": entry.namespace,
                            "action": entry.action,
                            "object_id": entry.object_id,
                            "timestamp": entry.timestamp,
                            "source": "consent_receipt.data_hash",
                        }));
                    }

                    let payload_data_hash = entry
                        .payload
                        .get("data_hash")
                        .and_then(|value| value.as_str());
                    let nested_payload_data_hash = entry
                        .payload
                        .get("payload")
                        .and_then(|value| value.as_object())
                        .and_then(|payload| payload.get("data_hash"))
                        .and_then(|value| value.as_str());

                    if entry.namespace != "consent.receipt"
                        && !matched_payload_commitment
                        && (payload_data_hash == Some(data_hash.as_str())
                            || payload_data_hash == Some(normalized_data_hash.as_str())
                            || nested_payload_data_hash == Some(data_hash.as_str())
                            || nested_payload_data_hash == Some(normalized_data_hash.as_str()))
                    {
                        matches.push(serde_json::json!({
                            "entry_id": entry.entry_id,
                            "namespace": entry.namespace,
                            "action": entry.action,
                            "object_id": entry.object_id,
                            "timestamp": entry.timestamp,
                            "source": "payload.data_hash",
                        }));
                    }
                }
            }
        }

        if matches.is_empty() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "no entries found for data_hash",
                    "data_hash": normalized_data_hash,
                })),
            );
        }

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "data_hash": normalized_data_hash,
                "matches": matches,
            })),
        )
    }

    async fn handle_get_payload_data_hash_query(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        query: DataHashQueryParams,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let Some(raw_hash) = query.q else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "missing required query parameter: q",
                })),
            );
        };

        let data_hash = raw_hash.trim().to_string();
        if data_hash.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "query parameter q cannot be empty",
                })),
            );
        }

        Self::handle_get_payload_data_hash(ledger, edge, data_hash).await
    }

    fn normalize_data_hash(data_hash: &str) -> String {
        if data_hash.starts_with("sha256:") {
            data_hash.to_string()
        } else {
            format!("sha256:{data_hash}")
        }
    }

    fn parse_payload_field_policy(ruleset: &NamespaceRuleset) -> Option<PayloadFieldPolicyConfig> {
        let config = ruleset
            .validators
            .iter()
            .find(|rule| rule.name == "offchain_encrypted_payload_field_policy")
            .map(|rule| &rule.config)?;

        let offchain_encrypted_fields = config
            .get("offchain_encrypted_fields")
            .and_then(|value| value.as_array())
            .map(|fields| {
                fields
                    .iter()
                    .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                    .collect::<Vec<String>>()
            })?;

        let policy_version = config
            .get("policy_version")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(1);
        let min_supported_policy_version = config
            .get("min_supported_policy_version")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(policy_version);
        let migration_guide_ref = config
            .get("migration_guide_ref")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned);

        Some(PayloadFieldPolicyConfig {
            policy_version,
            min_supported_policy_version,
            migration_guide_ref,
            offchain_encrypted_fields,
        })
    }

    fn compute_payload_field_commitment(
        namespace: &str,
        entry_id: &str,
        policy_version: u32,
        field_path: &str,
        ciphertext_hash: &str,
    ) -> String {
        let commitment_input = serde_json::json!({
            "schema_version": "1.0.0",
            "namespace": namespace,
            "entry_id": entry_id,
            "policy_version": policy_version,
            "fields": [
                {
                    "field_path": field_path,
                    "ciphertext_hash": ciphertext_hash,
                }
            ]
        });
        sha256_hex(&canonical_json(&commitment_input))
    }

    fn is_valid_sha256_digest(value: &str) -> bool {
        let Some(hex) = value.strip_prefix("sha256:") else {
            return false;
        };
        hex.len() == 64 && hex.chars().all(|ch| ch.is_ascii_hexdigit())
    }

    fn required_idempotency_key(
        headers: &HeaderMap,
    ) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
        headers
            .get("idempotency-key")
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "missing required idempotency-key header"})),
                )
            })
    }

    fn json_path_exists(value: &serde_json::Value, field_path: &str) -> bool {
        let candidate_paths = [
            field_path,
            field_path.strip_prefix("payload.").unwrap_or(field_path),
        ];

        for path in candidate_paths {
            if path.is_empty() {
                continue;
            }

            let mut current = value;
            let mut found = true;
            for segment in path.split('.') {
                let Some(next) = current.get(segment) else {
                    found = false;
                    break;
                };
                current = next;
            }

            if found {
                return true;
            }
        }

        false
    }

    fn validate_manifest_against_intent(
        manifest: &serde_json::Value,
        intent: &FileIntentRequest,
        policy: &serde_json::Value,
        expected_object_ref: &str,
        object_store: &dyn OffchainObjectStore,
    ) -> Result<(), String> {
        if !manifest.is_object() {
            return Err("manifest must be a JSON object".to_string());
        }

        let manifest_namespace = manifest
            .get("namespace")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "manifest missing namespace".to_string())?;
        if manifest_namespace != intent.namespace {
            return Err("manifest namespace does not match intent namespace".to_string());
        }

        let manifest_object = manifest
            .get("object_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "manifest missing object_id".to_string())?;
        if manifest_object != intent.object_id {
            return Err("manifest object_id does not match intent object_id".to_string());
        }

        let manifest_author = manifest
            .get("author_did")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "manifest missing author_did".to_string())?;
        if manifest_author != intent.author_did {
            return Err("manifest author_did does not match intent author_did".to_string());
        }

        let manifest_mime = manifest
            .get("mime_type")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "manifest missing mime_type".to_string())?;
        if manifest_mime != intent.mime_type {
            return Err("manifest mime_type does not match intent mime_type".to_string());
        }

        let manifest_mode = manifest
            .get("encryption_mode")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "manifest missing encryption_mode".to_string())?;
        if manifest_mode != intent.encryption_mode {
            return Err(
                "manifest encryption_mode does not match intent encryption_mode".to_string(),
            );
        }

        let manifest_size = manifest
            .get("file_size_bytes")
            .and_then(|value| value.as_u64())
            .ok_or_else(|| "manifest missing file_size_bytes".to_string())?;
        if manifest_size != intent.file_size_bytes {
            return Err(
                "manifest file_size_bytes does not match intent file_size_bytes".to_string(),
            );
        }

        if let Some(max_size) = policy
            .get("max_file_size_bytes")
            .and_then(|value| value.as_u64())
        {
            if manifest_size > max_size {
                return Err("manifest file size exceeds namespace policy limit".to_string());
            }
        }

        if let Some(allowed_mimes) = policy
            .get("allowed_mime_types")
            .and_then(|value| value.as_array())
        {
            let mime_allowed = allowed_mimes
                .iter()
                .filter_map(|value| value.as_str())
                .any(|value| value == manifest_mime);
            if !mime_allowed {
                return Err("manifest mime type is not allowed by namespace policy".to_string());
            }
        }

        if let Some(allowed_modes) = policy
            .get("allowed_encryption_modes")
            .and_then(|value| value.as_array())
        {
            let mode_allowed = allowed_modes
                .iter()
                .filter_map(|value| value.as_str())
                .any(|value| value == manifest_mode);
            if !mode_allowed {
                return Err(
                    "manifest encryption mode is not allowed by namespace policy".to_string(),
                );
            }
        }

        let manifest_file_ref = manifest
            .get("file_ref")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "manifest missing file_ref".to_string())?;
        if manifest_file_ref != expected_object_ref {
            return Err(
                "manifest file_ref does not match issued upload intent object_ref".to_string(),
            );
        }
        object_store.validate_object_ref(&intent.namespace, manifest_file_ref)?;

        let ciphertext_hash = manifest
            .get("ciphertext_hash")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "manifest missing ciphertext_hash".to_string())?;
        if !Self::is_valid_sha256_digest(ciphertext_hash) {
            return Err("manifest ciphertext_hash must be sha256:<64 hex chars>".to_string());
        }

        let payload_commitment = manifest
            .get("payload_commitment")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "manifest missing payload_commitment".to_string())?;
        if !Self::is_valid_sha256_digest(payload_commitment) {
            return Err("manifest payload_commitment must be sha256:<64 hex chars>".to_string());
        }

        Ok(())
    }

    fn allowed_file_actions(policy: &serde_json::Value) -> Vec<String> {
        let configured: Vec<String> = policy
            .get("allowed_actions")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();

        if configured.is_empty() {
            return vec!["ENCRYPTED_FILE_UPLOAD".to_string()];
        }

        configured
    }

    fn validate_required_consent_policy(
        policy: &serde_json::Value,
        receipt: &ConsentReceipt,
    ) -> Result<(), String> {
        if let Some(required_policy_ref) = policy
            .get("required_consent_policy_ref")
            .and_then(|value| value.as_str())
        {
            if receipt.policy_ref != required_policy_ref {
                return Err(format!(
                    "consent receipt policy_ref does not satisfy namespace policy requirement: expected {required_policy_ref}"
                ));
            }
        }

        Ok(())
    }

    fn evaluate_consent_receipt(
        ledger: Arc<Ledger<S>>,
        receipt: &ConsentReceipt,
        now: i64,
    ) -> ConsentPolicyCheck {
        let exists = ledger
            .storage()
            .namespace_entries(&"consent.receipt".to_string())
            .unwrap_or_default();
        let latest = exists
            .into_iter()
            .filter(|entry| {
                entry.object_id == receipt.subject_did
                    && entry
                        .payload
                        .get("data_hash")
                        .and_then(|value| value.as_str())
                        == Some(receipt.data_hash.as_str())
                    && entry
                        .payload
                        .get("policy_ref")
                        .and_then(|value| value.as_str())
                        == Some(receipt.policy_ref.as_str())
            })
            .max_by_key(|entry| entry.timestamp);

        if latest.is_none() {
            return ConsentPolicyCheck {
                valid: false,
                reason: Some("consent receipt not found on-chain".to_string()),
            };
        }

        if receipt.expires_at <= now {
            return ConsentPolicyCheck {
                valid: false,
                reason: Some("consent receipt expired".to_string()),
            };
        }

        if latest
            .as_ref()
            .map(|entry| entry.action.as_str() == "CONSENT_REVOKED")
            .unwrap_or(false)
        {
            return ConsentPolicyCheck {
                valid: false,
                reason: Some("consent receipt revoked".to_string()),
            };
        }

        ConsentPolicyCheck {
            valid: true,
            reason: None,
        }
    }

    async fn process_envelope_submission(
        ledger: Arc<Ledger<S>>,
        envelope: SignedEnvelope<LedgerEntry>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        tracing::info!(envelope_id = %envelope.envelope_id, namespace = %envelope.payload.namespace, action = %envelope.payload.action, "process_envelope_submission: received");

        // Reject entries that are unreasonably large for on-chain storage.
        // Encrypted attachments should be stored off-chain via MinIO / object store.
        const MAX_ENVELOPE_BYTES: usize = 50_000_000;
        let envelope_size = serde_json::to_vec(&envelope).map(|v| v.len()).unwrap_or(0);
        if envelope_size > MAX_ENVELOPE_BYTES {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({
                    "error": "envelope_too_large",
                    "message": format!("Envelope {} bytes exceeds {} byte maximum. Encrypted file attachments must be stored off-chain.", envelope_size, MAX_ENVELOPE_BYTES),
                })),
            );
        }

        let validation = match validate_envelope_signatures(&envelope) {
            Ok(validated) => validated,
            Err(err) => return protocol_error_response(err),
        };
        let entry = validation.entry;
        let action = entry.action.clone();

        if let Err(err) = ledger.validate_entry_submission(&entry) {
            return protocol_error_response(err);
        }

        let entry_id = entry.entry_id;
        let namespace = entry.namespace.clone();
        if let Err(err) = ledger.apply_entry(entry.clone()) {
            tracing::error!(%entry_id, %namespace, ?err, "apply_entry failed");
            return protocol_error_response(err);
        }
        tracing::info!(%entry_id, %namespace, "entry stored successfully");

        let offchain_commitments = extract_offchain_commitments(&entry);
        let finality = match Self::finalize_entry(Arc::clone(&ledger), entry).await {
            Ok(finality) => finality,
            Err(err) => return protocol_error_response(err),
        };

        let receipt = DeterministicReceipt {
            receipt_id: Uuid::new_v4(),
            envelope_id: envelope.envelope_id,
            status: ReceiptStatus::Accepted,
            validation: ValidationSummary {
                namespace: namespace.clone(),
                action,
                outcome: validation.outcome,
                offchain_commitments,
                multisig: validation.multisig,
            },
            finality: Some(finality),
            recorded_at: Utc::now(),
        };
        if let Err(err) = ledger.storage().store_receipt(receipt.clone()) {
            return protocol_error_response(err);
        }

        (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "status": "accepted",
                "entry_id": entry_id,
                "namespace": namespace,
                "receipt": receipt,
            })),
        )
    }

    async fn process_envelope_batch_submission(
        ledger: Arc<Ledger<S>>,
        envelopes: Vec<SignedEnvelope<LedgerEntry>>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if envelopes.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error":"batch must contain at least one envelope"})),
            );
        }

        let mut validated_entries = Vec::with_capacity(envelopes.len());
        let mut accepted = Vec::with_capacity(envelopes.len());
        for (index, envelope) in envelopes.into_iter().enumerate() {
            let envelope_id = envelope.envelope_id;
            let validation = match validate_envelope_signatures(&envelope) {
                Ok(validated) => validated,
                Err(err) => {
                    return protocol_batch_error_response(
                        err,
                        index,
                        envelope_id,
                        "signature_validation",
                    )
                }
            };
            let entry = validation.entry;
            let action = entry.action.clone();

            if let Err(err) = ledger.validate_entry_submission(&entry) {
                return protocol_batch_error_response(
                    err,
                    index,
                    envelope_id,
                    "namespace_validation",
                );
            }
            accepted.push((
                entry.entry_id,
                entry.namespace.clone(),
                action,
                envelope_id,
                extract_offchain_commitments(&entry),
                validation.outcome,
                validation.multisig,
            ));
            validated_entries.push(entry);
        }

        for (index, entry) in validated_entries.iter().enumerate() {
            if let Err(err) = ledger.apply_entry(entry.clone()) {
                return protocol_batch_error_response(
                    err,
                    index,
                    accepted[index].3,
                    "apply_entry",
                );
            }
        }

        let finality = match Self::finalize_entries(Arc::clone(&ledger), validated_entries).await {
            Ok(finality) => finality,
            Err(err) => return protocol_error_response(err),
        };

        let mut receipts = Vec::with_capacity(accepted.len());
        for (entry_id, namespace, action, envelope_id, offchain_commitments, outcome, multisig) in
            accepted
        {
            let receipt = DeterministicReceipt {
                receipt_id: Uuid::new_v4(),
                envelope_id,
                status: ReceiptStatus::Accepted,
                validation: ValidationSummary {
                    namespace: namespace.clone(),
                    action,
                    outcome,
                    offchain_commitments,
                    multisig,
                },
                finality: Some(finality.clone()),
                recorded_at: Utc::now(),
            };
            if let Err(err) = ledger.storage().store_receipt(receipt.clone()) {
                return protocol_error_response(err);
            }
            receipts.push(serde_json::json!({
                "entry_id": entry_id,
                "namespace": namespace,
                "receipt": receipt,
            }));
        }

        (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "status": "accepted",
                "batch_size": receipts.len(),
                "receipts": receipts,
            })),
        )
    }

    async fn handle_get_receipt(
        ledger: Arc<Ledger<S>>,
        receipt_id: Uuid,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if let Ok(Some(receipt)) = ledger.storage().get_receipt(receipt_id) {
            return (
                StatusCode::OK,
                Json(serde_json::json!({"receipt": receipt})),
            );
        }
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "receipt not found"})),
        )
    }

    async fn handle_get_builder_credits(
        ledger: Arc<Ledger<S>>,
        builder_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let policy_metadata = ledger
            .namespace_ruleset("builder.credits")
            .and_then(|ruleset| {
                ruleset
                    .validators
                    .iter()
                    .find(|rule| rule.name == "builder_credit_policy")
                    .map(|rule| {
                        serde_json::json!({
                            "namespace_version": ruleset.descriptor.version,
                            "rules_hash": ruleset.descriptor.rules_hash,
                            "rule": rule.name,
                            "max_daily_spend": rule.config.get("max_daily_spend").cloned().unwrap_or(serde_json::Value::Null),
                        })
                    })
            })
            .unwrap_or_else(|| {
                serde_json::json!({
                    "namespace_version": serde_json::Value::Null,
                    "rules_hash": serde_json::Value::Null,
                    "rule": serde_json::Value::Null,
                    "max_daily_spend": serde_json::Value::Null,
                })
            });

        let entries = ledger
            .storage()
            .namespace_entries(&"builder.credits".to_string())
            .unwrap_or_default();

        let mut credited: u64 = 0;
        let mut sponsored: u64 = 0;
        let mut seen_sponsorships: HashSet<String> = HashSet::new();
        let mut unique_sponsorship_count = 0_u64;

        for entry in entries {
            if entry.object_id != builder_id {
                continue;
            }
            let amount = entry
                .payload
                .get("amount")
                .and_then(|value| value.as_u64())
                .unwrap_or_default();
            match entry.action.as_str() {
                "CREDIT_GRANT" | "MULTISIG_CREDIT_GRANT" | "PROGRAMMABLE_CREDIT_GRANT" => {
                    credited = credited.saturating_add(amount)
                }
                "SPONSOR_USAGE" => {
                    sponsored = sponsored.saturating_add(amount);
                    if let Some(sponsorship_id) = entry
                        .payload
                        .get("sponsorship_id")
                        .and_then(|value| value.as_str())
                    {
                        if seen_sponsorships.insert(sponsorship_id.to_string()) {
                            unique_sponsorship_count = unique_sponsorship_count.saturating_add(1);
                        }
                    }
                }
                _ => {}
            }
        }

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "builder_id": builder_id,
                "namespace": "builder.credits",
                "credited": credited,
                "sponsored": sponsored,
                "available": credited.saturating_sub(sponsored),
                "policy": policy_metadata,
                "instrumentation": {
                    "unique_sponsorship_count": unique_sponsorship_count
                }
            })),
        )
    }

    async fn handle_get_asset_positions(
        ledger: Arc<Ledger<S>>,
        account_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let entries = ledger
            .storage()
            .namespace_entries(&"asset.control".to_string())
            .unwrap_or_default();

        let mut trustlines: BTreeMap<(String, String), serde_json::Value> = BTreeMap::new();
        let mut holdings: BTreeMap<(String, String), i128> = BTreeMap::new();

        for entry in entries {
            if entry.object_id != account_id {
                continue;
            }
            let Some(issuer) = entry.payload.get("issuer").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(asset_code) = entry
                .payload
                .get("asset_code")
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            let key = (issuer.to_string(), asset_code.to_string());

            match entry.action.as_str() {
                "TRUSTLINE_OPEN" | "TRUSTLINE_CLOSE" => {
                    trustlines.insert(
                        key.clone(),
                        serde_json::json!({
                            "status": if entry.action == "TRUSTLINE_CLOSE" { "closed" } else { "active" },
                            "max_holding": entry.payload.get("max_holding").and_then(|value| value.as_u64()).unwrap_or_default(),
                            "policy_flags": entry.payload.get("policy_flags").cloned().unwrap_or_else(|| serde_json::json!([])),
                            "disclosure": entry.payload.get("disclosure").cloned().unwrap_or_else(|| serde_json::json!({"mode":"public"})),
                        }),
                    );
                }
                "ASSET_HOLD" => {
                    let amount = entry
                        .payload
                        .get("amount")
                        .and_then(|value| value.as_u64())
                        .unwrap_or_default() as i128;
                    holdings
                        .entry(key)
                        .and_modify(|current| *current = current.saturating_add(amount))
                        .or_insert(amount);
                }
                "ASSET_RELEASE" => {
                    let amount = entry
                        .payload
                        .get("amount")
                        .and_then(|value| value.as_u64())
                        .unwrap_or_default() as i128;
                    holdings
                        .entry(key)
                        .and_modify(|current| *current = current.saturating_sub(amount))
                        .or_insert(-amount);
                }
                "ASSET_REVOKE" => {
                    let amount = entry
                        .payload
                        .get("amount")
                        .and_then(|value| value.as_u64())
                        .unwrap_or_default() as i128;
                    holdings
                        .entry(key)
                        .and_modify(|current| *current = current.saturating_sub(amount))
                        .or_insert(-amount);
                }
                _ => {}
            }
        }

        let mut positions = Vec::new();
        for ((issuer, asset_code), trustline) in trustlines {
            let held = holdings
                .get(&(issuer.clone(), asset_code.clone()))
                .copied()
                .unwrap_or_default()
                .max(0) as u64;
            let max_holding = trustline
                .get("max_holding")
                .and_then(|value| value.as_u64())
                .unwrap_or_default();
            let clawback_enabled = trustline
                .get("policy_flags")
                .and_then(|value| value.as_array())
                .map(|flags| {
                    flags
                        .iter()
                        .filter_map(|flag| flag.as_str())
                        .any(|flag| flag == "clawback_enabled")
                })
                .unwrap_or(false);
            positions.push(serde_json::json!({
                "issuer": issuer,
                "asset_code": asset_code,
                "held": held,
                "available_capacity": max_holding.saturating_sub(held),
                "holder_notice": if clawback_enabled {
                    "Issuer clawback is ENABLED for this trustline. Issuer may revoke held units according to policy."
                } else {
                    "Issuer clawback is DISABLED for this trustline. Only holder-initiated releases reduce holdings."
                },
                "clawback": {
                    "enabled": clawback_enabled,
                },
                "trustline": trustline,
            }));
        }

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "account_id": account_id,
                "namespace": "asset.control",
                "positions": positions,
            })),
        )
    }

    async fn finalize_entry(
        ledger: Arc<Ledger<S>>,
        entry: LedgerEntry,
    ) -> Result<FinalityProof, ProtocolError> {
        Self::finalize_entries(ledger, vec![entry]).await
    }

    async fn finalize_entries(
        ledger: Arc<Ledger<S>>,
        entries: Vec<LedgerEntry>,
    ) -> Result<FinalityProof, ProtocolError> {
        if entries.is_empty() {
            return Err(ProtocolError::ValidationFailed(
                "cannot finalize empty entry batch".into(),
            ));
        }
        let storage = ledger.storage();
        let latest_height = storage.latest_height()?;
        let next_height = latest_height.saturating_add(1);
        let prev_hash = if latest_height == 0 {
            "genesis".to_string()
        } else {
            let previous = storage.get_block(latest_height)?.ok_or_else(|| {
                ProtocolError::StorageError(format!("missing block at height {latest_height}"))
            })?;
            hash_block_header(&previous.header)
        };

        let commit_proof = CommitProof {
            aggregated_signature: "local-dev-finality".to_string(),
            participant_ids: BTreeSet::new(),
        };
        let entry_root = compute_entry_root(&entries);
        let block = Block {
            header: BlockHeader {
                height: next_height,
                prev_hash,
                entry_root,
                proposer: "local-validator".to_string(),
                timestamp: Utc::now().timestamp(),
                commit_proof: commit_proof.clone(),
            },
            entries,
        };
        storage.store_block(block.clone())?;

        Ok(FinalityProof {
            block_height: next_height,
            block_hash: hash_block_header(&block.header),
            commit_proof,
        })
    }

    async fn handle_get_module_runtime(
        ledger: Arc<Ledger<S>>,
        module_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let entries = ledger
            .storage()
            .namespace_entries(&"execution.module".to_string())
            .unwrap_or_default();

        let module_entries: Vec<&LedgerEntry> = entries
            .iter()
            .filter(|entry| entry.object_id == module_id)
            .collect();
        if module_entries.is_empty() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error":"module not found"})),
            );
        }

        let registered = module_entries
            .iter()
            .filter(|entry| entry.action == "REGISTER_MODULE")
            .max_by_key(|entry| entry.timestamp)
            .copied();
        let activated = module_entries
            .iter()
            .filter(|entry| entry.action == "ACTIVATE_MODULE")
            .max_by_key(|entry| entry.timestamp)
            .copied();

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "module_id": module_id,
                "namespace": "execution.module",
                "registered": registered.is_some(),
                "active": activated.is_some(),
                "module_class": registered
                    .and_then(|entry| entry.payload.get("module_class"))
                    .and_then(|value| value.as_str()),
                "audit_hash": registered
                    .and_then(|entry| entry.payload.get("audit_hash"))
                    .and_then(|value| value.as_str()),
                "wasm_hash": registered
                    .and_then(|entry| entry.payload.get("wasm_hash"))
                    .and_then(|value| value.as_str()),
                "last_execution_receipt": module_entries
                    .iter()
                    .filter(|entry| entry.action == "EXECUTE_MODULE")
                    .max_by_key(|entry| entry.timestamp)
                    .and_then(|entry| entry.payload.get("deterministic_receipt_hash"))
                    .and_then(|value| value.as_str()),
                "entries": module_entries.len()
            })),
        )
    }

    async fn handle_module_execute(
        ledger: Arc<Ledger<S>>,
        module_id: String,
        body: serde_json::Value,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let gas_limit = body
            .get("gas_limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(1_000_000);

        let params_json = serde_json::to_string(&body).unwrap_or_else(|_| "{}".to_string());

        match ledger.execute_wasm_module(&module_id, &params_json, gas_limit) {
            Ok(result) => {
                let output = result
                    .return_value
                    .as_ref()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
                    .unwrap_or(serde_json::json!({"raw": result.return_value}));

                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "module_id": module_id,
                        "success": result.success,
                        "result": output,
                        "gas_consumed": result.gas_consumed,
                        "logs": result.logs,
                        "error": result.error,
                    })),
                )
            }
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "module_id": module_id,
                    "success": false,
                    "error": e.to_string(),
                })),
            ),
        }
    }

    async fn handle_get_interop_status(
        ledger: Arc<Ledger<S>>,
        object_id: String,
    ) -> Json<serde_json::Value> {
        let entries = ledger
            .storage()
            .namespace_entries(&"interop.adapter".to_string())
            .unwrap_or_default();

        let object_entries: Vec<&LedgerEntry> = entries
            .iter()
            .filter(|entry| entry.object_id == object_id)
            .collect();

        let standards: Vec<String> = object_entries
            .iter()
            .filter_map(|entry| {
                entry
                    .payload
                    .get("standard")
                    .and_then(|value| value.as_str())
            })
            .map(ToString::to_string)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        Json(serde_json::json!({
            "object_id": object_id,
            "namespace": "interop.adapter",
            "entries": object_entries.len(),
            "standards": standards,
            "latest_link": object_entries
                .iter()
                .filter(|entry| entry.action == "LINK_IDENTIFIER")
                .max_by_key(|entry| entry.timestamp)
                .and_then(|entry| entry.payload.get("remote_id"))
                .and_then(|value| value.as_str()),
            "latest_proof_hash": object_entries
                .iter()
                .filter(|entry| entry.action == "EMIT_PROOF")
                .max_by_key(|entry| entry.timestamp)
                .and_then(|entry| entry.payload.get("proof_hash"))
                .and_then(|value| value.as_str())
        }))
    }

    async fn handle_get_governance_proposals(ledger: Arc<Ledger<S>>) -> Json<serde_json::Value> {
        let proposals = ledger.governance_proposals().unwrap_or_default();
        Json(serde_json::json!({ "proposals": proposals }))
    }

    async fn handle_list_civic_proposals(
        ledger: Arc<Ledger<S>>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let ns = "civic.proposal".to_string();
        let entries = ledger.storage().namespace_entries(&ns).unwrap_or_default();
        let proposals: Vec<serde_json::Value> = entries
            .iter()
            .filter(|e| e.action == "OPEN_PROPOSAL")
            .map(|e| {
                let closed = entries.iter().any(|c| {
                    c.action == "CLOSE_PROPOSAL" && c.object_id == e.object_id
                });
                serde_json::json!({
                    "proposal_id": e.object_id,
                    "title": e.payload.get("title").and_then(|v| v.as_str()),
                    "description": e.payload.get("description").and_then(|v| v.as_str()),
                    "opened_at": e.timestamp,
                    "opened_by": e.author,
                    "status": if closed { "closed" } else { "open" },
                })
            })
            .collect();
        (
            StatusCode::OK,
            Json(serde_json::json!({ "proposals": proposals })),
        )
    }

    async fn handle_get_civic_proposal(
        ledger: Arc<Ledger<S>>,
        proposal_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let ns = "civic.proposal".to_string();
        let entries = ledger.storage().namespace_entries(&ns).unwrap_or_default();
        let proposal = entries
            .iter()
            .find(|e| e.action == "OPEN_PROPOSAL" && e.object_id == proposal_id);
        match proposal {
            Some(p) => {
                let closed = entries.iter().any(|e| {
                    e.action == "CLOSE_PROPOSAL" && e.object_id == proposal_id
                });
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "proposal_id": p.object_id,
                        "title": p.payload.get("title").and_then(|v| v.as_str()),
                        "description": p.payload.get("description").and_then(|v| v.as_str()),
                        "opened_at": p.timestamp,
                        "opened_by": p.author,
                        "status": if closed { "closed" } else { "open" },
                    })),
                )
            }
            None => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "proposal not found"})),
            ),
        }
    }

    async fn handle_get_civic_tally(
        ledger: Arc<Ledger<S>>,
        proposal_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let proposal_ns = "civic.proposal".to_string();
        let proposal_entries = ledger
            .storage()
            .namespace_entries(&proposal_ns)
            .unwrap_or_default();
        let exists = proposal_entries.iter().any(|e| {
            e.action == "OPEN_PROPOSAL" && e.object_id == proposal_id
        });
        if !exists {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "proposal not found"})),
            );
        }

        let ballot_ns = "civic.ballot".to_string();
        let ballots = ledger
            .storage()
            .namespace_entries(&ballot_ns)
            .unwrap_or_default();
        let relevant: Vec<&LedgerEntry> = ballots
            .iter()
            .filter(|e| {
                e.action == "CAST_BALLOT"
                    && e.payload.get("proposal_id").and_then(|v| v.as_str())
                        == Some(&proposal_id)
            })
            .collect();

        let mut tally: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        let mut voters: Vec<String> = Vec::new();
        for ballot in &relevant {
            let choice = ballot
                .payload
                .get("choice")
                .and_then(|v| v.as_str())
                .unwrap_or("invalid");
            *tally.entry(choice.to_string()).or_insert(0) += 1;
            voters.push(ballot.author.clone());
        }

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "proposal_id": proposal_id,
                "total_ballots": relevant.len(),
                "tally": tally,
                "voters": voters,
            })),
        )
    }

    async fn handle_list_civic_elections(
        ledger: Arc<Ledger<S>>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let ns = "civic.election".to_string();
        let entries = ledger.storage().namespace_entries(&ns).unwrap_or_default();
        let elections: Vec<serde_json::Value> = entries
            .iter()
            .filter(|e| e.action == "OPEN_ELECTION")
            .map(|e| {
                let closed = entries.iter().any(|c| {
                    c.action == "CLOSE_ELECTION" && c.object_id == e.object_id
                });
                let race_count = match ledger.reconstruct_election(&e.object_id) {
                    Ok((_, races)) => races.len(),
                    Err(_) => e
                        .payload
                        .get("races")
                        .and_then(serde_json::Value::as_array)
                        .map(|a| a.len())
                        .unwrap_or(0),
                };
                serde_json::json!({
                    "election_id": e.object_id,
                    "title": e.payload.get("title").and_then(|v| v.as_str()),
                    "opened_at": e.timestamp,
                    "opened_by": e.author,
                    "status": if closed { "closed" } else { "open" },
                    "race_count": race_count,
                })
            })
            .collect();
        (
            StatusCode::OK,
            Json(serde_json::json!({ "elections": elections })),
        )
    }

    async fn handle_get_civic_election(
        ledger: Arc<Ledger<S>>,
        election_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let ns = "civic.election".to_string();
        let entries = ledger.storage().namespace_entries(&ns).unwrap_or_default();
        let election = entries
            .iter()
            .find(|e| e.action == "OPEN_ELECTION" && e.object_id == election_id);
        match election {
            Some(e) => {
                let closed = entries.iter().any(|e| {
                    e.action == "CLOSE_ELECTION" && e.object_id == election_id
                });
                let (title, races) = ledger
                    .reconstruct_election(&election_id)
                    .unwrap_or_else(|_| {
                        (
                            serde_json::json!(e.payload.get("title").and_then(|v| v.as_str())),
                            e.payload
                                .get("races")
                                .and_then(serde_json::Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                        )
                    });
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "election_id": e.object_id,
                        "title": title,
                        "opened_at": e.timestamp,
                        "opened_by": e.author,
                        "status": if closed { "closed" } else { "open" },
                        "races": races,
                        "tally_public_key": e.payload.get("tally_public_key").and_then(|v| v.as_str()),
                    })),
                )
            }
            None => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "election not found"})),
            ),
        }
    }

    async fn handle_get_civic_election_tally(
        ledger: Arc<Ledger<S>>,
        election_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let election_ns = "civic.election".to_string();
        let election_entries = ledger
            .storage()
            .namespace_entries(&election_ns)
            .unwrap_or_default();
        let election = election_entries.iter().find(|e| {
            e.action == "OPEN_ELECTION" && e.object_id == election_id
        });
        if election.is_none() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "election not found"})),
            );
        }
        let election = election.unwrap();
        let races = match ledger.reconstruct_election(&election_id) {
            Ok((_, r)) => r,
            Err(_) => election
                .payload
                .get("races")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default(),
        };

        let ballot_ns = "civic.election.ballot".to_string();
        let all_ballots = ledger
            .storage()
            .namespace_entries(&ballot_ns)
            .unwrap_or_default();
        let ballots: Vec<&LedgerEntry> = all_ballots
            .iter()
            .filter(|e| {
                e.action == "CAST_BALLOT"
                    && e.payload
                        .get("election_id")
                        .and_then(serde_json::Value::as_str)
                        == Some(&election_id)
            })
            .collect();

        let mut race_tallies: Vec<serde_json::Value> = Vec::new();
        for race in &races {
            let race_id = race
                .get("race_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown");
            let race_title = race
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let seat_type = race
                .get("seat_type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("single");
            let max_selections = race
                .get("max_selections")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(1);

            let mut candidate_tally: std::collections::BTreeMap<String, u64> =
                std::collections::BTreeMap::new();
            let empty_cands: Vec<serde_json::Value> = vec![];
            let candidates = race
                .get("candidates")
                .and_then(serde_json::Value::as_array)
                .unwrap_or(&empty_cands);
            for candidate in candidates {
                if let Some(cid) = candidate.get("candidate_id").and_then(serde_json::Value::as_str) {
                    candidate_tally.insert(cid.to_string(), 0);
                }
            }

            for ballot in &ballots {
                let selections = ballot
                    .payload
                    .get("selections")
                    .and_then(serde_json::Value::as_array);
                if let Some(sel) = selections {
                    for s in sel {
                        if s.get("race_id").and_then(serde_json::Value::as_str) == Some(race_id) {
                            if let Some(cids) =
                                s.get("candidate_ids").and_then(serde_json::Value::as_array)
                            {
                                for cid in cids {
                                    if let Some(id) = cid.as_str() {
                                        *candidate_tally
                                            .entry(id.to_string())
                                            .or_insert(0) += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            let total_ballots = ballots.len();
            race_tallies.push(serde_json::json!({
                "race_id": race_id,
                "title": race_title,
                "seat_type": seat_type,
                "max_selections": max_selections,
                "tally": candidate_tally,
                "total_ballots": total_ballots,
            }));
        }

        let voters: Vec<String> = ballots.iter().map(|b| b.author.clone()).collect();
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "election_id": election_id,
                "total_ballots": ballots.len(),
                "races": race_tallies,
                "voters": voters,
            })),
        )
    }

    /// Returns raw ballot entries for an election. Encrypted ballots include
    /// the ciphertext, ephemeral public key, and nonce so the tally authority
    /// can decrypt client-side. Plaintext ballots include selections directly.
    async fn handle_get_civic_election_ballots(
        ledger: Arc<Ledger<S>>,
        election_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let ns = "civic.election.ballot".to_string();
        let entries = ledger.storage().namespace_entries(&ns).unwrap_or_default();
        let ballots: Vec<serde_json::Value> = entries
            .iter()
            .filter(|e| {
                e.action == "CAST_BALLOT"
                    && e.payload
                        .get("election_id")
                        .and_then(serde_json::Value::as_str)
                        == Some(&election_id)
            })
            .map(|e| {
                serde_json::json!({
                    "entry_id": e.entry_id,
                    "author": e.author,
                    "timestamp": e.timestamp,
                    "payload": e.payload,
                })
            })
            .collect();
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "election_id": election_id,
                "total_ballots": ballots.len(),
                "ballots": ballots,
            })),
        )
    }

    async fn handle_ctzn_status(
        ledger: Arc<Ledger<S>>,
        module_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let entries = ledger
            .storage()
            .namespace_entries(&"execution.module".to_string())
            .unwrap_or_default();
        let module_entries: Vec<&LedgerEntry> = entries
            .iter()
            .filter(|e| e.object_id == module_id)
            .collect();
        if module_entries.is_empty() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "module not found"})),
            );
        }

        let registered = module_entries.iter().any(|e| e.action == "REGISTER_MODULE");
        let activated = module_entries.iter().any(|e| e.action == "ACTIVATE_MODULE");

        let mut holders = 0u64;
        let mut active_holders = 0u64;
        let mut revoked = 0u64;
        let mut burned = 0u64;
        for e in &module_entries {
            if e.action == "STATE_WRITE" {
                if let Some(key) = e.payload.get("state_key").and_then(|v| v.as_str()) {
                    if key.starts_with("owner:") {
                        holders += 1;
                        let tid = &key[6..];
                        let is_revoked = module_entries.iter().any(|e2| {
                            e2.action == "STATE_WRITE"
                                && e2.payload.get("state_key").and_then(|v| v.as_str())
                                    == Some(&format!("revoked:{tid}"))
                                && e2.payload.get("state_value").and_then(|v| v.as_str())
                                    == Some("true")
                        });
                        let is_burned = module_entries.iter().any(|e2| {
                            e2.action == "STATE_WRITE"
                                && e2.payload.get("state_key").and_then(|v| v.as_str())
                                    == Some(&format!("burned:{tid}"))
                                && e2.payload.get("state_value").and_then(|v| v.as_str())
                                    == Some("true")
                        });
                        if is_revoked {
                            revoked += 1;
                        } else if is_burned {
                            burned += 1;
                        } else {
                            active_holders += 1;
                        }
                    }
                }
            }
        }

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "module_id": module_id,
                "registered": registered,
                "active": activated,
                "total_holders": holders,
                "active_holders": active_holders,
                "revoked": revoked,
                "burned": burned,
            })),
        )
    }

    async fn handle_ctzn_holders(
        ledger: Arc<Ledger<S>>,
        module_id: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let entries = ledger
            .storage()
            .namespace_entries(&"execution.module".to_string())
            .unwrap_or_default();

        let mut holders: Vec<serde_json::Value> = Vec::new();
        for e in &entries {
            if e.action != "STATE_WRITE" || e.object_id != module_id {
                continue;
            }
            let key = e.payload.get("state_key").and_then(|v| v.as_str());
            let value = e.payload.get("state_value").and_then(|v| v.as_str());
            if let (Some(k), Some(v)) = (key, value) {
                if let Some(tid) = k.strip_prefix("owner:") {
                    let schema = entries
                        .iter()
                        .rev()
                        .find(|e2| {
                            e2.object_id == module_id
                                && e2.action == "STATE_WRITE"
                                && e2.payload.get("state_key").and_then(|v2| v2.as_str())
                                    == Some(&format!("schema:{tid}"))
                        })
                        .and_then(|e2| {
                            e2.payload.get("state_value").and_then(|v2| v2.as_str())
                        })
                        .unwrap_or("");
                    let tier = entries
                        .iter()
                        .rev()
                        .find(|e2| {
                            e2.object_id == module_id
                                && e2.action == "STATE_WRITE"
                                && e2.payload.get("state_key").and_then(|v2| v2.as_str())
                                    == Some(&format!("tier:{tid}"))
                        })
                        .and_then(|e2| {
                            e2.payload.get("state_value").and_then(|v2| v2.as_str())
                        })
                        .unwrap_or("0");
                    let is_revoked = entries.iter().any(|e2| {
                        e2.object_id == module_id
                            && e2.action == "STATE_WRITE"
                            && e2.payload.get("state_key").and_then(|v2| v2.as_str())
                                == Some(&format!("revoked:{tid}"))
                            && e2.payload.get("state_value").and_then(|v2| v2.as_str())
                                == Some("true")
                    });
                    let is_burned = entries.iter().any(|e2| {
                        e2.object_id == module_id
                            && e2.action == "STATE_WRITE"
                            && e2.payload.get("state_key").and_then(|v2| v2.as_str())
                                == Some(&format!("burned:{tid}"))
                            && e2.payload.get("state_value").and_then(|v2| v2.as_str())
                                == Some("true")
                    });
                    let status = if is_revoked {
                        "revoked"
                    } else if is_burned {
                        "burned"
                    } else {
                        "active"
                    };
                    holders.push(serde_json::json!({
                        "token_id": tid,
                        "owner": v,
                        "schema": schema,
                        "tier": tier,
                        "status": status,
                    }));
                }
            }
        }

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "module_id": module_id,
                "holders": holders,
            })),
        )
    }

    async fn handle_ctzn_check(
        ledger: Arc<Ledger<S>>,
        module_id: String,
        did: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let entries = ledger
            .storage()
            .namespace_entries(&"execution.module".to_string())
            .unwrap_or_default();

        let token_ids: Vec<String> = entries
            .iter()
            .filter(|e| {
                e.object_id == module_id
                    && e.action == "STATE_WRITE"
                    && e.payload.get("state_key").and_then(|v| v.as_str())
                        == Some(&format!("owner_lookup:{did}"))
            })
            .filter_map(|e| {
                e.payload
                    .get("state_value")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .collect();

        let mut tokens: Vec<serde_json::Value> = Vec::new();
        for tid in &token_ids {
            let owner = entries.iter().rev().find(|e| {
                e.object_id == module_id
                    && e.action == "STATE_WRITE"
                    && e.payload.get("state_key").and_then(|v| v.as_str())
                        == Some(&format!("owner:{tid}"))
            }).and_then(|e| {
                e.payload.get("state_value").and_then(|v| v.as_str())
            });
            let is_revoked = entries.iter().any(|e| {
                e.object_id == module_id
                    && e.action == "STATE_WRITE"
                    && e.payload.get("state_key").and_then(|v| v.as_str())
                        == Some(&format!("revoked:{tid}"))
                    && e.payload.get("state_value").and_then(|v| v.as_str())
                        == Some("true")
            });
            let is_burned = entries.iter().any(|e| {
                e.object_id == module_id
                    && e.action == "STATE_WRITE"
                    && e.payload.get("state_key").and_then(|v| v.as_str())
                        == Some(&format!("burned:{tid}"))
                    && e.payload.get("state_value").and_then(|v| v.as_str())
                        == Some("true")
            });
            let tier = entries.iter().rev().find(|e| {
                e.object_id == module_id
                    && e.action == "STATE_WRITE"
                    && e.payload.get("state_key").and_then(|v| v.as_str())
                        == Some(&format!("tier:{tid}"))
            }).and_then(|e| {
                e.payload.get("state_value").and_then(|v| v.as_str())
            }).unwrap_or("0");
            let schema = entries.iter().rev().find(|e| {
                e.object_id == module_id
                    && e.action == "STATE_WRITE"
                    && e.payload.get("state_key").and_then(|v| v.as_str())
                        == Some(&format!("schema:{tid}"))
            }).and_then(|e| {
                e.payload.get("state_value").and_then(|v| v.as_str())
            }).unwrap_or("");

            let status = if is_revoked {
                "revoked"
            } else if is_burned {
                "burned"
            } else {
                "active"
            };
            tokens.push(serde_json::json!({
                "token_id": tid,
                "owner": owner,
                "schema": schema,
                "tier": tier,
                "status": status,
            }));
        }

        let has_active = tokens.iter().any(|t| t["status"] == "active");

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "did": did,
                "module_id": module_id,
                "has_citizenship": has_active,
                "tokens": tokens,
            })),
        )
    }

    async fn handle_civic_admin_check(
        ledger: Arc<Ledger<S>>,
        did: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        // Try smart contract first (admin-registry module)
        let params = serde_json::json!({"operation": "check_admin", "did": &did});
        if let Ok(result) = ledger.execute_wasm_module(
            "admin-registry",
            &serde_json::to_string(&params).unwrap_or_default(),
            500_000,
        ) {
            if result.success {
                if let Some(output) = result.return_value.as_ref().and_then(|bytes| {
                    serde_json::from_slice::<serde_json::Value>(bytes).ok()
                }) {
                    let is_admin = output.get("is_admin").and_then(|v| v.as_bool()).unwrap_or(false);
                    let role = output.get("role").and_then(|v| v.as_str()).unwrap_or("admin");
                    let scope = output.get("scope").and_then(|v| v.as_str()).unwrap_or("national");
                    let revoked = output.get("revoked").and_then(|v| v.as_bool()).unwrap_or(false);
                    return (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "did": did,
                            "is_admin": is_admin,
                            "role": if is_admin { serde_json::json!(role) } else { serde_json::Value::Null },
                            "scope": if is_admin { serde_json::json!(scope) } else { serde_json::Value::Null },
                            "revoked": revoked,
                            "source": "smart-contract",
                        })),
                    );
                }
            }
        }

        // Fallback: native namespace-based admin check (civic.admin)
        let entries = ledger
            .storage()
            .namespace_entries(&"civic.admin".to_string())
            .unwrap_or_default();

        let assigned: Vec<&LedgerEntry> = entries.iter()
            .filter(|e| {
                e.action == "ASSIGN_ADMIN"
                    && e.payload.get("admin_did").and_then(|v| v.as_str()) == Some(&did)
            })
            .collect();

        let is_revoked = entries.iter().any(|e| {
            e.action == "REVOKE_ADMIN"
                && e.payload.get("admin_did").and_then(|v| v.as_str()) == Some(&did)
        });

        if assigned.is_empty() {
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "did": did,
                    "is_admin": false,
                    "role": null,
                    "scope": null,
                    "message": "not an admin",
                })),
            );
        }

        let latest = assigned.last().unwrap();
        let role = latest.payload.get("role").and_then(|v| v.as_str()).unwrap_or("admin");
        let scope = latest.payload.get("scope").and_then(|v| v.as_str()).unwrap_or("national");
        let assigned_by = latest.payload.get("assigned_by").and_then(|v| v.as_str()).unwrap_or("");
        let valid_until = latest.payload.get("valid_until").and_then(|v| v.as_str());

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "did": did,
                "is_admin": !is_revoked,
                "role": if is_revoked { serde_json::Value::Null } else { serde_json::json!(role) },
                "scope": if is_revoked { serde_json::Value::Null } else { serde_json::json!(scope) },
                "assigned_by": assigned_by,
                "assigned_at": latest.payload.get("assigned_at").and_then(|v| v.as_str()),
                "valid_until": valid_until,
                "revoked": is_revoked,
                "source": "namespace",
            })),
        )
    }

    async fn handle_kyc_public_key(
        ledger: Arc<Ledger<S>>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        // Try smart contract first (admin-registry module)
        let params = serde_json::json!({"operation": "get_kyc_key"});
        if let Ok(result) = ledger.execute_wasm_module(
            "admin-registry",
            &serde_json::to_string(&params).unwrap_or_default(),
            500_000,
        ) {
            if result.success {
                if let Some(output) = result.return_value.as_ref().and_then(|bytes| {
                    serde_json::from_slice::<serde_json::Value>(bytes).ok()
                }) {
                    let pk = output.get("public_key").and_then(|v| v.as_str());
                    if let Some(key) = pk {
                        if !key.is_empty() {
                            return (
                                StatusCode::OK,
                                Json(serde_json::json!({
                                    "public_key": key,
                                    "source": "smart-contract",
                                })),
                            );
                        }
                    }
                }
            }
        }

        // Fallback: native namespace-based KYC key (civic.admin)
        let entries = ledger
            .storage()
            .namespace_entries(&"civic.admin".to_string())
            .unwrap_or_default();

        let key_entry = entries.iter().rev()
            .find(|e| e.action == "SET_KYC_PUBLIC_KEY");

        match key_entry {
            Some(entry) => {
                let pk = entry.payload.get("kyc_encryption_public_key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "public_key": pk,
                        "set_by": entry.author,
                        "source": "namespace",
                    })),
                )
            }
            None => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "public_key": null,
                    "message": "No KYC encryption public key has been set",
                })),
            ),
        }
    }

    async fn handle_civic_registry_check(
        ledger: Arc<Ledger<S>>,
        did: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let entries = ledger
            .storage()
            .namespace_entries(&"civic.registry".to_string())
            .unwrap_or_default();

        let registration = entries.iter().rev()
            .filter(|e| {
                (e.action == "REGISTER_VOTER" || e.action == "UPDATE_JURISDICTION")
                    && e.payload.get("voter_did").and_then(|v| v.as_str()) == Some(&did)
            })
            .last();

        match registration {
            Some(entry) => {
                let (path_key, action_label) = if entry.action == "UPDATE_JURISDICTION" {
                    ("new_jurisdiction_path", "updated")
                } else {
                    ("jurisdiction_path", "registered")
                };

                let jurisdiction: Vec<String> = entry.payload.get(path_key)
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect())
                    .unwrap_or_default();

                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "did": did,
                        "registered": true,
                        "status": action_label,
                        "jurisdiction_path": jurisdiction,
                        "registered_by": entry.payload.get("verified_by")
                            .or_else(|| entry.payload.get("registered_by"))
                            .and_then(|v| v.as_str()),
                        "registered_at": entry.payload.get("registered_at")
                            .and_then(|v| v.as_str()),
                    })),
                )
            }
            None => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "did": did,
                    "registered": false,
                    "message": "voter not registered in civic.registry",
                })),
            ),
        }
    }

    async fn handle_voter_eligibility(
        ledger: Arc<Ledger<S>>,
        election_id: String,
        did: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let kyc_entries = ledger
            .storage()
            .namespace_entries(&"identity.kyc".to_string())
            .unwrap_or_default();

        let voter_path: Vec<String> = kyc_entries.iter().rev()
            .filter(|e| {
                e.action == "APPROVE_KYC" && e.object_id == did
            })
            .find(|_| true)
            .and_then(|e| {
                e.payload.get("jurisdiction_path").and_then(|v| v.as_array())
            })
            .map(|arr| arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect())
            .unwrap_or_default();

        let is_registered = !voter_path.is_empty();

        let election_entries = ledger
            .storage()
            .namespace_entries(&"civic.election".to_string())
            .unwrap_or_default();

        let election = election_entries.iter()
            .find(|e| e.action == "OPEN_ELECTION" && e.object_id == election_id);

        let is_open = election.is_some() && !election_entries.iter()
            .any(|e| e.action == "CLOSE_ELECTION" && e.object_id == election_id);

        let races = match ledger.reconstruct_election(&election_id) {
            Ok((_, r)) if !r.is_empty() => r,
            _ => election
                .and_then(|e| e.payload.get("races").and_then(|v| v.as_array()))
                .map(|arr| arr.clone())
                .unwrap_or_default(),
        };

        let mut eligible_races: Vec<serde_json::Value> = Vec::new();
        let mut ineligible_races: Vec<serde_json::Value> = Vec::new();

        for race in &races {
            let race_id = race.get("race_id").and_then(|v| v.as_str()).unwrap_or("");
            let title = race.get("title").and_then(|v| v.as_str()).unwrap_or("");

            if !is_registered {
                ineligible_races.push(serde_json::json!({
                    "race_id": race_id,
                    "title": title,
                    "reason": "voter not registered"
                }));
                continue;
            }

            if let Some(race_juris) = race.get("jurisdiction").and_then(|v| v.as_array()) {
                let race_path: Vec<String> = race_juris.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();

                if race_path.len() <= voter_path.len() {
                    let matches = race_path.iter()
                        .zip(voter_path.iter())
                        .all(|(e, v)| e.eq_ignore_ascii_case(v));
                    if matches {
                        eligible_races.push(serde_json::json!({"race_id": race_id, "title": title}));
                    } else {
                        ineligible_races.push(serde_json::json!({
                            "race_id": race_id, "title": title, "reason": "jurisdiction mismatch"
                        }));
                    }
                } else {
                    ineligible_races.push(serde_json::json!({
                        "race_id": race_id, "title": title, "reason": "jurisdiction mismatch"
                    }));
                }
            } else {
                eligible_races.push(serde_json::json!({"race_id": race_id, "title": title}));
            }
        }

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "election_id": election_id,
                "voter_did": did,
                "is_registered": is_registered,
                "jurisdiction_path": voter_path,
                "election_open": is_open,
                "eligible_races": eligible_races,
                "ineligible_races": ineligible_races,
            })),
        )
    }

    async fn handle_kyc_list(
        ledger: Arc<Ledger<S>>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let entries = ledger
            .storage()
            .namespace_entries(&"identity.kyc".to_string())
            .unwrap_or_default();

        let mut submissions: Vec<serde_json::Value> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for entry in entries.iter().rev() {
            if entry.action != "SUBMIT_KYC" {
                continue;
            }
            let did = entry.object_id.clone();
            if seen.contains(&did) {
                continue;
            }
            seen.insert(did.clone());

            // Collect all entries for this DID and sort by timestamp
            let mut did_entries: Vec<&LedgerEntry> = entries.iter()
                .filter(|e| e.object_id == did)
                .collect();
            did_entries.sort_by_key(|e| e.timestamp);

            let last_submit = did_entries.iter().rev()
                .find(|e| e.action == "SUBMIT_KYC");
            let last_approve = did_entries.iter().rev()
                .find(|e| e.action == "APPROVE_KYC");
            let last_revoke = did_entries.iter().rev()
                .find(|e| e.action == "REVOKE_KYC");

            let status = match (last_submit, last_approve, last_revoke) {
                (Some(s), None, None) => "submitted",
                (Some(_), Some(a), None) => "approved",
                (None, _, _) => "unknown",
                (Some(_), _, Some(r)) if r.timestamp >= last_approve.map_or(0, |a| a.timestamp) => "revoked",
                (Some(_), Some(_), Some(_)) => "approved",
                _ => "unknown",
            };

            let approval = did_entries.iter().rev()
                .find(|e| e.action == "APPROVE_KYC");

            let (full_name, address, encrypted) = if entry.privacy_flag {
                (None, None, serde_json::json!({
                    "ciphertext_hex": entry.ciphertext_hex,
                    "nonce_hex": entry.nonce_hex,
                    "payload_commitment": entry.payload_commitment,
                    "hybrid_author_x25519_public_key": entry.payload.get("hybrid_author_x25519_public_key").and_then(|v| v.as_str()),
                    "key_wrapped_secrets": entry.payload.get("key_wrapped_secrets").unwrap_or(&serde_json::Value::Null),
                }))
            } else {
                (
                    entry.payload.get("full_name").and_then(|v| v.as_str()),
                    entry.payload.get("address").and_then(|v| v.as_str()),
                    serde_json::Value::Null,
                )
            };

            submissions.push(serde_json::json!({
                "did": did,
                "status": status,
                "full_name": full_name,
                "address": address,
                "encrypted": encrypted,
                "jurisdiction_path": approval.and_then(|e| e.payload.get("jurisdiction_path").and_then(|v| v.as_array()))
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>()),
                "verified_by": approval.map(|e| e.author.clone()),
                "author": entry.author.clone(),
            }));
        }

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "submissions": submissions,
                "total": submissions.len(),
            })),
        )
    }

    async fn handle_kyc_status(
        ledger: Arc<Ledger<S>>,
        did: String,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let entries = ledger
            .storage()
            .namespace_entries(&"identity.kyc".to_string())
            .unwrap_or_default();

        let submitted = entries.iter().any(|e| {
            e.action == "SUBMIT_KYC" && e.object_id == did
        });

        if !submitted {
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "did": did,
                    "kyc_status": "not_submitted",
                    "message": "No KYC submission found",
                })),
            );
        }

        // Use timestamp-based recency to determine the real current status.
        let mut did_entries: Vec<&LedgerEntry> = entries.iter()
            .filter(|e| e.object_id == did)
            .collect();
        did_entries.sort_by_key(|e| e.timestamp);

        let last_submit = did_entries.iter().rev()
            .find(|e| e.action == "SUBMIT_KYC");
        let last_approve = did_entries.iter().rev()
            .find(|e| e.action == "APPROVE_KYC");
        let last_revoke = did_entries.iter().rev()
            .find(|e| e.action == "REVOKE_KYC");

        let status = match (last_submit, last_approve, last_revoke) {
            (Some(s), None, None) => "submitted",
            (Some(_), Some(_), None) => "approved",
            (None, _, _) => "not_submitted",
            (Some(_), _, Some(r)) if r.timestamp >= last_approve.map_or(0, |a| a.timestamp) => "revoked",
            (Some(_), Some(_), Some(_)) => "approved",
            _ => "unknown",
        };

        let submission = did_entries.iter().rev()
            .find(|e| e.action == "SUBMIT_KYC");

        let approval = did_entries.iter().rev()
            .find(|e| e.action == "APPROVE_KYC");

        if status == "not_submitted" || last_submit.is_none() {
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "did": did,
                    "kyc_status": "not_submitted",
                    "message": "No KYC submission found",
                })),
            );
        }

        let (full_name, address, encrypted) = if let Some(ref sub) = submission {
            if sub.privacy_flag {
                (None, None, serde_json::json!({
                    "ciphertext_hex": &sub.ciphertext_hex,
                    "nonce_hex": &sub.nonce_hex,
                    "payload_commitment": &sub.payload_commitment,
                    "hybrid_author_x25519_public_key": sub.payload.get("hybrid_author_x25519_public_key").and_then(|v| v.as_str()),
                    "key_wrapped_secrets": sub.payload.get("key_wrapped_secrets").unwrap_or(&serde_json::Value::Null),
                }))
            } else {
                (
                    sub.payload.get("full_name").and_then(|v| v.as_str()),
                    sub.payload.get("address").and_then(|v| v.as_str()),
                    serde_json::Value::Null,
                )
            }
        } else {
            (None, None, serde_json::Value::Null)
        };

        (
            StatusCode::OK,
            Json(serde_json::json!({
                "did": did,
                "kyc_status": status,
                "submitted_at": submission.and_then(|e| e.payload.get("submitted_at").and_then(|v| v.as_str())),
                "full_name": full_name,
                "address": address,
                "encrypted": encrypted,
                "verified_by": approval.map(|e| e.author.clone()),
                "jurisdiction_path": approval.and_then(|e| e.payload.get("jurisdiction_path").and_then(|v| v.as_array()))
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>()),
            })),
        )
    }

    fn build_did_document(did: &str, entries: &[LedgerEntry]) -> Option<DidDocument> {
        let mut latest: Option<&LedgerEntry> = None;
        for entry in entries {
            if entry.object_id != did {
                continue;
            }
            if latest
                .map(|current| entry.timestamp > current.timestamp)
                .unwrap_or(true)
            {
                latest = Some(entry);
            }
        }
        latest.map(|entry| DidDocument {
            did: did.to_string(),
            controller: entry.author.clone(),
            status: if entry.action == "REVOKE_IDENTITY" {
                DidStatus::Revoked
            } else {
                DidStatus::Active
            },
            claims_hash: entry
                .payload
                .get("claims_hash")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            updated_at: entry.timestamp,
        })
    }

    async fn authorize_write(
        edge: Arc<ApiEdgeState>,
        headers: &HeaderMap,
        required_scope: &str,
    ) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
        Self::authorize_scope(edge, headers, required_scope, true).await
    }

    async fn authorize_scope(
        edge: Arc<ApiEdgeState>,
        headers: &HeaderMap,
        required_scope: &str,
        enforce_write_limits: bool,
    ) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
        if enforce_write_limits && !edge.config.write_enabled {
            return Err((
                StatusCode::FORBIDDEN,
                Json(
                    serde_json::json!({"error": "write endpoints disabled for this node profile"}),
                ),
            ));
        }

        let principal = if edge.config.auth_required {
            let Some(token) = headers.get("x-api-key") else {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "missing x-api-key header"})),
                ));
            };
            let token = token.to_str().ok().unwrap_or_default().to_string();
            let Some(client) = edge.config.clients.get(&token) else {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "invalid api key"})),
                ));
            };
            if !client.scopes.contains(required_scope) {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(
                        serde_json::json!({"error": "api key missing required scope", "required_scope": required_scope}),
                    ),
                ));
            }
            token
        } else {
            "anonymous".to_string()
        };

        if enforce_write_limits {
            let now = Utc::now().timestamp();
            let mut windows = edge.write_windows.lock().await;
            let entries = windows.entry(principal).or_default();
            entries.retain(|timestamp| *timestamp > now - 60);
            if entries.len() >= edge.config.max_write_requests_per_minute {
                return Err((
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(serde_json::json!({"error": "write rate limit exceeded"})),
                ));
            }
            entries.push(now);
        }
        Ok(())
    }

    async fn check_namespace_rate_limit(
        edge: &ApiEdgeState,
        namespace: &str,
    ) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
        let limit = edge
            .config
            .namespace_rate_limits
            .get(namespace)
            .copied()
            .unwrap_or(edge.config.max_write_requests_per_minute);
        if limit == 0 {
            return Ok(());
        }
        let now = Utc::now().timestamp();
        let mut windows = edge.write_windows.lock().await;
        let key = format!("ns:{}", namespace);
        let entries = windows.entry(key).or_default();
        entries.retain(|timestamp| *timestamp > now - 60);
        if entries.len() >= limit {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({
                    "error": "namespace write rate limit exceeded",
                    "namespace": namespace,
                    "limit": limit,
                })),
            ));
        }
        entries.push(now);
        Ok(())
    }

    fn check_namespace_entry_size(
        edge: &ApiEdgeState,
        entry: &LedgerEntry,
    ) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
        let max_bytes = edge
            .config
            .namespace_max_entry_bytes
            .get(&entry.namespace)
            .copied();
        if let Some(max) = max_bytes {
            // In governance-first mode, encrypted entries (hybrid privacy mode
            // with ciphertext) are exempt from per-namespace size caps — they
            // are pre-authorized by the governance gate. Only the global 50MB
            // envelope limit applies.
            let is_encrypted = matches!(
                entry.privacy_mode,
                citizen_types::PrivacyMode::Hybrid
            ) && entry.ciphertext_hex.is_some();
            if edge.config.blockchain_mode == BlockchainMode::GovernanceFirst && is_encrypted {
                return Ok(());
            }
            let size = serde_json::to_vec(entry).map(|v| v.len()).unwrap_or(0);
            if size > max {
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    Json(serde_json::json!({
                        "error": "entry_too_large",
                        "namespace": entry.namespace,
                        "size_bytes": size,
                        "max_bytes": max,
                    })),
                ));
            }
        }
        Ok(())
    }

    fn offchain_feature_disabled_response() -> (StatusCode, Json<serde_json::Value>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "offchain encrypted files feature is disabled",
                "feature_flag": "offchain_encrypted_files_v1",
            })),
        )
    }

    async fn record_file_access_alert(edge: Arc<ApiEdgeState>, alert: FileAccessAlert) {
        const MAX_ALERTS: usize = 500;
        let mut alerts = edge.file_access_alerts.lock().await;
        alerts.push(alert);
        if alerts.len() > MAX_ALERTS {
            let overflow = alerts.len() - MAX_ALERTS;
            alerts.drain(0..overflow);
        }
    }
}

fn compute_entry_root(entries: &[LedgerEntry]) -> String {
    if entries.is_empty() {
        return "EMPTY".to_string();
    }

    if entries.len() == 1 {
        return format!("entry:{}", entries[0].entry_id);
    }

    let mut hasher = blake3::Hasher::new();
    for entry in entries {
        hasher.update(entry.entry_id.as_bytes());
        hasher.update(entry.namespace.as_bytes());
        hasher.update(entry.action.as_bytes());
        hasher.update(entry.object_id.as_bytes());
        hasher.update(entry.signature.as_bytes());
        hasher.update(&entry.timestamp.to_be_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

fn extract_offchain_commitments(entry: &LedgerEntry) -> Option<OffchainCommitmentSummary> {
    let payload_commitment = entry.payload_commitment.clone()?;

    let encrypted_field_commitments = entry
        .payload
        .get("encrypted_field_refs")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let field_path = item.get("field_path")?.as_str()?;
                    let payload_commitment = item.get("payload_commitment")?.as_str()?;
                    Some(PayloadFieldCommitmentSummary {
                        field_path: field_path.to_string(),
                        payload_commitment: payload_commitment.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(OffchainCommitmentSummary {
        payload_commitment,
        manifest_id: entry
            .payload
            .get("manifest_id")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        ciphertext_hash: entry
            .payload
            .get("ciphertext_hash")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        encrypted_field_commitments,
    })
}

fn protocol_error_response(err: ProtocolError) -> (StatusCode, Json<serde_json::Value>) {
    let status = match &err {
        ProtocolError::InvalidNamespace(_) | ProtocolError::ValidationFailed(_) => {
            StatusCode::BAD_REQUEST
        }
        ProtocolError::StorageError(_) => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };

    (
        status,
        Json(serde_json::json!(ApiError {
            error: err.to_string(),
        })),
    )
}

fn protocol_batch_error_response(
    err: ProtocolError,
    envelope_index: usize,
    envelope_id: Uuid,
    stage: &str,
) -> (StatusCode, Json<serde_json::Value>) {
    let (status, Json(mut payload)) = protocol_error_response(err);
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "failed_envelope".to_string(),
            serde_json::json!({
                "index": envelope_index,
                "envelope_id": envelope_id,
                "stage": stage,
            }),
        );
    }
    (status, Json(payload))
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_envelope_preimage, ApiClientProfile, ApiEdgeConfig, ApiEdgeState, ApiServer,
        DataHashQueryParams, LocalOffchainObjectStore, MinioOffchainObjectStoreConfig,
    };
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use axum::Json;
    use chrono::Utc;
    use citizen_crypto::{sign_message, verifying_key_to_string, KeyRegistry, ValidatorKeypair};
    use citizen_ledger::Ledger;
    use citizen_storage::{LedgerStorage, MemoryStorage};
    use citizen_types::{
        Block, BlockHeader, CommitProof, LedgerEntry, NamespaceDescriptor, NamespaceRule,
        NamespaceRuleset, SignedEnvelope,
    };
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::collections::{BTreeSet, HashMap};
    use std::sync::Arc;
    use tower::util::ServiceExt;
    use uuid::Uuid;

    fn build_server() -> ApiServer<MemoryStorage> {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        build_server_with_grant_keys(&grant_keys)
    }

    fn build_server_with_grant_keys(
        grant_keys: &HashMap<String, ValidatorKeypair>,
    ) -> ApiServer<MemoryStorage> {
        build_server_with_grant_keys_and_file_policy(
            grant_keys,
            &["ENCRYPTED_FILE_UPLOAD"],
            None,
            None,
        )
    }

    fn build_server_with_grant_keys_and_file_actions(
        grant_keys: &HashMap<String, ValidatorKeypair>,
        allowed_file_actions: &[&str],
    ) -> ApiServer<MemoryStorage> {
        build_server_with_grant_keys_and_file_policy(grant_keys, allowed_file_actions, None, None)
    }

    fn build_server_with_grant_keys_and_file_policy(
        grant_keys: &HashMap<String, ValidatorKeypair>,
        allowed_file_actions: &[&str],
        required_consent_policy_ref: Option<&str>,
        payload_field_policy_config: Option<serde_json::Value>,
    ) -> ApiServer<MemoryStorage> {
        let storage = Arc::new(MemoryStorage::new());
        let ledger = Arc::new(Ledger::new(storage, KeyRegistry::new()));
        ledger.register_rule_handler(
            "offchain_encrypted_file_policy",
            |_ledger, _entry, _config| Ok(()),
        );
        ledger.register_rule_handler(
            "offchain_encrypted_payload_field_policy",
            |_ledger, _entry, _config| Ok(()),
        );
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "audit.procurement".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![
                NamespaceRule {
                    name: "require_signature".to_string(),
                    config: json!({}),
                },
                NamespaceRule {
                    name: "privacy_policy".to_string(),
                    config: json!({"allow_encryption": true}),
                },
            ],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "files.secure".to_string(),
                version: 1,
                rules_hash: "files-secure-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![
                NamespaceRule {
                    name: "offchain_encrypted_file_policy".to_string(),
                    config: {
                        let mut policy = json!({
                            "enabled": true,
                            "max_file_size_bytes": 10_485_760,
                            "allowed_mime_types": [
                                "audio/mpeg",
                                "audio/wav",
                                "video/mp4",
                                "video/webm",
                                "application/json",
                                "application/pdf",
                                "application/msword",
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                "application/vnd.ms-excel",
                                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                "image/jpeg",
                                "image/png",
                                "image/webp"
                            ],
                            "allowed_encryption_modes": ["passphrase", "hybrid-acl"],
                            "allowed_actions": allowed_file_actions
                        });
                        if let Some(policy_ref) = required_consent_policy_ref {
                            policy["required_consent_policy_ref"] = json!(policy_ref);
                        }
                        policy
                    },
                },
                NamespaceRule {
                    name: "offchain_encrypted_payload_field_policy".to_string(),
                    config: payload_field_policy_config.unwrap_or_else(|| {
                        json!({
                            "offchain_encrypted_fields": ["payload.ssn", "payload.medical_record"]
                        })
                    }),
                },
            ],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "identity.citizen".to_string(),
                version: 1,
                rules_hash: "identity-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "allowed_actions".to_string(),
                config: json!({"actions":["REGISTER_IDENTITY","UPDATE_CLAIM","REVOKE_IDENTITY"]}),
            }, NamespaceRule {
                name: "author_matches_object_id".to_string(),
                config: json!({}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "consent.receipt".to_string(),
                version: 1,
                rules_hash: "consent-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![
                NamespaceRule {
                    name: "consent_policy".to_string(),
                    config: json!({
                        "required_fields":["data_hash","policy_ref","expires_at"],
                        "max_ttl_secs": 86400
                    }),
                },
                NamespaceRule {
                    name: "allowed_actions".to_string(),
                    config: json!({"actions":["CONSENT_GRANTED","CONSENT_REVOKED"]}),
                },
                NamespaceRule {
                    name: "author_matches_object_id".to_string(),
                    config: json!({}),
                },
            ],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "builder.credits".to_string(),
                version: 1,
                rules_hash: "builder-credits-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "builder_credit_policy".to_string(),
                config: json!({"max_daily_spend": 10_000, "required_grant_approvals": 3, "grant_approvers": grant_approvers_config(grant_keys)}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "asset.control".to_string(),
                version: 1,
                rules_hash: "asset-controls-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "asset_control_policy".to_string(),
                config: json!({"allowed_policy_flags": ["kyc_required", "attestation_required", "clawback_enabled"]}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "execution.module".to_string(),
                version: 1,
                rules_hash: "execution-module-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "wasm_runtime_policy".to_string(),
                config: json!({
                    "allowed_module_classes": ["asset", "interop", "identity"],
                    "required_governance_approvals": 1
                }),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "interop.adapter".to_string(),
                version: 1,
                rules_hash: "interop-adapter-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "interop_adapter_policy".to_string(),
                config: json!({"allowed_standards": ["did-core", "vc-data-model"]}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "civic.proposal".to_string(),
                version: 1,
                rules_hash: "civic-proposal-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "allowed_actions".to_string(),
                config: json!({"actions":["OPEN_PROPOSAL","CLOSE_PROPOSAL"]}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "civic.ballot".to_string(),
                version: 1,
                rules_hash: "civic-ballot-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "civic_voting_policy".to_string(),
                config: json!({
                    "proposal_namespace": "civic.proposal",
                    "valid_choices": ["yes", "no", "abstain"]
                }),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "civic.election".to_string(),
                version: 1,
                rules_hash: "civic-election-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "allowed_actions".to_string(),
                config: json!({"actions":["OPEN_ELECTION","CLOSE_ELECTION"]}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "civic.election.ballot".to_string(),
                version: 1,
                rules_hash: "civic-election-ballot-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "election_ballot_policy".to_string(),
                config: json!({
                    "election_namespace": "civic.election"
                }),
            }],
        }]);
        ApiServer::with_edge_config(
            ledger,
            ApiEdgeConfig {
                offchain_encrypted_files_v1_enabled: true,
                ..ApiEdgeConfig::default()
            },
        )
    }

    fn build_server_with_grant_keys_and_file_policy_and_minio(
        grant_keys: &HashMap<String, ValidatorKeypair>,
        allowed_file_actions: &[&str],
        required_consent_policy_ref: Option<&str>,
        payload_field_policy_config: Option<serde_json::Value>,
        minio: MinioOffchainObjectStoreConfig,
    ) -> ApiServer<MemoryStorage> {
        let storage = Arc::new(MemoryStorage::new());
        let ledger = Arc::new(Ledger::new(storage, KeyRegistry::new()));
        ledger.register_rule_handler(
            "offchain_encrypted_file_policy",
            |_ledger, _entry, _config| Ok(()),
        );
        ledger.register_rule_handler(
            "offchain_encrypted_payload_field_policy",
            |_ledger, _entry, _config| Ok(()),
        );
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "audit.procurement".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![
                NamespaceRule {
                    name: "require_signature".to_string(),
                    config: json!({}),
                },
                NamespaceRule {
                    name: "privacy_policy".to_string(),
                    config: json!({"allow_encryption": true}),
                },
            ],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "files.secure".to_string(),
                version: 1,
                rules_hash: "files-secure-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![
                NamespaceRule {
                    name: "offchain_encrypted_file_policy".to_string(),
                    config: {
                        let mut policy = json!({
                            "enabled": true,
                            "max_file_size_bytes": 10_485_760,
                            "allowed_mime_types": [
                                "audio/mpeg",
                                "audio/wav",
                                "video/mp4",
                                "video/webm",
                                "application/json",
                                "application/pdf",
                                "application/msword",
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                "application/vnd.ms-excel",
                                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                "image/jpeg",
                                "image/png",
                                "image/webp"
                            ],
                            "allowed_encryption_modes": ["passphrase", "hybrid-acl"],
                            "allowed_actions": allowed_file_actions
                        });
                        if let Some(policy_ref) = required_consent_policy_ref {
                            policy["required_consent_policy_ref"] = json!(policy_ref);
                        }
                        policy
                    },
                },
                NamespaceRule {
                    name: "offchain_encrypted_payload_field_policy".to_string(),
                    config: payload_field_policy_config.unwrap_or_else(|| {
                        json!({
                            "offchain_encrypted_fields": ["payload.ssn", "payload.medical_record"]
                        })
                    }),
                },
            ],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "identity.citizen".to_string(),
                version: 1,
                rules_hash: "identity-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "allowed_actions".to_string(),
                config: json!({"actions":["REGISTER_IDENTITY","UPDATE_CLAIM","REVOKE_IDENTITY"]}),
            }, NamespaceRule {
                name: "author_matches_object_id".to_string(),
                config: json!({}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "consent.receipt".to_string(),
                version: 1,
                rules_hash: "consent-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![
                NamespaceRule {
                    name: "consent_policy".to_string(),
                    config: json!({
                        "required_fields":["data_hash","policy_ref","expires_at"],
                        "max_ttl_secs": 86400
                    }),
                },
                NamespaceRule {
                    name: "allowed_actions".to_string(),
                    config: json!({"actions":["CONSENT_GRANTED","CONSENT_REVOKED"]}),
                },
                NamespaceRule {
                    name: "author_matches_object_id".to_string(),
                    config: json!({}),
                },
            ],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "builder.credits".to_string(),
                version: 1,
                rules_hash: "builder-credits-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "builder_credit_policy".to_string(),
                config: json!({"max_daily_spend": 10_000, "required_grant_approvals": 3, "grant_approvers": grant_approvers_config(grant_keys)}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "asset.control".to_string(),
                version: 1,
                rules_hash: "asset-controls-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "asset_control_policy".to_string(),
                config: json!({"allowed_policy_flags": ["kyc_required", "attestation_required", "clawback_enabled"]}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "execution.module".to_string(),
                version: 1,
                rules_hash: "execution-module-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "wasm_runtime_policy".to_string(),
                config: json!({
                    "allowed_module_classes": ["asset", "interop", "identity"],
                    "required_governance_approvals": 1
                }),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "interop.adapter".to_string(),
                version: 1,
                rules_hash: "interop-adapter-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "interop_adapter_policy".to_string(),
                config: json!({"allowed_standards": ["did-core", "vc-data-model"]}),
            }],
        }]);
        ApiServer::with_edge_config_and_minio_store(
            ledger,
            ApiEdgeConfig {
                offchain_encrypted_files_v1_enabled: true,
                ..ApiEdgeConfig::default()
            },
            minio,
        )
        .expect("minio store should initialize")
    }
    fn build_server_with_edge(edge: ApiEdgeConfig) -> ApiServer<MemoryStorage> {
        let storage = Arc::new(MemoryStorage::new());
        let ledger = Arc::new(Ledger::new(storage, KeyRegistry::new()));
        ledger.register_rule_handler(
            "offchain_encrypted_file_policy",
            |_ledger, _entry, _config| Ok(()),
        );
        ledger.register_rule_handler(
            "offchain_encrypted_payload_field_policy",
            |_ledger, _entry, _config| Ok(()),
        );
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "audit.procurement".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![
                NamespaceRule {
                    name: "require_signature".to_string(),
                    config: json!({}),
                },
                NamespaceRule {
                    name: "privacy_policy".to_string(),
                    config: json!({"allow_encryption": true}),
                },
            ],
        }]);
        ApiServer::with_edge_config(ledger, edge)
    }

    fn build_server_with_builder_credit_namespace(edge: ApiEdgeConfig) -> ApiServer<MemoryStorage> {
        let storage = Arc::new(MemoryStorage::new());
        let ledger = Arc::new(Ledger::new(storage, KeyRegistry::new()));
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "audit.procurement".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "require_signature".to_string(),
                config: json!({}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "builder.credits".to_string(),
                version: 1,
                rules_hash: "builder-credits-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "require_signature".to_string(),
                config: json!({}),
            }],
        }]);
        ApiServer::with_edge_config(ledger, edge)
    }

    fn grant_approver_keys(approvers: &[&str]) -> HashMap<String, ValidatorKeypair> {
        approvers
            .iter()
            .map(|approver| {
                (
                    (*approver).to_string(),
                    ValidatorKeypair::generate((*approver).to_string()),
                )
            })
            .collect()
    }

    fn grant_approvers_config(keys: &HashMap<String, ValidatorKeypair>) -> Vec<serde_json::Value> {
        let mut approver_ids: Vec<&String> = keys.keys().collect();
        approver_ids.sort();
        approver_ids
            .iter()
            .map(|approver| {
                let keypair = keys
                    .get(*approver)
                    .expect("grant approver keypair must exist");
                json!({
                    "id": approver,
                    "public_key": verifying_key_to_string(keypair.verifying_key())
                })
            })
            .collect()
    }

    fn attach_multisig_proofs(
        entry: &mut LedgerEntry,
        approvers: &[&str],
        keys: &HashMap<String, ValidatorKeypair>,
    ) {
        let amount = entry
            .payload
            .get("amount")
            .and_then(serde_json::Value::as_u64)
            .expect("multisig grant amount");

        let proofs: Vec<serde_json::Value> = approvers
            .iter()
            .map(|approver| {
                let keypair = keys
                    .get(*approver)
                    .expect("missing key for requested approver");
                let message = serde_json::to_string(&json!({
                    "entry_id": entry.entry_id,
                    "namespace": entry.namespace,
                    "action": entry.action,
                    "object_id": entry.object_id,
                    "author": entry.author,
                    "amount": amount,
                    "timestamp": entry.timestamp,
                    "approver": approver
                }))
                .expect("serialize signing message");
                let signature = sign_message(&keypair, message.as_bytes());
                json!({
                    "approver": approver,
                    "public_key": verifying_key_to_string(keypair.verifying_key()),
                    "signature": hex::encode(signature.to_bytes())
                })
            })
            .collect();

        entry.payload = json!({"amount": amount, "multisig_proofs": proofs});
    }
    fn sign_entry_for_tests(entry: &mut LedgerEntry, keypair: &ValidatorKeypair) {
        entry.payload["author_public_key"] =
            json!(verifying_key_to_string(keypair.verifying_key()));
        let signing_payload = json!({
            "entry_id": entry.entry_id,
            "namespace": entry.namespace,
            "action": entry.action,
            "object_id": entry.object_id,
            "payload": entry.payload,
            "author": entry.author,
            "timestamp": entry.timestamp,
        });
        let signature = sign_message(keypair, canonical_json(&signing_payload).as_bytes());
        entry.signature = hex::encode(signature.to_bytes());
    }

    fn canonical_json(value: &Value) -> String {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let parts: Vec<String> = keys
                    .iter()
                    .map(|key| {
                        let encoded_key =
                            serde_json::to_string(key).expect("canonical object key serialization");
                        let encoded_value = canonical_json(&map[*key]);
                        format!("{encoded_key}:{encoded_value}")
                    })
                    .collect();
                format!("{{{}}}", parts.join(","))
            }
            Value::Array(items) => {
                let encoded_items: Vec<String> = items.iter().map(canonical_json).collect();
                format!("[{}]", encoded_items.join(","))
            }
            _ => serde_json::to_string(value).expect("canonical scalar serialization"),
        }
    }

    fn test_envelope() -> SignedEnvelope<LedgerEntry> {
        let keypair = ValidatorKeypair::generate("did:author:a".to_string());
        let mut payload = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "PROC-001".to_string(),
            payload: json!({"event":"BID_OPENED"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:a".to_string(),
            signature: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
        };
        sign_entry_for_tests(&mut payload, &keypair);
        SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: payload.author.clone(),
            signature: payload.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload,
        }
    }

    fn test_multisig_envelope_with_scope(signature_scope: &str) -> SignedEnvelope<LedgerEntry> {
        let author_key = ValidatorKeypair::generate("author".to_string());
        let co_signer_key = ValidatorKeypair::generate("co-signer".to_string());
        let author_did = format!(
            "did:key:{}",
            verifying_key_to_string(author_key.verifying_key())
        );
        let co_signer_did = format!(
            "did:key:{}",
            verifying_key_to_string(co_signer_key.verifying_key())
        );
        let mut payload = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "PROC-001".to_string(),
            payload: json!({"event":"BID_OPENED"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: author_did.clone(),
            signature: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
        };
        payload.payload["author_public_key"] =
            json!(verifying_key_to_string(author_key.verifying_key()));
        if signature_scope == "canonical_payload_v2" {
            payload.payload["replay_protection"] = json!({
                "request_id": format!("req-{}", Uuid::new_v4()),
                "expires_at": chrono::Utc::now().timestamp() + 300,
            });
        }

        let preimage =
            canonical_envelope_preimage(&payload, signature_scope).expect("canonical preimage");
        let author_signature =
            hex::encode(sign_message(&author_key, preimage.as_bytes()).to_bytes());
        let co_signature =
            hex::encode(sign_message(&co_signer_key, preimage.as_bytes()).to_bytes());
        payload.signature = author_signature.clone();

        SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: author_did,
            signature: author_signature,
            signature_scope: Some(signature_scope.to_string()),
            co_signatures: vec![citizen_types::EnvelopeCoSignature {
                signer: co_signer_did.clone(),
                signature: co_signature,
            }],
            multisig_policy: Some(citizen_types::EnvelopeMultisigPolicy {
                threshold: 2,
                allowed_signers: vec![payload.author.clone(), co_signer_did],
                require_author_signature: true,
            }),
            submitted_at: chrono::Utc::now(),
            payload,
        }
    }

    fn test_multisig_envelope() -> SignedEnvelope<LedgerEntry> {
        test_multisig_envelope_with_scope("canonical_payload_v1")
    }

    #[tokio::test]
    async fn envelope_submission_returns_receipt_with_finality() {
        let app = build_server().router();
        let envelope = test_envelope();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        assert_eq!(status, StatusCode::ACCEPTED);
        let payload: Value = serde_json::from_slice(&body).expect("submit payload");

        let receipt = &payload["receipt"];
        assert_eq!(receipt["status"], "Accepted");
        assert_eq!(
            receipt["validation"]["outcome"],
            "namespace rules accepted and finalized"
        );
        assert_eq!(receipt["finality"]["block_height"], 1);
        assert!(receipt["finality"]["block_hash"].as_str().is_some());
        assert_eq!(
            receipt["finality"]["commit_proof"]["aggregated_signature"],
            "local-dev-finality"
        );
    }

    #[tokio::test]
    async fn receipt_lookup_returns_same_finality_proof() {
        let app = build_server().router();
        let envelope = test_envelope();

        let submit = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let submit_body = axum::body::to_bytes(submit.into_body(), usize::MAX)
            .await
            .expect("submit bytes");
        let submit_json: Value = serde_json::from_slice(&submit_body).expect("submit json");
        let receipt_id = submit_json["receipt"]["receipt_id"]
            .as_str()
            .expect("receipt id string");

        let receipt_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/v1/receipts/{receipt_id}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("receipt response");

        assert_eq!(receipt_response.status(), StatusCode::OK);
        let receipt_body = axum::body::to_bytes(receipt_response.into_body(), usize::MAX)
            .await
            .expect("receipt bytes");
        let receipt_json: Value = serde_json::from_slice(&receipt_body).expect("receipt json");
        assert_eq!(
            receipt_json["receipt"]["finality"]["commit_proof"]["aggregated_signature"],
            "local-dev-finality"
        );
        assert_eq!(receipt_json["receipt"]["finality"]["block_height"], 1);
    }

    #[tokio::test]
    async fn batch_envelope_submission_commits_multiple_entries_in_single_block() {
        let app = build_server().router();
        let envelope_a = test_envelope();
        let envelope_b = test_envelope();

        let batch_submit = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit-batch")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&vec![envelope_a.clone(), envelope_b.clone()])
                            .expect("serialize envelopes"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        assert_eq!(batch_submit.status(), StatusCode::ACCEPTED);
        let batch_body = axum::body::to_bytes(batch_submit.into_body(), usize::MAX)
            .await
            .expect("batch bytes");
        let batch_json: Value = serde_json::from_slice(&batch_body).expect("batch json");
        assert_eq!(batch_json["status"], "accepted");
        assert_eq!(batch_json["batch_size"], 2);
        assert_eq!(
            batch_json["receipts"].as_array().map(|items| items.len()),
            Some(2)
        );
        assert_eq!(
            batch_json["receipts"][0]["receipt"]["finality"]["block_height"],
            1
        );
        assert_eq!(
            batch_json["receipts"][1]["receipt"]["finality"]["block_height"],
            1
        );

        let block_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/blocks/1")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("block response");

        assert_eq!(block_response.status(), StatusCode::OK);
        let block_body = axum::body::to_bytes(block_response.into_body(), usize::MAX)
            .await
            .expect("block bytes");
        let block_json: Value = serde_json::from_slice(&block_body).expect("block json");
        assert_eq!(
            block_json["block"]["entries"]
                .as_array()
                .map(|entries| entries.len()),
            Some(2)
        );
    }

    #[tokio::test]
    async fn batch_envelope_submission_returns_deterministic_failed_envelope_details() {
        let app = build_server().router();
        let valid = test_envelope();
        let mut invalid_multisig = test_multisig_envelope();
        invalid_multisig.co_signatures[0].signer = invalid_multisig.signer.clone();
        let invalid_envelope_id = invalid_multisig.envelope_id.to_string();

        let batch_submit = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit-batch")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&vec![valid, invalid_multisig])
                            .expect("serialize envelopes"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        assert_eq!(batch_submit.status(), StatusCode::BAD_REQUEST);
        let batch_body = axum::body::to_bytes(batch_submit.into_body(), usize::MAX)
            .await
            .expect("batch bytes");
        let batch_json: Value = serde_json::from_slice(&batch_body).expect("batch json");
        assert_eq!(batch_json["failed_envelope"]["index"], 1);
        assert_eq!(
            batch_json["failed_envelope"]["envelope_id"],
            invalid_envelope_id
        );
        assert_eq!(
            batch_json["failed_envelope"]["stage"],
            "signature_validation"
        );
        assert!(batch_json["error"].as_str().is_some());
    }

    #[tokio::test]
    async fn legacy_submit_entry_routes_through_envelope_receipt_flow() {
        let app = build_server().router();
        let envelope = test_envelope();
        let entry = envelope.payload;

        let submit = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&entry).expect("serialize entry"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        assert_eq!(submit.status(), StatusCode::ACCEPTED);
        let submit_body = axum::body::to_bytes(submit.into_body(), usize::MAX)
            .await
            .expect("submit bytes");
        let submit_json: Value = serde_json::from_slice(&submit_body).expect("submit json");

        let receipt_id = submit_json["receipt"]["receipt_id"]
            .as_str()
            .expect("receipt id string");
        assert_eq!(submit_json["status"], "accepted");
        assert_eq!(submit_json["namespace"], "audit.procurement");

        let receipt_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/v1/receipts/{receipt_id}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("receipt response");

        assert_eq!(receipt_response.status(), StatusCode::OK);
        let receipt_body = axum::body::to_bytes(receipt_response.into_body(), usize::MAX)
            .await
            .expect("receipt bytes");
        let receipt_json: Value = serde_json::from_slice(&receipt_body).expect("receipt json");
        assert_eq!(receipt_json["receipt"]["status"], "Accepted");
        assert_eq!(receipt_json["receipt"]["finality"]["block_height"], 1);
        assert_eq!(
            receipt_json["receipt"]["finality"]["commit_proof"]["aggregated_signature"],
            "local-dev-finality"
        );
    }

    #[tokio::test]
    async fn resolves_did_from_identity_namespace() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys(&grant_keys).router();
        let now = chrono::Utc::now().timestamp();
        let identity_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "identity.citizen".to_string(),
            action: "REGISTER_IDENTITY".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({"claims_hash":"0xabc"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::Hybrid,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:ledger:alice".to_string(),
            signature: "sig".to_string(),
            timestamp: now,
        };

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&identity_entry).expect("serialize entry"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/identity/did%3Aledger%3Aalice")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("resolve response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("resolve payload");
        assert_eq!(payload["did_document"]["did"], "did:ledger:alice");
        assert_eq!(payload["did_document"]["status"], "Active");
    }

    #[tokio::test]
    async fn consent_policy_check_returns_valid_for_live_receipt() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys(&grant_keys).router();
        let now = chrono::Utc::now().timestamp();
        let consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({
                "data_hash":"0xabc",
                "policy_ref":"policy:v1",
                "expires_at": now + 600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:ledger:alice".to_string(),
            signature: "sig".to_string(),
            timestamp: now,
        };

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_entry).expect("serialize entry"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/consent/check")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "subject_did":"did:ledger:alice",
                            "data_hash":"0xabc",
                            "policy_ref":"policy:v1",
                            "granted_at": now,
                            "expires_at": now + 600
                        }))
                        .expect("serialize consent check"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("consent check response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("consent payload");
        assert_eq!(payload["result"]["valid"], true);
        assert!(payload["result"]["reason"].is_null());
    }

    #[tokio::test]
    async fn consent_policy_check_returns_revoked_when_latest_event_revokes() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys(&grant_keys).router();
        let now = chrono::Utc::now().timestamp();
        let granted_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({
                "data_hash":"0xabc",
                "policy_ref":"policy:v1",
                "expires_at": now + 600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:ledger:alice".to_string(),
            signature: "sig".to_string(),
            timestamp: now,
        };
        let revoked_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_REVOKED".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({
                "data_hash":"0xabc",
                "policy_ref":"policy:v1",
                "expires_at": now + 600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:ledger:alice".to_string(),
            signature: "sig".to_string(),
            timestamp: now + 1,
        };

        for entry in [granted_entry, revoked_entry] {
            app.clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/v1/entries/submit")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::to_vec(&entry).expect("serialize entry"),
                        ))
                        .expect("request"),
                )
                .await
                .expect("submit response");
        }

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/consent/check")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "subject_did":"did:ledger:alice",
                            "data_hash":"0xabc",
                            "policy_ref":"policy:v1",
                            "granted_at": now,
                            "expires_at": now + 600
                        }))
                        .expect("serialize consent check"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("consent check response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("consent payload");
        assert_eq!(payload["result"]["valid"], false);
        assert_eq!(payload["result"]["reason"], "consent receipt revoked");
    }

    #[tokio::test]
    async fn builder_credit_endpoint_returns_available_balance_and_instrumentation() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys(&grant_keys).router();
        let now = chrono::Utc::now().timestamp();
        let mut grant_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "builder.credits".to_string(),
            action: "MULTISIG_CREDIT_GRANT".to_string(),
            object_id: "builder:alpha".to_string(),
            payload: json!({"amount": 100_u64}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "governance:ops".to_string(),
            signature: "sig".to_string(),
            timestamp: now,
        };
        attach_multisig_proofs(
            &mut grant_entry,
            &["grant:ops-1", "grant:ops-2", "grant:ops-3"],
            &grant_keys,
        );

        let sponsor_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "builder.credits".to_string(),
            action: "SPONSOR_USAGE".to_string(),
            object_id: "builder:alpha".to_string(),
            payload: json!({"amount": 30_u64, "credit_grant_id": grant_entry.entry_id.to_string(), "sponsorship_id":"spn-1", "sponsored_did":"did:ledger:user1"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "builder:alpha".to_string(),
            signature: "sig".to_string(),
            timestamp: now + 1,
        };

        for entry in [grant_entry, sponsor_entry] {
            let submit_response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/v1/entries/submit")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::to_vec(&entry).expect("serialize entry"),
                        ))
                        .expect("request"),
                )
                .await
                .expect("submit response");
            assert_eq!(submit_response.status(), StatusCode::ACCEPTED);
        }

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/builder-credits/builder:alpha")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("builder credits response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("builder credits payload");
        assert_eq!(payload["credited"], 100);
        assert_eq!(payload["sponsored"], 30);
        assert_eq!(payload["available"], 70);
        assert_eq!(payload["policy"]["namespace_version"], 1);
        assert_eq!(payload["policy"]["rules_hash"], "builder-credits-v1");
        assert_eq!(payload["policy"]["rule"], "builder_credit_policy");
        assert_eq!(payload["policy"]["max_daily_spend"], 10_000);
        assert_eq!(payload["instrumentation"]["unique_sponsorship_count"], 1);
    }

    #[tokio::test]
    async fn asset_positions_endpoint_returns_trustline_holdings_and_disclosure() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys(&grant_keys).router();
        let now = chrono::Utc::now().timestamp();

        let trustline_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "asset.control".to_string(),
            action: "TRUSTLINE_OPEN".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({
                "issuer":"issuer:treasury",
                "asset_code":"CITZ-CRED",
                "max_holding":100_u64,
                "policy_flags":["kyc_required", "clawback_enabled"],
                "disclosure":{"mode":"hashed", "commitment":"0xabc"}
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:ledger:alice".to_string(),
            signature: "sig".to_string(),
            timestamp: now,
        };
        let hold_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "asset.control".to_string(),
            action: "ASSET_HOLD".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({
                "issuer":"issuer:treasury",
                "asset_code":"CITZ-CRED",
                "amount":40_u64,
                "policy_flags":["kyc_required"],
                "disclosure":{"mode":"public"}
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "issuer:treasury".to_string(),
            signature: "sig".to_string(),
            timestamp: now + 1,
        };

        let revoke_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "asset.control".to_string(),
            action: "ASSET_REVOKE".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({
                "issuer":"issuer:treasury",
                "asset_code":"CITZ-CRED",
                "amount":10_u64,
                "policy_flags":["kyc_required", "clawback_enabled"],
                "disclosure":{"mode":"public"}
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "issuer:treasury".to_string(),
            signature: "sig".to_string(),
            timestamp: now + 2,
        };

        for entry in [trustline_entry, hold_entry, revoke_entry] {
            app.clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/v1/entries/submit")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::to_vec(&entry).expect("serialize entry"),
                        ))
                        .expect("request"),
                )
                .await
                .expect("submit response");
        }

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/assets/did:ledger:alice")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("asset positions response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("asset positions payload");
        assert_eq!(payload["positions"][0]["held"], 30);
        assert_eq!(payload["positions"][0]["available_capacity"], 70);
        assert_eq!(
            payload["positions"][0]["trustline"]["policy_flags"][0],
            "kyc_required"
        );
        assert_eq!(payload["positions"][0]["clawback"]["enabled"], true);
        assert_eq!(
            payload["positions"][0]["holder_notice"],
            "Issuer clawback is ENABLED for this trustline. Issuer may revoke held units according to policy."
        );
        assert_eq!(
            payload["positions"][0]["trustline"]["disclosure"]["mode"],
            "hashed"
        );
    }

    #[tokio::test]
    async fn module_runtime_endpoint_reports_registration_and_activation() {
        let app = build_server().router();

        let register = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "execution.module".to_string(),
            action: "REGISTER_MODULE".to_string(),
            object_id: "module.asset.v1".to_string(),
            payload: json!({
                "module_id": "module.asset.v1",
                "module_class": "asset",
                "wasm_hash": "wasm:abc",
                "audit_hash": "audit:abc",
                "wasm_bytes": "AGFzbQ"
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:ledger:maintainer".to_string(),
            signature: "sig".to_string(),
            timestamp: 1_736_500_200,
        };
        let activate = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "execution.module".to_string(),
            action: "ACTIVATE_MODULE".to_string(),
            object_id: "module.asset.v1".to_string(),
            payload: json!({
                "module_id": "module.asset.v1",
                "governance_approvals": 1
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "governance:vote".to_string(),
            signature: "sig".to_string(),
            timestamp: 1_736_500_201,
        };

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&register).expect("register body"),
                    ))
                    .expect("register request"),
            )
            .await
            .expect("register submit response");
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&activate).expect("activate body"),
                    ))
                    .expect("activate request"),
            )
            .await
            .expect("activate submit response");

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/modules/module.asset.v1")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("module query response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("module payload");
        assert_eq!(payload["module_id"], "module.asset.v1");
        assert_eq!(payload["registered"], true);
        assert_eq!(payload["active"], true);
    }

    #[tokio::test]
    async fn interop_endpoint_reports_latest_link_and_proof() {
        let app = build_server().router();

        let link = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "interop.adapter".to_string(),
            action: "LINK_IDENTIFIER".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({
                "standard":"did-core",
                "remote_id":"did:web:example.com:alice"
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:ledger:alice".to_string(),
            signature: "sig".to_string(),
            timestamp: 1_736_500_210,
        };
        let proof = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "interop.adapter".to_string(),
            action: "EMIT_PROOF".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({
                "standard":"did-core",
                "proof_hash":"proof:0xabc"
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:ledger:alice".to_string(),
            signature: "sig".to_string(),
            timestamp: 1_736_500_211,
        };

        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&link).expect("link body")))
                    .expect("link request"),
            )
            .await
            .expect("link submit response");
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&proof).expect("proof body")))
                    .expect("proof request"),
            )
            .await
            .expect("proof submit response");

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/interop/did:ledger:alice")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("interop query response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("interop payload");
        assert_eq!(payload["latest_link"], "did:web:example.com:alice");
        assert_eq!(payload["latest_proof_hash"], "proof:0xabc");
    }

    #[tokio::test]
    async fn envelope_submission_rejects_mismatched_signer_and_author() {
        let app = build_server().router();
        let mut envelope = test_envelope();
        envelope.signer = "did:attacker:z".to_string();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn envelope_submission_accepts_valid_multisig_envelope() {
        let app = build_server().router();
        let envelope = test_multisig_envelope();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        assert_eq!(status, StatusCode::ACCEPTED);
        let payload: Value = serde_json::from_slice(&body).expect("submit payload");
        let outcome = payload["receipt"]["validation"]["outcome"]
            .as_str()
            .expect("outcome");
        assert!(outcome.contains("multisig scope=canonical_payload_v1"));
        assert_eq!(
            payload["receipt"]["validation"]["multisig"]["signature_scope"],
            "canonical_payload_v1"
        );
        assert_eq!(payload["receipt"]["validation"]["multisig"]["threshold"], 2);
        let signers = payload["receipt"]["validation"]["multisig"]["signers"]
            .as_array()
            .expect("multisig signers");
        assert_eq!(signers.len(), 2);
    }

    #[tokio::test]
    async fn envelope_submission_rejects_multisig_threshold_shortfall() {
        let app = build_server().router();
        let mut envelope = test_multisig_envelope();
        envelope
            .multisig_policy
            .as_mut()
            .expect("multisig policy")
            .threshold = 3;

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn envelope_submission_rejects_multisig_scope_mismatch() {
        let app = build_server().router();
        let mut envelope = test_multisig_envelope();
        envelope.signature_scope = Some("canonical_payload_v3".to_string());

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn canonical_preimage_v2_includes_replay_protection_binding() {
        let envelope = test_multisig_envelope_with_scope("canonical_payload_v2");
        let preimage = canonical_envelope_preimage(&envelope.payload, "canonical_payload_v2")
            .expect("canonical preimage");
        assert!(preimage.contains("\"replay_protection\""));
        assert!(preimage.contains("\"request_id\""));
    }

    #[tokio::test]
    async fn envelope_submission_rejects_multisig_scope_v2_without_replay_binding() {
        let app = build_server().router();
        let mut envelope = test_multisig_envelope_with_scope("canonical_payload_v2");
        envelope
            .payload
            .payload
            .as_object_mut()
            .expect("payload object")
            .remove("replay_protection");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn envelope_submission_rejects_duplicate_multisig_signer() {
        let app = build_server().router();
        let mut envelope = test_multisig_envelope();
        envelope.co_signatures[0].signer = envelope.signer.clone();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn unauthenticated_rate_limits_are_not_bypassable_via_forwarded_for_header() {
        let app = build_server_with_edge(ApiEdgeConfig {
            write_enabled: true,
            auth_required: false,
            max_write_requests_per_minute: 1,
            offchain_encrypted_files_v1_enabled: true,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: false,
            clients: BTreeMap::new(),
            ..ApiEdgeConfig::default()
        })
        .router();

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .header("x-forwarded-for", "198.51.100.1")
                    .body(Body::from(
                        serde_json::to_vec(&test_envelope().payload).expect("entry body"),
                    ))
                    .expect("first request"),
            )
            .await
            .expect("first submit");
        assert_eq!(first.status(), StatusCode::ACCEPTED);

        let second = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .header("x-forwarded-for", "203.0.113.2")
                    .body(Body::from(
                        serde_json::to_vec(&test_envelope().payload).expect("entry body"),
                    ))
                    .expect("second request"),
            )
            .await
            .expect("second submit");
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn write_endpoints_require_api_key_when_auth_enabled() {
        let mut clients = BTreeMap::new();
        clients.insert(
            "writer-key".to_string(),
            ApiClientProfile::with_scopes(["entries.submit", "envelopes.submit"]),
        );
        let app = build_server_with_edge(ApiEdgeConfig {
            write_enabled: true,
            auth_required: true,
            max_write_requests_per_minute: 10,
            offchain_encrypted_files_v1_enabled: true,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: false,
            clients,
            ..ApiEdgeConfig::default()
        })
        .router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&test_envelope().payload).expect("entry body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn write_endpoints_require_builder_credit_grant_linkage() {
        let app = build_server_with_edge(ApiEdgeConfig {
            write_enabled: true,
            auth_required: false,
            max_write_requests_per_minute: 10,
            offchain_encrypted_files_v1_enabled: true,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: true,
            clients: BTreeMap::new(),
            ..ApiEdgeConfig::default()
        })
        .router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&test_envelope().payload).expect("entry body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn sponsored_user_write_accepts_builder_grant_linkage() {
        let app = build_server_with_builder_credit_namespace(ApiEdgeConfig {
            write_enabled: true,
            auth_required: false,
            max_write_requests_per_minute: 10,
            offchain_encrypted_files_v1_enabled: true,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: true,
            clients: BTreeMap::new(),
            ..ApiEdgeConfig::default()
        })
        .router();

        let builder_key = ValidatorKeypair::generate("builder:alpha".to_string());
        let mut grant_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "builder.credits".to_string(),
            action: "MULTISIG_CREDIT_GRANT".to_string(),
            object_id: "builder:alpha".to_string(),
            payload: json!({"amount": 100}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "builder:alpha".to_string(),
            signature: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
        };
        sign_entry_for_tests(&mut grant_entry, &builder_key);

        let grant_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&grant_entry).expect("grant entry body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");
        assert_eq!(grant_response.status(), StatusCode::ACCEPTED);

        let user_key = ValidatorKeypair::generate("did:user:1".to_string());
        let mut user_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "audit.procurement".to_string(),
            action: "RECORD_EVENT".to_string(),
            object_id: "PROC-001".to_string(),
            payload: json!({
                "event": "BID_OPENED",
                "credit_grant_id": grant_entry.entry_id.to_string(),
                "sponsor_builder_id": "builder:alpha"
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:user:1".to_string(),
            signature: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
        };
        sign_entry_for_tests(&mut user_entry, &user_key);

        let user_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&user_entry).expect("user entry body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");
        assert_eq!(user_response.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn write_endpoints_enforce_scope_authorization() {
        let mut clients = BTreeMap::new();
        clients.insert(
            "entries-only".to_string(),
            ApiClientProfile::with_scopes(["entries.submit"]),
        );
        let app = build_server_with_edge(ApiEdgeConfig {
            write_enabled: true,
            auth_required: true,
            max_write_requests_per_minute: 10,
            offchain_encrypted_files_v1_enabled: true,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: false,
            clients,
            ..ApiEdgeConfig::default()
        })
        .router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .header("x-api-key", "entries-only")
                    .body(Body::from(
                        serde_json::to_vec(&test_envelope()).expect("envelope body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn write_endpoints_apply_rate_limits() {
        let mut clients = BTreeMap::new();
        clients.insert(
            "writer-key".to_string(),
            ApiClientProfile::with_scopes(["entries.submit", "envelopes.submit"]),
        );
        let app = build_server_with_edge(ApiEdgeConfig {
            write_enabled: true,
            auth_required: true,
            max_write_requests_per_minute: 1,
            offchain_encrypted_files_v1_enabled: true,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: false,
            clients,
            ..ApiEdgeConfig::default()
        })
        .router();

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .header("x-api-key", "writer-key")
                    .body(Body::from(
                        serde_json::to_vec(&test_envelope().payload).expect("entry body"),
                    ))
                    .expect("first request"),
            )
            .await
            .expect("first submit");
        assert_eq!(first.status(), StatusCode::ACCEPTED);

        let second = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .header("x-api-key", "writer-key")
                    .body(Body::from(
                        serde_json::to_vec(&test_envelope().payload).expect("entry body"),
                    ))
                    .expect("second request"),
            )
            .await
            .expect("second submit");
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn write_endpoints_reject_requests_when_writes_disabled() {
        let mut clients = BTreeMap::new();
        clients.insert(
            "writer-key".to_string(),
            ApiClientProfile::with_scopes(["entries.submit", "envelopes.submit"]),
        );
        let server = build_server_with_edge(ApiEdgeConfig {
            write_enabled: false,
            auth_required: true,
            max_write_requests_per_minute: 10,
            offchain_encrypted_files_v1_enabled: true,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: false,
            clients,
            ..ApiEdgeConfig::default()
        });

        let app = server.router();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .header("x-api-key", "writer-key")
                    .body(Body::from(
                        serde_json::to_vec(&test_envelope().payload).expect("entry body"),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let read_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/namespaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read_response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn offchain_endpoints_return_service_unavailable_when_feature_flag_disabled() {
        let app = build_server_with_edge(ApiEdgeConfig {
            write_enabled: true,
            auth_required: false,
            max_write_requests_per_minute: 10,
            offchain_encrypted_files_v1_enabled: false,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: false,
            clients: BTreeMap::new(),
            ..ApiEdgeConfig::default()
        })
        .router();

        let now = Utc::now().timestamp();
        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace":"files.secure",
                            "object_id":"did:citizen:holder-1",
                            "author_did":"did:author:a",
                            "mime_type":"application/pdf",
                            "file_size_bytes":256,
                            "encryption_mode":"passphrase",
                            "consent_receipt":{
                                "subject_did":"did:citizen:holder-1",
                                "data_hash":"sha256:file-disabled",
                                "policy_ref":"policy:offchain:v1",
                                "granted_at":now,
                                "expires_at":now+3600,
                                "authorized_readers":["did:reader:1"]
                            }
                        }))
                        .expect("intent"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");

        assert_eq!(intent_response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let payload: serde_json::Value = serde_json::from_slice(
            &to_bytes(intent_response.into_body(), usize::MAX)
                .await
                .expect("intent body"),
        )
        .expect("parse intent body");
        assert_eq!(
            payload,
            json!({
                "error": "offchain encrypted files feature is disabled",
                "feature_flag": "offchain_encrypted_files_v1"
            })
        );

        let fields_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/api/v1/payloads/fields/{}/files.secure",
                        Uuid::new_v4()
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("fields response");

        assert_eq!(fields_response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn file_intent_precheck_accepts_valid_policy_and_consent() {
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());

        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:payload-001",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };

        let consent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");
        assert_eq!(consent_response.status(), StatusCode::ACCEPTED);

        let intent_request = json!({
            "namespace": "files.secure",
            "object_id": "PROC-001",
            "author_did": "did:author:a",
            "mime_type": "application/pdf",
            "file_size_bytes": 1024,
            "encryption_mode": "hybrid-acl",
            "consent_receipt": {
                "subject_did": "did:citizen:holder-1",
                "data_hash": "sha256:payload-001",
                "policy_ref": "policy:offchain:v1",
                "granted_at": now,
                "expires_at": now + 3_600,
                "authorized_readers": ["did:author:a"]
            }
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&intent_request).expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        assert_eq!(response.status(), StatusCode::CREATED);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("intent body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("intent payload");
        assert_eq!(payload["namespace"], "files.secure");
        assert_eq!(payload["constraints"]["max_file_size_bytes"], 10_485_760);
    }

    #[tokio::test]
    async fn file_commit_enforces_idempotency_and_persists_manifest() {
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());

        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:file-001",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _consent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let intent_request = json!({
            "namespace": "files.secure",
            "object_id": "PROC-001",
            "author_did": "did:author:a",
            "mime_type": "application/pdf",
            "file_size_bytes": 1024,
            "encryption_mode": "hybrid-acl",
            "consent_receipt": {
                "subject_did": "did:citizen:holder-1",
                "data_hash": "sha256:file-001",
                "policy_ref": "policy:offchain:v1",
                "granted_at": now,
                "expires_at": now + 3_600,
                "authorized_readers": ["did:author:a"]
            }
        });

        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&intent_request).expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        assert_eq!(intent_response.status(), StatusCode::CREATED);
        let intent_body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body");
        let intent_payload: Value = serde_json::from_slice(&intent_body).expect("intent payload");
        let intent_id = intent_payload["intent_id"].as_str().expect("intent id");
        let object_ref = intent_payload["upload"]["object_ref"]
            .as_str()
            .expect("object ref");

        let signer = ValidatorKeypair::generate("did:author:a".to_string());
        let mut entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "files.secure".to_string(),
            action: "ENCRYPTED_FILE_UPLOAD".to_string(),
            object_id: "PROC-001".to_string(),
            payload: json!({"manifest_ref":"obj-1"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:a".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut entry, &signer);
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:author:a".to_string(),
            signature: entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: entry,
        };

        let commit_request = json!({
            "intent_id": intent_id,
            "manifest": {
                "schema_version": "1.0.0",
                "namespace": "files.secure",
                "object_id": "PROC-001",
                "author_did": "did:author:a",
                "mime_type": "application/pdf",
                "file_size_bytes": 1024,
                "encryption_mode": "hybrid-acl",
                "file_ref": object_ref,
                "ciphertext_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                "payload_commitment": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                "consent_receipt_ref": "receipt-1",
                "encryption": {"mode": "hybrid-acl"}
            },
            "envelope": envelope
        });

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-commit-1")
                    .body(Body::from(
                        serde_json::to_vec(&commit_request).expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("first commit");
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        let first_body = axum::body::to_bytes(first.into_body(), usize::MAX)
            .await
            .expect("body");

        let second = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-commit-1")
                    .body(Body::from(
                        serde_json::to_vec(&commit_request).expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("second commit");
        assert_eq!(second.status(), StatusCode::OK);
        let second_body = axum::body::to_bytes(second.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(first_body, second_body);

        let mut altered_commit_request = commit_request.clone();
        altered_commit_request["manifest"]["ciphertext_hash"] =
            json!("sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

        let reuse_with_different_payload = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-commit-1")
                    .body(Body::from(
                        serde_json::to_vec(&altered_commit_request).expect("altered commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("reuse with different payload");
        assert_eq!(reuse_with_different_payload.status(), StatusCode::CONFLICT);
        let conflict_body =
            axum::body::to_bytes(reuse_with_different_payload.into_body(), usize::MAX)
                .await
                .expect("conflict body");
        let conflict_payload: Value =
            serde_json::from_slice(&conflict_body).expect("conflict payload");
        assert_eq!(
            conflict_payload["error"],
            "idempotency key reuse with different request payload"
        );

        let third = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-commit-2")
                    .body(Body::from(
                        serde_json::to_vec(&commit_request).expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("third commit");
        assert_eq!(third.status(), StatusCode::CONFLICT);
        let third_body = axum::body::to_bytes(third.into_body(), usize::MAX)
            .await
            .expect("third body");
        let third_payload: Value = serde_json::from_slice(&third_body).expect("third payload");
        assert_eq!(third_payload["error"], "file intent already committed");
        assert_eq!(third_payload["intent_id"], intent_id);
    }

    #[tokio::test]
    async fn file_commit_rejects_manifest_mismatch_with_intent() {
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());

        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:file-002",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };

        let _consent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-002",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 2048,
                            "encryption_mode": "hybrid-acl",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-002",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        assert_eq!(intent_response.status(), StatusCode::CREATED);
        let intent_body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body");
        let intent_payload: Value = serde_json::from_slice(&intent_body).expect("intent payload");
        let intent_id = intent_payload["intent_id"].as_str().expect("intent id");
        let _object_ref = intent_payload["upload"]["object_ref"]
            .as_str()
            .expect("object ref");

        let entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "files.secure".to_string(),
            action: "ENCRYPTED_FILE_UPLOAD".to_string(),
            object_id: "PROC-002".to_string(),
            payload: json!({"manifest_ref":"obj-2"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:a".to_string(),
            signature: "sig-file-2".to_string(),
            timestamp: now,
        };
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:author:a".to_string(),
            signature: "sig-file-2".to_string(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: entry,
        };

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-commit-mismatch")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "intent_id": intent_id,
                            "manifest": {
                                "schema_version": "1.0.0",
                                "namespace": "files.secure",
                                "object_id": "PROC-002",
                                "author_did": "did:author:a",
                                "mime_type": "application/json",
                                "file_size_bytes": 2048,
                                "encryption_mode": "hybrid-acl"
                            },
                            "envelope": envelope
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("file commit response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn payload_commit_rejects_missing_required_fields() {
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());

        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:payload-commit-1",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _consent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "files.secure".to_string(),
            action: "ENCRYPTED_PAYLOAD_FIELD_COMMIT".to_string(),
            object_id: "PROC-001".to_string(),
            payload: json!({"field_refs":1}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:a".to_string(),
            signature: "sig-payload-1".to_string(),
            timestamp: now,
        };
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:author:a".to_string(),
            signature: "sig-payload-1".to_string(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: entry,
        };

        let request = json!({
            "namespace": "files.secure",
            "object_id": "PROC-001",
            "author_did": "did:author:a",
            "consent_receipt": {
                "subject_did": "did:citizen:holder-1",
                "data_hash": "sha256:payload-commit-1",
                "policy_ref": "policy:offchain:v1",
                "granted_at": now,
                "expires_at": now + 3_600,
                "authorized_readers": ["did:author:a"]
            },
            "encrypted_field_refs": [
                {
                    "field_path": "payload.ssn",
                    "blob_ref": "blob://a",
                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                }
            ],
            "envelope": envelope
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-commit-1")
                    .body(Body::from(
                        serde_json::to_vec(&request).expect("request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("payload commit response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn payload_commit_rejects_plaintext_required_encrypted_fields() {
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();

        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:payload-commit-2",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "files.secure".to_string(),
            action: "ENCRYPTED_PAYLOAD_FIELD_COMMIT".to_string(),
            object_id: "PROC-002".to_string(),
            payload: json!({"payload": {"ssn": "123-45-6789"}, "field_refs":1}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:a".to_string(),
            signature: "sig-payload-2".to_string(),
            timestamp: now,
        };
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:author:a".to_string(),
            signature: "sig-payload-2".to_string(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: entry,
        };

        let request = json!({
            "namespace": "files.secure",
            "object_id": "PROC-002",
            "author_did": "did:author:a",
            "consent_receipt": {
                "subject_did": "did:citizen:holder-1",
                "data_hash": "sha256:payload-commit-2",
                "policy_ref": "policy:offchain:v1",
                "granted_at": now,
                "expires_at": now + 3_600,
                "authorized_readers": ["did:author:a"]
            },
            "encrypted_field_refs": [
                {
                    "field_path": "payload.ssn",
                    "blob_ref": "blob://a",
                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                },
                {
                    "field_path": "payload.medical_record",
                    "blob_ref": "blob://b",
                    "ciphertext_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                    "payload_commitment": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                }
            ],
            "envelope": envelope
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-commit-2")
                    .body(Body::from(
                        serde_json::to_vec(&request).expect("request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("payload commit response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("json body");
        assert_eq!(
            payload["error"],
            "required encrypted fields must not appear in plaintext payload"
        );
        assert_eq!(payload["plaintext_fields"], json!(["payload.ssn"]));
    }

    #[tokio::test]
    async fn payload_commit_rejects_unexpected_field_refs_not_allowed_by_policy() {
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();

        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:payload-policy-subset-1",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "files.secure".to_string(),
            action: "ENCRYPTED_PAYLOAD_FIELD_COMMIT".to_string(),
            object_id: "PROC-002-extra".to_string(),
            payload: json!({"field_refs": "subset-check"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:a".to_string(),
            signature: "sig-payload-extra".to_string(),
            timestamp: now,
        };
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:author:a".to_string(),
            signature: "sig-payload-extra".to_string(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: entry,
        };

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-policy-subset-1")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-002-extra",
                            "author_did": "did:author:a",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:payload-policy-subset-1",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            },
                            "encrypted_field_refs": [
                                {
                                    "field_path": "payload.ssn",
                                    "blob_ref": "blob://local/files.secure/PROC-002-extra/ssn.cipher",
                                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                },
                                {
                                    "field_path": "payload.medical_record",
                                    "blob_ref": "blob://local/files.secure/PROC-002-extra/med.cipher",
                                    "ciphertext_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                                    "payload_commitment": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                                },
                                {
                                    "field_path": "payload.tax_id",
                                    "blob_ref": "blob://local/files.secure/PROC-002-extra/tax.cipher",
                                    "ciphertext_hash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                                    "payload_commitment": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                                }
                            ],
                            "envelope": envelope
                        }))
                        .expect("payload request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("payload response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: Value = serde_json::from_slice(&body).expect("json body");
        assert_eq!(
            payload["error"],
            "encrypted field references include paths not allowed by namespace policy"
        );
        assert_eq!(payload["unexpected_fields"], json!(["payload.tax_id"]));
    }

    #[tokio::test]
    async fn files_intent_issues_minio_upload_refs_when_store_configured() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_policy_and_minio(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD", "ENCRYPTED_PAYLOAD_FIELD_COMMIT"],
            None,
            None,
            MinioOffchainObjectStoreConfig {
                endpoint: "minio.internal:9000".to_string(),
                bucket: "citizen-offchain".to_string(),
                access_key: std::env::var("CITIZEN_TEST_MINIO_ACCESS_KEY")
                    .unwrap_or_else(|_| "test-fixture-access".to_string()),
                secret_key: std::env::var("CITIZEN_TEST_MINIO_SECRET_KEY")
                    .unwrap_or_else(|_| "test-fixture-secret".to_string()),
                use_tls: true,
                path_style: true,
                key_prefix: "citizen/offchain/v1".to_string(),
            },
        )
        .router();

        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:minio-intent",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "did:citizen:holder-1",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 1024,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:minio-intent",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3600,
                                "authorized_readers": ["did:author:a"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");

        assert_eq!(response.status(), StatusCode::CREATED);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: Value = serde_json::from_slice(&body).expect("json body");
        let object_ref = payload["upload"]["object_ref"]
            .as_str()
            .expect("object_ref");
        let upload_url = payload["upload"]["upload_url"]
            .as_str()
            .expect("upload_url");

        assert!(
            object_ref.starts_with("s3://citizen-offchain/citizen/offchain/v1/files.secure/"),
            "unexpected object_ref: {object_ref}"
        );
        assert!(
            upload_url.starts_with(
                "https://minio.internal:9000/citizen-offchain/citizen/offchain/v1/files.secure/"
            ),
            "unexpected upload_url: {upload_url}"
        );
    }

    #[tokio::test]
    async fn file_commit_rejects_manifest_ref_outside_minio_namespace_prefix() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_policy_and_minio(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD", "ENCRYPTED_PAYLOAD_FIELD_COMMIT"],
            None,
            None,
            MinioOffchainObjectStoreConfig {
                endpoint: "minio.internal:9000".to_string(),
                bucket: "citizen-offchain".to_string(),
                access_key: std::env::var("CITIZEN_TEST_MINIO_ACCESS_KEY")
                    .unwrap_or_else(|_| "test-fixture-access".to_string()),
                secret_key: std::env::var("CITIZEN_TEST_MINIO_SECRET_KEY")
                    .unwrap_or_else(|_| "test-fixture-secret".to_string()),
                use_tls: true,
                path_style: true,
                key_prefix: "citizen/offchain/v1".to_string(),
            },
        )
        .router();

        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:minio-ref-policy",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");
        let intent_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/intents").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"namespace":"files.secure","object_id":"did:citizen:holder-1","author_did":"did:author:a","mime_type":"application/pdf","file_size_bytes":256,"encryption_mode":"passphrase","consent_receipt":{"subject_did":"did:citizen:holder-1","data_hash":"sha256:minio-ref-policy","policy_ref":"policy:offchain:v1","granted_at":now,"expires_at":now+3600,"authorized_readers":["did:author:a"]}})).expect("intent"))).expect("request")).await.expect("intent response");
        assert_eq!(intent_response.status(), StatusCode::CREATED);
        let intent_body = to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body");
        let intent_payload: Value = serde_json::from_slice(&intent_body).expect("intent payload");

        let commit_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "minio-file-commit-invalid-ref")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "intent_id": intent_payload["intent_id"],
                            "manifest": {
                                "namespace": "files.secure",
                                "object_id": "did:citizen:holder-1",
                                "author_did": "did:author:a",
                                "mime_type": "application/pdf",
                                "file_size_bytes": 256,
                                "encryption_mode": "passphrase",
                                "file_ref": "s3://citizen-offchain/citizen/offchain/v1/other.namespace/object.cipher",
                                "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                "consent_receipt_ref": "consent:receipt:minio-ref-policy"
                            },
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-minio-ref-policy",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_FILE_UPLOAD",
                                    "object_id": "did:citizen:holder-1",
                                    "payload": {"manifest_id": "manifest-minio-ref-policy"},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-minio-ref-policy",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit response");

        assert_eq!(commit_response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: Value = serde_json::from_slice(&body).expect("json body");
        assert_eq!(
            payload["error"],
            "manifest file_ref does not match issued upload intent object_ref"
        );
    }

    #[tokio::test]
    async fn payload_commit_accepts_minio_blob_refs_with_namespace_prefix() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_policy_and_minio(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD", "ENCRYPTED_PAYLOAD_FIELD_COMMIT"],
            None,
            None,
            MinioOffchainObjectStoreConfig {
                endpoint: "minio.internal:9000".to_string(),
                bucket: "citizen-offchain".to_string(),
                access_key: std::env::var("CITIZEN_TEST_MINIO_ACCESS_KEY")
                    .unwrap_or_else(|_| "test-fixture-access".to_string()),
                secret_key: std::env::var("CITIZEN_TEST_MINIO_SECRET_KEY")
                    .unwrap_or_else(|_| "test-fixture-secret".to_string()),
                use_tls: true,
                path_style: true,
                key_prefix: "citizen/offchain/v1".to_string(),
            },
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:minio-payload-commit-1",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let entry_id = Uuid::new_v4();
        let ssn_commitment = ApiServer::<MemoryStorage>::compute_payload_field_commitment(
            "files.secure",
            &entry_id.to_string(),
            1,
            "payload.ssn",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        let medical_commitment = ApiServer::<MemoryStorage>::compute_payload_field_commitment(
            "files.secure",
            &entry_id.to_string(),
            1,
            "payload.medical_record",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "minio-payload-commit-1")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-MINIO-001",
                            "author_did": "did:author:a",
                            "policy_version": 1,
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:minio-payload-commit-1",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            },
                            "encrypted_field_refs": [
                                {
                                    "field_path": "payload.ssn",
                                    "blob_ref": "s3://citizen-offchain/citizen/offchain/v1/files.secure/PROC-MINIO-001/ssn.cipher",
                                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "payload_commitment": ssn_commitment
                                },
                                {
                                    "field_path": "payload.medical_record",
                                    "blob_ref": "s3://citizen-offchain/citizen/offchain/v1/files.secure/PROC-MINIO-001/medical.cipher",
                                    "ciphertext_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                    "payload_commitment": medical_commitment
                                }
                            ],
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-minio-payload-commit-1",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": entry_id,
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_PAYLOAD_FIELD_COMMIT",
                                    "object_id": "PROC-MINIO-001",
                                    "payload": {"field_refs": 2},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-minio-payload-commit-1",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("payload commit response");

        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn payload_commit_rejects_blob_refs_outside_storage_policy() {
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();

        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:payload-blob-policy-1",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "files.secure".to_string(),
            action: "ENCRYPTED_PAYLOAD_FIELD_COMMIT".to_string(),
            object_id: "PROC-003".to_string(),
            payload: json!({"field_refs": 2}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:a".to_string(),
            signature: "sig-payload-3".to_string(),
            timestamp: now,
        };
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:author:a".to_string(),
            signature: "sig-payload-3".to_string(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: entry,
        };

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-blob-policy-1")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-003",
                            "author_did": "did:author:a",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:payload-blob-policy-1",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            },
                            "encrypted_field_refs": [
                                {
                                    "field_path": "payload.ssn",
                                    "blob_ref": "blob://remote/files.secure/PROC-003/ssn.cipher",
                                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                },
                                {
                                    "field_path": "payload.medical_record",
                                    "blob_ref": "blob://local/files.secure/PROC-003/med.cipher",
                                    "ciphertext_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                                    "payload_commitment": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                                }
                            ],
                            "envelope": envelope
                        }))
                        .expect("payload request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("payload commit response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("json body");
        assert_eq!(
            payload["error"],
            "encrypted field blob_ref is not accepted by storage policy"
        );
        assert_eq!(payload["invalid_blob_refs"][0]["field_path"], "payload.ssn");
        assert_eq!(
            payload["invalid_blob_refs"][0]["reason"],
            "manifest file_ref is not accepted by local storage policy"
        );
    }

    #[tokio::test]
    async fn file_commit_rejects_action_not_allowed_by_namespace_policy() {
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();

        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:file-action-check",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-ACT-1",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 256,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-action-check",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        assert_eq!(intent_response.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("intent payload");

        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:author:a".to_string(),
            signature: "sig-invalid-action".to_string(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: LedgerEntry {
                entry_id: Uuid::new_v4(),
                namespace: "files.secure".to_string(),
                action: "ENCRYPTED_FILE_SHARE".to_string(),
                object_id: "PROC-ACT-1".to_string(),
                payload: json!({"manifest_id": "manifest-1"}),
                privacy_flag: false,
                privacy_mode: citizen_types::PrivacyMode::None,
                payload_commitment: None,
                ciphertext_hex: None,
                nonce_hex: None,
                salt_hex: None,
                kdf_params: None,
                consent_receipt: None,
                authorized_readers: vec![],
                custodian_policy_id: None,
                field_reader_acls: BTreeMap::new(),
                key_wrapped_secrets: vec![],
                revocation_events: vec![],
                author: "did:author:a".to_string(),
                signature: "sig-invalid-action".to_string(),
                timestamp: now,
            },
        };

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-action-check")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "intent_id": payload["intent_id"],
                            "manifest": {
                                "namespace": "files.secure",
                                "object_id": "PROC-ACT-1",
                                "author_did": "did:author:a",
                                "mime_type": "application/pdf",
                                "file_size_bytes": 256,
                                "encryption_mode": "passphrase",
                                "file_ref": payload["upload"]["object_ref"],
                                "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                "consent_receipt_ref": "consent:receipt:file-action-check"
                            },
                            "envelope": envelope
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("response payload");
        assert_eq!(
            payload["error"],
            "file commit envelope action is not allowed by namespace policy"
        );
        assert_eq!(payload["allowed_actions"], json!(["ENCRYPTED_FILE_UPLOAD"]));
    }

    #[tokio::test]
    async fn file_commit_allows_governance_enabled_share_action() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &[
                "ENCRYPTED_FILE_UPLOAD",
                "ENCRYPTED_FILE_SHARE",
                "ENCRYPTED_FILE_REVOKE",
            ],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:file-share-ok",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        consent_entry.signature = "sig-consent-share".to_string();

        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:citizen:holder-1".to_string(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-ACT-2",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 256,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-share-ok",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        assert_eq!(intent_response.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("intent payload");

        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:author:a".to_string(),
            signature: "sig-share-allowed".to_string(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: LedgerEntry {
                entry_id: Uuid::new_v4(),
                namespace: "files.secure".to_string(),
                action: "ENCRYPTED_FILE_SHARE".to_string(),
                object_id: "PROC-ACT-2".to_string(),
                payload: json!({"manifest_id": "manifest-2"}),
                privacy_flag: false,
                privacy_mode: citizen_types::PrivacyMode::None,
                payload_commitment: None,
                ciphertext_hex: None,
                nonce_hex: None,
                salt_hex: None,
                kdf_params: None,
                consent_receipt: None,
                authorized_readers: vec![],
                custodian_policy_id: None,
                field_reader_acls: BTreeMap::new(),
                key_wrapped_secrets: vec![],
                revocation_events: vec![],
                author: "did:author:a".to_string(),
                signature: "sig-share-allowed".to_string(),
                timestamp: now,
            },
        };

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-share-ok")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "intent_id": payload["intent_id"],
                            "manifest": {
                                "namespace": "files.secure",
                                "object_id": "PROC-ACT-2",
                                "author_did": "did:author:a",
                                "mime_type": "application/pdf",
                                "file_size_bytes": 256,
                                "encryption_mode": "passphrase",
                                "file_ref": payload["upload"]["object_ref"],
                                "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                "consent_receipt_ref": "consent:receipt:file-share-ok"
                            },
                            "envelope": envelope
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit response");

        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn file_read_allows_active_granted_reader() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &[
                "ENCRYPTED_FILE_UPLOAD",
                "ENCRYPTED_FILE_SHARE",
                "ENCRYPTED_FILE_REVOKE",
            ],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let consent_entry = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:citizen:holder-1".to_string(),
            signature: "sig-consent-read-ok".to_string(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: LedgerEntry {
                entry_id: Uuid::new_v4(),
                namespace: "consent.receipt".to_string(),
                action: "CONSENT_GRANTED".to_string(),
                object_id: "did:citizen:holder-1".to_string(),
                payload: json!({
                    "data_hash": "sha256:file-read-ok",
                    "policy_ref": "policy:offchain:v1",
                    "expires_at": now + 3_600
                }),
                privacy_flag: false,
                privacy_mode: citizen_types::PrivacyMode::None,
                payload_commitment: None,
                ciphertext_hex: None,
                nonce_hex: None,
                salt_hex: None,
                kdf_params: None,
                consent_receipt: None,
                authorized_readers: vec![],
                custodian_policy_id: None,
                field_reader_acls: BTreeMap::new(),
                key_wrapped_secrets: vec![],
                revocation_events: vec![],
                author: "did:citizen:holder-1".to_string(),
                signature: "sig-consent-read-ok".to_string(),
                timestamp: now,
            },
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_entry).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "did:citizen:holder-1",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 256,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-read-ok",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        let body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("intent payload");

        let commit_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-read-ok-commit")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "intent_id": payload["intent_id"],
                            "manifest": {
                                "namespace": "files.secure",
                                "object_id": "did:citizen:holder-1",
                                "author_did": "did:author:a",
                                "mime_type": "application/pdf",
                                "file_size_bytes": 256,
                                "encryption_mode": "passphrase",
                                "file_ref": payload["upload"]["object_ref"],
                                "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                "consent_receipt_ref": "consent:receipt:file-read-ok"
                            },
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-file-read-ok",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_FILE_UPLOAD",
                                    "object_id": "did:citizen:holder-1",
                                    "payload": {"manifest_id": "manifest-read-ok"},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-file-read-ok",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit response");
        assert_eq!(commit_response.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .expect("commit body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("commit payload");

        let read_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/read")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "manifest_id": payload["manifest_id"],
                            "reader_did": "did:reader:1",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-read-ok",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("read body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("read response");

        assert_eq!(read_response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn file_read_rejects_ciphertext_hash_mismatch() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &[
                "ENCRYPTED_FILE_UPLOAD",
                "ENCRYPTED_FILE_SHARE",
                "ENCRYPTED_FILE_REVOKE",
            ],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "envelope_id": Uuid::new_v4(),
                            "signer": "did:citizen:holder-1",
                            "signature": "sig-consent-hash-mismatch",
                            "submitted_at": chrono::Utc::now(),
                            "payload": {
                                "entry_id": Uuid::new_v4(),
                                "namespace": "consent.receipt",
                                "action": "CONSENT_GRANTED",
                                "object_id": "did:citizen:holder-1",
                                "payload": {
                                    "data_hash": "sha256:file-hash-mismatch",
                                    "policy_ref": "policy:offchain:v1",
                                    "expires_at": now + 3_600
                                },
                                "privacy_flag": false,
                                "privacy_mode": "none",
                                "payload_commitment": null,
                                "ciphertext_hex": null,
                                "nonce_hex": null,
                                "salt_hex": null,
                                "kdf_params": null,
                                "consent_receipt": null,
                                "authorized_readers": [],
                                "custodian_policy_id": null,
                                "field_reader_acls": {},
                                "key_wrapped_secrets": [],
                                "revocation_events": [],
                                "author": "did:citizen:holder-1",
                                "signature": "sig-consent-hash-mismatch",
                                "timestamp": now
                            }
                        }))
                        .expect("consent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("consent response");

        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "did:citizen:holder-1",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 256,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-hash-mismatch",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        let body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("intent payload");

        let commit_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-read-hash-mismatch-commit")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "intent_id": payload["intent_id"],
                            "manifest": {
                                "namespace": "files.secure",
                                "object_id": "did:citizen:holder-1",
                                "author_did": "did:author:a",
                                "mime_type": "application/pdf",
                                "file_size_bytes": 256,
                                "encryption_mode": "passphrase",
                                "file_ref": payload["upload"]["object_ref"],
                                "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                "consent_receipt_ref": "consent:receipt:file-hash-mismatch"
                            },
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-file-hash-mismatch",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_FILE_UPLOAD",
                                    "object_id": "did:citizen:holder-1",
                                    "payload": {"manifest_id": "manifest-hash-mismatch"},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-file-hash-mismatch",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit response");
        assert_eq!(commit_response.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .expect("commit body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("commit payload");

        let read_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/read")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "manifest_id": payload["manifest_id"],
                            "reader_did": "did:reader:1",
                            "observed_ciphertext_hash": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-hash-mismatch",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("read body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("read response");

        assert_eq!(read_response.status(), StatusCode::CONFLICT);

        let alerts_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/files/alerts")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("alerts response");
        assert_eq!(alerts_response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(alerts_response.into_body(), usize::MAX)
            .await
            .expect("alerts body bytes");
        let alerts_payload: Value = serde_json::from_slice(&body).expect("alerts payload");
        assert_eq!(alerts_payload["alerts"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            alerts_payload["alerts"][0]["alert_type"],
            json!("commitment_mismatch")
        );
    }

    #[tokio::test]
    async fn file_revoke_endpoint_blocks_reader_and_updates_manifest_metadata() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &[
                "ENCRYPTED_FILE_UPLOAD",
                "ENCRYPTED_FILE_SHARE",
                "ENCRYPTED_FILE_REVOKE",
            ],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "envelope_id": Uuid::new_v4(),
                            "signer": "did:citizen:holder-1",
                            "signature": "sig-consent-revoke-path",
                            "submitted_at": chrono::Utc::now(),
                            "payload": {
                                "entry_id": Uuid::new_v4(),
                                "namespace": "consent.receipt",
                                "action": "CONSENT_GRANTED",
                                "object_id": "did:citizen:holder-1",
                                "payload": {
                                    "data_hash": "sha256:file-revoke-path",
                                    "policy_ref": "policy:offchain:v1",
                                    "expires_at": now + 3_600
                                },
                                "privacy_flag": false,
                                "privacy_mode": "none",
                                "payload_commitment": null,
                                "ciphertext_hex": null,
                                "nonce_hex": null,
                                "salt_hex": null,
                                "kdf_params": null,
                                "consent_receipt": null,
                                "authorized_readers": [],
                                "custodian_policy_id": null,
                                "field_reader_acls": {},
                                "key_wrapped_secrets": [],
                                "revocation_events": [],
                                "author": "did:citizen:holder-1",
                                "signature": "sig-consent-revoke-path",
                                "timestamp": now
                            }
                        }))
                        .expect("consent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("consent response");

        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "did:citizen:holder-1",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 256,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-revoke-path",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        let body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body bytes");
        let intent_payload: Value = serde_json::from_slice(&body).expect("intent payload");

        let commit_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-revoke-path-commit")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "intent_id": intent_payload["intent_id"],
                            "manifest": {
                                "namespace": "files.secure",
                                "object_id": "did:citizen:holder-1",
                                "author_did": "did:author:a",
                                "mime_type": "application/pdf",
                                "file_size_bytes": 256,
                                "encryption_mode": "passphrase",
                                "file_ref": intent_payload["upload"]["object_ref"],
                                "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                "consent_receipt_ref": "consent:receipt:file-revoke-path"
                            },
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-file-revoke-path",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_FILE_UPLOAD",
                                    "object_id": "did:citizen:holder-1",
                                    "payload": {"manifest_id": "manifest-revoke-path"},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-file-revoke-path",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit response");
        assert_eq!(commit_response.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .expect("commit body bytes");
        let commit_payload: Value = serde_json::from_slice(&body).expect("commit payload");

        let revoke_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/revoke")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "manifest_id": commit_payload["manifest_id"],
                            "reader_did": "did:reader:1",
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-file-revoke-reader",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_FILE_REVOKE",
                                    "object_id": "did:citizen:holder-1",
                                    "payload": {
                                        "manifest_id": commit_payload["manifest_id"],
                                        "reader_did": "did:reader:1"
                                    },
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-file-revoke-reader",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("revoke body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("revoke response");
        assert_eq!(revoke_response.status(), StatusCode::ACCEPTED);

        let read_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/read")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "manifest_id": commit_payload["manifest_id"],
                            "reader_did": "did:reader:1",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-revoke-path",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("read body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("read response");
        assert_eq!(read_response.status(), StatusCode::FORBIDDEN);

        let metadata_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/api/v1/files/manifests/{}",
                        commit_payload["manifest_id"].as_str().expect("manifest_id")
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("manifest metadata response");
        assert_eq!(metadata_response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(metadata_response.into_body(), usize::MAX)
            .await
            .expect("metadata body bytes");
        let metadata: Value = serde_json::from_slice(&body).expect("metadata payload");
        assert_eq!(metadata["revoked_readers"][0], json!("did:reader:1"));
    }

    #[tokio::test]
    async fn file_read_rejects_reader_not_in_authorized_list() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &[
                "ENCRYPTED_FILE_UPLOAD",
                "ENCRYPTED_FILE_SHARE",
                "ENCRYPTED_FILE_REVOKE",
            ],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "envelope_id": Uuid::new_v4(),
                            "signer": "did:citizen:holder-1",
                            "signature": "sig-consent-reader-denied",
                            "submitted_at": chrono::Utc::now(),
                            "payload": {
                                "entry_id": Uuid::new_v4(),
                                "namespace": "consent.receipt",
                                "action": "CONSENT_GRANTED",
                                "object_id": "did:citizen:holder-1",
                                "payload": {
                                    "data_hash": "sha256:file-reader-denied",
                                    "policy_ref": "policy:offchain:v1",
                                    "expires_at": now + 3_600
                                },
                                "privacy_flag": false,
                                "privacy_mode": "none",
                                "payload_commitment": null,
                                "ciphertext_hex": null,
                                "nonce_hex": null,
                                "salt_hex": null,
                                "kdf_params": null,
                                "consent_receipt": null,
                                "authorized_readers": [],
                                "custodian_policy_id": null,
                                "field_reader_acls": {},
                                "key_wrapped_secrets": [],
                                "revocation_events": [],
                                "author": "did:citizen:holder-1",
                                "signature": "sig-consent-reader-denied",
                                "timestamp": now
                            }
                        }))
                        .expect("consent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "did:citizen:holder-1",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 256,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-reader-denied",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        let body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("intent payload");

        let commit_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-reader-denied-commit")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "intent_id": payload["intent_id"],
                            "manifest": {
                                "namespace": "files.secure",
                                "object_id": "did:citizen:holder-1",
                                "author_did": "did:author:a",
                                "mime_type": "application/pdf",
                                "file_size_bytes": 256,
                                "encryption_mode": "passphrase",
                                "file_ref": payload["upload"]["object_ref"],
                                "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                "consent_receipt_ref": "consent:receipt:file-reader-denied"
                            },
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-file-reader-denied",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_FILE_UPLOAD",
                                    "object_id": "did:citizen:holder-1",
                                    "payload": {"manifest_id": "manifest-reader-denied"},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-file-reader-denied",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit response");
        assert_eq!(commit_response.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .expect("commit body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("commit payload");

        let read_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/read")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "manifest_id": payload["manifest_id"],
                            "reader_did": "did:reader:2",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-reader-denied",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("read body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("read response");

        assert_eq!(read_response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn file_read_rejects_expired_consent_receipt() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &[
                "ENCRYPTED_FILE_UPLOAD",
                "ENCRYPTED_FILE_SHARE",
                "ENCRYPTED_FILE_REVOKE",
            ],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "envelope_id": Uuid::new_v4(),
                            "signer": "did:citizen:holder-1",
                            "signature": "sig-consent-expired",
                            "submitted_at": chrono::Utc::now(),
                            "payload": {
                                "entry_id": Uuid::new_v4(),
                                "namespace": "consent.receipt",
                                "action": "CONSENT_GRANTED",
                                "object_id": "did:citizen:holder-1",
                                "payload": {
                                    "data_hash": "sha256:file-expired",
                                    "policy_ref": "policy:offchain:v1",
                                    "expires_at": now + 3_600
                                },
                                "privacy_flag": false,
                                "privacy_mode": "none",
                                "payload_commitment": null,
                                "ciphertext_hex": null,
                                "nonce_hex": null,
                                "salt_hex": null,
                                "kdf_params": null,
                                "consent_receipt": null,
                                "authorized_readers": [],
                                "custodian_policy_id": null,
                                "field_reader_acls": {},
                                "key_wrapped_secrets": [],
                                "revocation_events": [],
                                "author": "did:citizen:holder-1",
                                "signature": "sig-consent-expired",
                                "timestamp": now
                            }
                        }))
                        .expect("consent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let intent_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "did:citizen:holder-1",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 256,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-expired",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");
        let body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("intent payload");

        let commit_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "file-expired-commit")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "intent_id": payload["intent_id"],
                            "manifest": {
                                "namespace": "files.secure",
                                "object_id": "did:citizen:holder-1",
                                "author_did": "did:author:a",
                                "mime_type": "application/pdf",
                                "file_size_bytes": 256,
                                "encryption_mode": "passphrase",
                                "file_ref": payload["upload"]["object_ref"],
                                "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                "consent_receipt_ref": "consent:receipt:file-expired"
                            },
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-file-expired",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_FILE_UPLOAD",
                                    "object_id": "did:citizen:holder-1",
                                    "payload": {"manifest_id": "manifest-expired"},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-file-expired",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit response");
        assert_eq!(commit_response.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .expect("commit body bytes");
        let payload: Value = serde_json::from_slice(&body).expect("commit payload");

        let read_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/read")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "manifest_id": payload["manifest_id"],
                            "reader_did": "did:reader:1",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:file-expired",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now - 7_200,
                                "expires_at": now - 3_600,
                                "authorized_readers": ["did:reader:1"]
                            }
                        }))
                        .expect("read body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("read response");

        assert_eq!(read_response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn file_read_rejects_reader_after_revocation_event() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &[
                "ENCRYPTED_FILE_UPLOAD",
                "ENCRYPTED_FILE_SHARE",
                "ENCRYPTED_FILE_REVOKE",
            ],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        // Reuse happy-path creation, then append revoke envelope and assert read is blocked.
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "envelope_id": Uuid::new_v4(),
                            "signer": "did:citizen:holder-1",
                            "signature": "sig-consent-revoke-read",
                            "submitted_at": chrono::Utc::now(),
                            "payload": {
                                "entry_id": Uuid::new_v4(),
                                "namespace": "consent.receipt",
                                "action": "CONSENT_GRANTED",
                                "object_id": "did:citizen:holder-1",
                                "payload": {"data_hash": "sha256:file-revoke-read", "policy_ref": "policy:offchain:v1", "expires_at": now + 3600},
                                "privacy_flag": false,
                                "privacy_mode": "none",
                                "payload_commitment": null,
                                "ciphertext_hex": null,
                                "nonce_hex": null,
                                "salt_hex": null,
                                "kdf_params": null,
                                "consent_receipt": null,
                                "authorized_readers": [],
                                "custodian_policy_id": null,
                                "field_reader_acls": {},
                                "key_wrapped_secrets": [],
                                "revocation_events": [],
                                "author": "did:citizen:holder-1",
                                "signature": "sig-consent-revoke-read",
                                "timestamp": now
                            }
                        }))
                        .expect("consent"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let intent_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/intents").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"namespace":"files.secure","object_id":"did:citizen:holder-1","author_did":"did:author:a","mime_type":"application/pdf","file_size_bytes":256,"encryption_mode":"passphrase","consent_receipt":{"subject_did":"did:citizen:holder-1","data_hash":"sha256:file-revoke-read","policy_ref":"policy:offchain:v1","granted_at":now,"expires_at":now+3600,"authorized_readers":["did:reader:1"]}})).expect("intent"))).expect("request")).await.expect("intent response");
        let body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent bytes");
        let intent_payload: Value = serde_json::from_slice(&body).expect("intent payload");

        let commit_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/commit").header("content-type", "application/json").header("idempotency-key", "file-revoke-read-commit").body(Body::from(serde_json::to_vec(&json!({"intent_id": intent_payload["intent_id"],"manifest":{"namespace":"files.secure","object_id":"did:citizen:holder-1","author_did":"did:author:a","mime_type":"application/pdf","file_size_bytes":256,"encryption_mode":"passphrase","file_ref":intent_payload["upload"]["object_ref"],"ciphertext_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payload_commitment":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","consent_receipt_ref":"consent:receipt:file-revoke-read"},"envelope":{"envelope_id":Uuid::new_v4(),"signer":"did:author:a","signature":"sig-file-revoke-read","submitted_at":chrono::Utc::now(),"payload":{"entry_id":Uuid::new_v4(),"namespace":"files.secure","action":"ENCRYPTED_FILE_UPLOAD","object_id":"did:citizen:holder-1","payload":{"manifest_id":"manifest-revoke-read"},"privacy_flag":false,"privacy_mode":"none","payload_commitment":null,"ciphertext_hex":null,"nonce_hex":null,"salt_hex":null,"kdf_params":null,"consent_receipt":null,"authorized_readers":[],"custodian_policy_id":null,"field_reader_acls":{},"key_wrapped_secrets":[],"revocation_events":[],"author":"did:author:a","signature":"sig-file-revoke-read","timestamp":now}}})).expect("commit"))).expect("request")).await.expect("commit response");
        let body = axum::body::to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .expect("commit bytes");
        let commit_payload: Value = serde_json::from_slice(&body).expect("commit payload");

        let revoke_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/envelopes/submit").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"envelope_id":Uuid::new_v4(),"signer":"did:author:a","signature":"sig-revoke-read","submitted_at":chrono::Utc::now(),"payload":{"entry_id":Uuid::new_v4(),"namespace":"files.secure","action":"ENCRYPTED_FILE_REVOKE","object_id":"did:citizen:holder-1","payload":{"manifest_id":commit_payload["manifest_id"],"reader_did":"did:reader:1","reason":"manual revocation"},"privacy_flag":false,"privacy_mode":"none","payload_commitment":null,"ciphertext_hex":null,"nonce_hex":null,"salt_hex":null,"kdf_params":null,"consent_receipt":null,"authorized_readers":[],"custodian_policy_id":null,"field_reader_acls":{},"key_wrapped_secrets":[],"revocation_events":[],"author":"did:author:a","signature":"sig-revoke-read","timestamp":now}})).expect("revoke"))).expect("request")).await.expect("revoke response");
        assert_eq!(revoke_response.status(), StatusCode::ACCEPTED);

        let read_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/read").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"manifest_id":commit_payload["manifest_id"],"reader_did":"did:reader:1","consent_receipt":{"subject_did":"did:citizen:holder-1","data_hash":"sha256:file-revoke-read","policy_ref":"policy:offchain:v1","granted_at":now,"expires_at":now+3600,"authorized_readers":["did:reader:1"]}})).expect("read"))).expect("request")).await.expect("read response");
        assert_eq!(read_response.status(), StatusCode::FORBIDDEN);

        let alerts_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/files/alerts")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("alerts response");
        assert_eq!(alerts_response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(alerts_response.into_body(), usize::MAX)
            .await
            .expect("alerts body bytes");
        let alerts_payload: Value = serde_json::from_slice(&body).expect("alerts payload");
        assert_eq!(alerts_payload["alerts"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            alerts_payload["alerts"][0]["alert_type"],
            json!("revocation_conflict")
        );
    }

    #[tokio::test]
    async fn file_manifest_metadata_returns_consent_and_revocation_status() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &[
                "ENCRYPTED_FILE_UPLOAD",
                "ENCRYPTED_FILE_SHARE",
                "ENCRYPTED_FILE_REVOKE",
            ],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let _ = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/envelopes/submit").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"envelope_id":Uuid::new_v4(),"signer":"did:citizen:holder-1","signature":"sig-consent-manifest-meta","submitted_at":chrono::Utc::now(),"payload":{"entry_id":Uuid::new_v4(),"namespace":"consent.receipt","action":"CONSENT_GRANTED","object_id":"did:citizen:holder-1","payload":{"data_hash":"sha256:file-manifest-meta","policy_ref":"policy:offchain:v1","expires_at":now+3600},"privacy_flag":false,"privacy_mode":"none","payload_commitment":null,"ciphertext_hex":null,"nonce_hex":null,"salt_hex":null,"kdf_params":null,"consent_receipt":null,"authorized_readers":[],"custodian_policy_id":null,"field_reader_acls":{},"key_wrapped_secrets":[],"revocation_events":[],"author":"did:citizen:holder-1","signature":"sig-consent-manifest-meta","timestamp":now}})).expect("consent"))).expect("request")).await.expect("consent response");

        let intent_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/intents").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"namespace":"files.secure","object_id":"did:citizen:holder-1","author_did":"did:author:a","mime_type":"application/pdf","file_size_bytes":256,"encryption_mode":"passphrase","consent_receipt":{"subject_did":"did:citizen:holder-1","data_hash":"sha256:file-manifest-meta","policy_ref":"policy:offchain:v1","granted_at":now,"expires_at":now+3600,"authorized_readers":["did:reader:1"]}})).expect("intent"))).expect("request")).await.expect("intent response");
        let intent_body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body");
        let intent_payload: Value = serde_json::from_slice(&intent_body).expect("intent payload");

        let commit_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/commit").header("content-type", "application/json").header("idempotency-key", "file-manifest-meta-commit").body(Body::from(serde_json::to_vec(&json!({"intent_id": intent_payload["intent_id"],"manifest":{"namespace":"files.secure","object_id":"did:citizen:holder-1","author_did":"did:author:a","mime_type":"application/pdf","file_size_bytes":256,"encryption_mode":"passphrase","file_ref":intent_payload["upload"]["object_ref"],"ciphertext_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payload_commitment":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","consent_receipt_ref":"consent:receipt:file-manifest-meta"},"envelope":{"envelope_id":Uuid::new_v4(),"signer":"did:author:a","signature":"sig-file-manifest-meta","submitted_at":chrono::Utc::now(),"payload":{"entry_id":Uuid::new_v4(),"namespace":"files.secure","action":"ENCRYPTED_FILE_UPLOAD","object_id":"did:citizen:holder-1","payload":{"manifest_id":"manifest-manifest-meta"},"privacy_flag":false,"privacy_mode":"none","payload_commitment":null,"ciphertext_hex":null,"nonce_hex":null,"salt_hex":null,"kdf_params":null,"consent_receipt":null,"authorized_readers":[],"custodian_policy_id":null,"field_reader_acls":{},"key_wrapped_secrets":[],"revocation_events":[],"author":"did:author:a","signature":"sig-file-manifest-meta","timestamp":now}}})).expect("commit"))).expect("request")).await.expect("commit response");
        let commit_body = axum::body::to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .expect("commit body");
        let commit_payload: Value = serde_json::from_slice(&commit_body).expect("commit payload");

        let _ = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/envelopes/submit").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"envelope_id":Uuid::new_v4(),"signer":"did:author:a","signature":"sig-revoke-manifest-meta","submitted_at":chrono::Utc::now(),"payload":{"entry_id":Uuid::new_v4(),"namespace":"files.secure","action":"ENCRYPTED_FILE_REVOKE","object_id":"did:citizen:holder-1","payload":{"manifest_id":commit_payload["manifest_id"],"reader_did":"did:reader:1","reason":"manual revocation"},"privacy_flag":false,"privacy_mode":"none","payload_commitment":null,"ciphertext_hex":null,"nonce_hex":null,"salt_hex":null,"kdf_params":null,"consent_receipt":null,"authorized_readers":[],"custodian_policy_id":null,"field_reader_acls":{},"key_wrapped_secrets":[],"revocation_events":[],"author":"did:author:a","signature":"sig-revoke-manifest-meta","timestamp":now}})).expect("revoke"))).expect("request")).await.expect("revoke response");

        let metadata_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/api/v1/files/manifests/{}",
                        commit_payload["manifest_id"].as_str().expect("manifest id")
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("metadata response");
        assert_eq!(metadata_response.status(), StatusCode::OK);
        let metadata_body = axum::body::to_bytes(metadata_response.into_body(), usize::MAX)
            .await
            .expect("metadata body");
        let metadata_payload: Value =
            serde_json::from_slice(&metadata_body).expect("metadata payload");
        assert_eq!(metadata_payload["consent_state"], json!("active"));
        assert_eq!(metadata_payload["revoked_readers"], json!(["did:reader:1"]));
    }

    #[tokio::test]
    async fn offchain_file_happy_path_upload_commit_read_revoke() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &[
                "ENCRYPTED_FILE_UPLOAD",
                "ENCRYPTED_FILE_SHARE",
                "ENCRYPTED_FILE_REVOKE",
            ],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let _ = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/envelopes/submit").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"envelope_id":Uuid::new_v4(),"signer":"did:citizen:holder-1","signature":"sig-consent-happy-path","submitted_at":chrono::Utc::now(),"payload":{"entry_id":Uuid::new_v4(),"namespace":"consent.receipt","action":"CONSENT_GRANTED","object_id":"did:citizen:holder-1","payload":{"data_hash":"sha256:file-happy-path","policy_ref":"policy:offchain:v1","expires_at":now+3600},"privacy_flag":false,"privacy_mode":"none","payload_commitment":null,"ciphertext_hex":null,"nonce_hex":null,"salt_hex":null,"kdf_params":null,"consent_receipt":null,"authorized_readers":[],"custodian_policy_id":null,"field_reader_acls":{},"key_wrapped_secrets":[],"revocation_events":[],"author":"did:citizen:holder-1","signature":"sig-consent-happy-path","timestamp":now}})).expect("consent"))).expect("request")).await.expect("consent response");

        let intent_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/intents").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"namespace":"files.secure","object_id":"did:citizen:holder-1","author_did":"did:author:a","mime_type":"application/pdf","file_size_bytes":1024,"encryption_mode":"passphrase","consent_receipt":{"subject_did":"did:citizen:holder-1","data_hash":"sha256:file-happy-path","policy_ref":"policy:offchain:v1","granted_at":now,"expires_at":now+3600,"authorized_readers":["did:reader:1"]}})).expect("intent"))).expect("request")).await.expect("intent response");
        assert_eq!(intent_response.status(), StatusCode::CREATED);
        let intent_body = axum::body::to_bytes(intent_response.into_body(), usize::MAX)
            .await
            .expect("intent body");
        let intent_payload: Value = serde_json::from_slice(&intent_body).expect("intent payload");

        let commit_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/commit").header("content-type", "application/json").header("idempotency-key", "file-happy-path-commit").body(Body::from(serde_json::to_vec(&json!({"intent_id": intent_payload["intent_id"],"manifest":{"namespace":"files.secure","object_id":"did:citizen:holder-1","author_did":"did:author:a","mime_type":"application/pdf","file_size_bytes":1024,"encryption_mode":"passphrase","file_ref":intent_payload["upload"]["object_ref"],"ciphertext_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payload_commitment":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","consent_receipt_ref":"consent:receipt:file-happy-path"},"envelope":{"envelope_id":Uuid::new_v4(),"signer":"did:author:a","signature":"sig-file-happy-path","submitted_at":chrono::Utc::now(),"payload":{"entry_id":Uuid::new_v4(),"namespace":"files.secure","action":"ENCRYPTED_FILE_UPLOAD","object_id":"did:citizen:holder-1","payload":{"manifest_id":"manifest-happy-path"},"privacy_flag":false,"privacy_mode":"none","payload_commitment":null,"ciphertext_hex":null,"nonce_hex":null,"salt_hex":null,"kdf_params":null,"consent_receipt":null,"authorized_readers":[],"custodian_policy_id":null,"field_reader_acls":{},"key_wrapped_secrets":[],"revocation_events":[],"author":"did:author:a","signature":"sig-file-happy-path","timestamp":now}}})).expect("commit"))).expect("request")).await.expect("commit response");
        assert_eq!(commit_response.status(), StatusCode::ACCEPTED);
        let commit_body = axum::body::to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .expect("commit body");
        let commit_payload: Value = serde_json::from_slice(&commit_body).expect("commit payload");

        let read_ok = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/read").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"manifest_id":commit_payload["manifest_id"],"reader_did":"did:reader:1","consent_receipt":{"subject_did":"did:citizen:holder-1","data_hash":"sha256:file-happy-path","policy_ref":"policy:offchain:v1","granted_at":now,"expires_at":now+3600,"authorized_readers":["did:reader:1"]}})).expect("read"))).expect("request")).await.expect("read response");
        assert_eq!(read_ok.status(), StatusCode::OK);

        let revoke_response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/envelopes/submit").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"envelope_id":Uuid::new_v4(),"signer":"did:author:a","signature":"sig-revoke-happy-path","submitted_at":chrono::Utc::now(),"payload":{"entry_id":Uuid::new_v4(),"namespace":"files.secure","action":"ENCRYPTED_FILE_REVOKE","object_id":"did:citizen:holder-1","payload":{"manifest_id":commit_payload["manifest_id"],"reader_did":"did:reader:1","reason":"happy path revoke"},"privacy_flag":false,"privacy_mode":"none","payload_commitment":null,"ciphertext_hex":null,"nonce_hex":null,"salt_hex":null,"kdf_params":null,"consent_receipt":null,"authorized_readers":[],"custodian_policy_id":null,"field_reader_acls":{},"key_wrapped_secrets":[],"revocation_events":[],"author":"did:author:a","signature":"sig-revoke-happy-path","timestamp":now}})).expect("revoke"))).expect("request")).await.expect("revoke response");
        assert_eq!(revoke_response.status(), StatusCode::ACCEPTED);

        let read_denied = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/files/read").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"manifest_id":commit_payload["manifest_id"],"reader_did":"did:reader:1","consent_receipt":{"subject_did":"did:citizen:holder-1","data_hash":"sha256:file-happy-path","policy_ref":"policy:offchain:v1","granted_at":now,"expires_at":now+3600,"authorized_readers":["did:reader:1"]}})).expect("read denied"))).expect("request")).await.expect("read denied response");
        assert_eq!(read_denied.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn payload_commit_happy_path_accepts_required_encrypted_field_refs() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD", "ENCRYPTED_PAYLOAD_FIELD_COMMIT"],
        )
        .router();
        let now = chrono::Utc::now().timestamp();
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "envelope_id": Uuid::new_v4(),
                            "signer": "did:citizen:holder-1",
                            "signature": "sig-consent-payload-happy-path",
                            "submitted_at": chrono::Utc::now(),
                            "payload": {
                                "entry_id": Uuid::new_v4(),
                                "namespace": "consent.receipt",
                                "action": "CONSENT_GRANTED",
                                "object_id": "did:citizen:holder-1",
                                "payload": {
                                    "data_hash": "sha256:payload-happy-path",
                                    "policy_ref": "policy:offchain:v1",
                                    "expires_at": now + 3_600
                                },
                                "privacy_flag": false,
                                "privacy_mode": "none",
                                "payload_commitment": null,
                                "ciphertext_hex": null,
                                "nonce_hex": null,
                                "salt_hex": null,
                                "kdf_params": null,
                                "consent_receipt": null,
                                "authorized_readers": [],
                                "custodian_policy_id": null,
                                "field_reader_acls": {},
                                "key_wrapped_secrets": [],
                                "revocation_events": [],
                                "author": "did:citizen:holder-1",
                                "signature": "sig-consent-payload-happy-path",
                                "timestamp": now
                            }
                        }))
                        .expect("consent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("consent response");

        let entry_id = Uuid::new_v4();
        let sso_commitment = ApiServer::<MemoryStorage>::compute_payload_field_commitment(
            "files.secure",
            &entry_id.to_string(),
            1,
            "payload.ssn",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        let medical_commitment = ApiServer::<MemoryStorage>::compute_payload_field_commitment(
            "files.secure",
            &entry_id.to_string(),
            1,
            "payload.medical_record",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-happy-path-commit")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-PAYLOAD-HAPPY-PATH",
                            "author_did": "did:author:a",
                            "policy_version": 1,
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:payload-happy-path",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            },
                            "encrypted_field_refs": [
                                {
                                    "field_path": "payload.ssn",
                                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "blob_ref": "blob://local/files.secure/PROC-PAYLOAD-HAPPY-PATH/field-ssn.cipher",
                                    "payload_commitment": sso_commitment
                                },
                                {
                                    "field_path": "payload.medical_record",
                                    "ciphertext_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                    "blob_ref": "blob://local/files.secure/PROC-PAYLOAD-HAPPY-PATH/field-medical.cipher",
                                    "payload_commitment": medical_commitment
                                }
                            ],
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-payload-happy-path",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": entry_id,
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_PAYLOAD_FIELD_COMMIT",
                                    "object_id": "PROC-PAYLOAD-HAPPY-PATH",
                                    "payload": {"record_type": "medical_claim"},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-payload-happy-path",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: Value = serde_json::from_slice(&body).expect("response payload");
        assert_eq!(payload["status"], json!("accepted"));
        assert_eq!(payload["namespace"], json!("files.secure"));
        assert_eq!(payload["object_id"], json!("PROC-PAYLOAD-HAPPY-PATH"));
        assert_eq!(payload["linked_manifest_ids"], json!([]));
        assert_eq!(
            payload["encrypted_field_refs"].as_array().map(Vec::len),
            Some(2)
        );
    }

    #[tokio::test]
    async fn payload_commit_rejects_idempotency_key_reuse_with_different_payload() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD", "ENCRYPTED_PAYLOAD_FIELD_COMMIT"],
        )
        .router();
        let now = chrono::Utc::now().timestamp();

        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "envelope_id": Uuid::new_v4(),
                            "signer": "did:citizen:holder-1",
                            "signature": "sig-consent-payload-idempotency",
                            "submitted_at": chrono::Utc::now(),
                            "payload": {
                                "entry_id": Uuid::new_v4(),
                                "namespace": "consent.receipt",
                                "action": "CONSENT_GRANTED",
                                "object_id": "did:citizen:holder-1",
                                "payload": {
                                    "data_hash": "sha256:payload-idempotency",
                                    "policy_ref": "policy:offchain:v1",
                                    "expires_at": now + 3_600
                                },
                                "privacy_flag": false,
                                "privacy_mode": "none",
                                "payload_commitment": null,
                                "ciphertext_hex": null,
                                "nonce_hex": null,
                                "salt_hex": null,
                                "kdf_params": null,
                                "consent_receipt": null,
                                "authorized_readers": [],
                                "custodian_policy_id": null,
                                "field_reader_acls": {},
                                "key_wrapped_secrets": [],
                                "revocation_events": [],
                                "author": "did:citizen:holder-1",
                                "signature": "sig-consent-payload-idempotency",
                                "timestamp": now
                            }
                        }))
                        .expect("consent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("consent response");

        let entry_id = Uuid::new_v4();
        let ssn_commitment = ApiServer::<MemoryStorage>::compute_payload_field_commitment(
            "files.secure",
            &entry_id.to_string(),
            1,
            "payload.ssn",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        let medical_commitment = ApiServer::<MemoryStorage>::compute_payload_field_commitment(
            "files.secure",
            &entry_id.to_string(),
            1,
            "payload.medical_record",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        );

        let commit_request = json!({
            "namespace": "files.secure",
            "object_id": "PROC-PAYLOAD-IDEMPOTENCY",
            "author_did": "did:author:a",
            "policy_version": 1,
            "consent_receipt": {
                "subject_did": "did:citizen:holder-1",
                "data_hash": "sha256:payload-idempotency",
                "policy_ref": "policy:offchain:v1",
                "granted_at": now,
                "expires_at": now + 3_600,
                "authorized_readers": ["did:reader:1"]
            },
            "encrypted_field_refs": [
                {
                    "field_path": "payload.ssn",
                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "blob_ref": "blob://local/files.secure/PROC-PAYLOAD-IDEMPOTENCY/field-ssn.cipher",
                    "payload_commitment": ssn_commitment
                },
                {
                    "field_path": "payload.medical_record",
                    "ciphertext_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "blob_ref": "blob://local/files.secure/PROC-PAYLOAD-IDEMPOTENCY/field-medical.cipher",
                    "payload_commitment": medical_commitment
                }
            ],
            "envelope": {
                "envelope_id": Uuid::new_v4(),
                "signer": "did:author:a",
                "signature": "sig-payload-idempotency",
                "submitted_at": chrono::Utc::now(),
                "payload": {
                    "entry_id": entry_id,
                    "namespace": "files.secure",
                    "action": "ENCRYPTED_PAYLOAD_FIELD_COMMIT",
                    "object_id": "PROC-PAYLOAD-IDEMPOTENCY",
                    "payload": {"record_type": "pii_update"},
                    "privacy_flag": false,
                    "privacy_mode": "none",
                    "payload_commitment": null,
                    "ciphertext_hex": null,
                    "nonce_hex": null,
                    "salt_hex": null,
                    "kdf_params": null,
                    "consent_receipt": null,
                    "authorized_readers": [],
                    "custodian_policy_id": null,
                    "field_reader_acls": {},
                    "key_wrapped_secrets": [],
                    "revocation_events": [],
                    "author": "did:author:a",
                    "signature": "sig-payload-idempotency",
                    "timestamp": now
                }
            }
        });

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-idempotency-1")
                    .body(Body::from(
                        serde_json::to_vec(&commit_request).expect("commit request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("first response");
        assert_eq!(first.status(), StatusCode::ACCEPTED);

        let mut altered_commit_request = commit_request.clone();
        altered_commit_request["encrypted_field_refs"][0]["ciphertext_hash"] =
            json!("sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

        let conflict = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-idempotency-1")
                    .body(Body::from(
                        serde_json::to_vec(&altered_commit_request)
                            .expect("altered commit request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("conflict response");
        assert_eq!(conflict.status(), StatusCode::CONFLICT);

        let body = axum::body::to_bytes(conflict.into_body(), usize::MAX)
            .await
            .expect("conflict body");
        let payload: Value = serde_json::from_slice(&body).expect("conflict payload");
        assert_eq!(
            payload["error"],
            "idempotency key reuse with different request payload"
        );
    }

    #[tokio::test]
    async fn payload_field_refs_endpoint_returns_committed_refs() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD", "ENCRYPTED_PAYLOAD_FIELD_COMMIT"],
        )
        .router();
        let now = chrono::Utc::now().timestamp();
        let entry_id = Uuid::new_v4();
        let medical_commitment = ApiServer::<MemoryStorage>::compute_payload_field_commitment(
            "files.secure",
            &entry_id.to_string(),
            1,
            "payload.medical_record",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        );
        let ssn_commitment = ApiServer::<MemoryStorage>::compute_payload_field_commitment(
            "files.secure",
            &entry_id.to_string(),
            1,
            "payload.ssn",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );

        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "envelope_id": Uuid::new_v4(),
                            "signer": "did:citizen:holder-1",
                            "signature": "sig-consent-payload-field-refs",
                            "submitted_at": chrono::Utc::now(),
                            "payload": {
                                "entry_id": Uuid::new_v4(),
                                "namespace": "consent.receipt",
                                "action": "CONSENT_GRANTED",
                                "object_id": "did:citizen:holder-1",
                                "payload": {
                                    "data_hash": "sha256:payload-field-refs",
                                    "policy_ref": "policy:offchain:v1",
                                    "expires_at": now + 3_600
                                },
                                "privacy_flag": false,
                                "privacy_mode": "none",
                                "payload_commitment": null,
                                "ciphertext_hex": null,
                                "nonce_hex": null,
                                "salt_hex": null,
                                "kdf_params": null,
                                "consent_receipt": null,
                                "authorized_readers": [],
                                "custodian_policy_id": null,
                                "field_reader_acls": {},
                                "key_wrapped_secrets": [],
                                "revocation_events": [],
                                "author": "did:citizen:holder-1",
                                "signature": "sig-consent-payload-field-refs",
                                "timestamp": now
                            }
                        }))
                        .expect("consent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("consent response");

        let commit_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-field-refs-commit")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-PAYLOAD-FIELD-REFS",
                            "author_did": "did:author:a",
                            "policy_version": 1,
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:payload-field-refs",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:reader:1"]
                            },
                            "encrypted_field_refs": [
                                {
                                    "field_path": "payload.medical_record",
                                    "ciphertext_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                                    "blob_ref": "blob://local/files.secure/PROC-PAYLOAD-FIELD-REFS/field-medical.cipher",
                                    "payload_commitment": medical_commitment
                                },
                                {
                                    "field_path": "payload.ssn",
                                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "blob_ref": "blob://local/files.secure/PROC-PAYLOAD-FIELD-REFS/field-ssn.cipher",
                                    "payload_commitment": ssn_commitment
                                }
                            ],
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-payload-field-refs",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": entry_id,
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_PAYLOAD_FIELD_COMMIT",
                                    "object_id": "PROC-PAYLOAD-FIELD-REFS",
                                    "payload": {"record_type": "medical_claim"},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-payload-field-refs",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("commit body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("commit response");
        assert_eq!(commit_response.status(), StatusCode::ACCEPTED);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/v1/payloads/fields/{entry_id}/files.secure"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("refs response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("refs body");
        let payload: Value = serde_json::from_slice(&body).expect("refs payload");
        assert_eq!(payload["entry_id"], json!(entry_id));
        assert_eq!(payload["namespace"], json!("files.secure"));
        assert_eq!(payload["field_refs"].as_array().map(Vec::len), Some(2));
        assert_eq!(
            payload["field_refs"][0]["field_path"],
            json!("payload.medical_record")
        );
        assert_eq!(payload["field_refs"][1]["field_path"], json!("payload.ssn"));
    }

    #[tokio::test]
    async fn payload_data_hash_endpoint_returns_ledger_matches_for_encrypted_data() {
        let storage = Arc::new(MemoryStorage::new());
        let ledger = Arc::new(Ledger::new(Arc::clone(&storage), KeyRegistry::new()));
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "audit.procurement".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "require_signature".to_string(),
                config: json!({}),
            }],
        }]);
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "consent.receipt".to_string(),
                version: 1,
                rules_hash: "consent-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "require_signature".to_string(),
                config: json!({}),
            }],
        }]);
        storage
            .upsert_namespace(NamespaceDescriptor {
                namespace: "audit.procurement".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            })
            .expect("audit namespace should be tracked");
        storage
            .upsert_namespace(NamespaceDescriptor {
                namespace: "consent.receipt".to_string(),
                version: 1,
                rules_hash: "consent-v1".to_string(),
                governed_by: "governance".to_string(),
            })
            .expect("consent namespace should be tracked");

        let now = chrono::Utc::now().timestamp();
        let data_hash = "sha256:lookup-data-hash";

        let consent_signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": data_hash,
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &consent_signer);
        ledger
            .apply_entry(consent_entry)
            .expect("consent entry should be accepted");

        let audit_signer = ValidatorKeypair::generate("did:author:encrypted".to_string());
        let mut audit_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "audit.procurement".to_string(),
            action: "ENCRYPTED_AUDIT_RECORD".to_string(),
            object_id: "PROC-DATA-HASH-LOOKUP".to_string(),
            payload: json!({"record_type": "procurement_notice"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: Some(data_hash.to_string()),
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:encrypted".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut audit_entry, &audit_signer);
        ledger
            .apply_entry(audit_entry)
            .expect("audit entry should be accepted");

        let edge = Arc::new(ApiEdgeState::new(
            ApiEdgeConfig {
                offchain_encrypted_files_v1_enabled: true,
                ..ApiEdgeConfig::default()
            },
            Arc::new(LocalOffchainObjectStore),
        ));

        let (status, Json(payload)) = ApiServer::<MemoryStorage>::handle_get_payload_data_hash(
            Arc::clone(&ledger),
            edge,
            data_hash.to_string(),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data_hash"], json!(data_hash));
        assert_eq!(payload["matches"].as_array().map(Vec::len), Some(2));

        let sources = payload["matches"]
            .as_array()
            .expect("matches array")
            .iter()
            .filter_map(|match_row| match_row.get("source").and_then(|value| value.as_str()))
            .collect::<Vec<_>>();
        assert!(sources.contains(&"consent_receipt.data_hash"));
        assert!(sources.contains(&"payload_commitment"));
    }

    #[tokio::test]
    async fn payload_data_hash_query_route_requires_q_parameter() {
        let ledger = Arc::new(Ledger::new(
            Arc::new(MemoryStorage::new()),
            KeyRegistry::new(),
        ));
        let edge = Arc::new(ApiEdgeState::new(
            ApiEdgeConfig {
                offchain_encrypted_files_v1_enabled: true,
                ..ApiEdgeConfig::default()
            },
            Arc::new(LocalOffchainObjectStore),
        ));

        let (status, Json(payload)) =
            ApiServer::<MemoryStorage>::handle_get_payload_data_hash_query(
                ledger,
                edge,
                DataHashQueryParams { q: None },
            )
            .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            payload["error"],
            json!("missing required query parameter: q")
        );
    }

    #[tokio::test]
    async fn payload_data_hash_endpoint_matches_payload_data_hash_for_on_chain_encrypted_forms() {
        let storage = Arc::new(MemoryStorage::new());
        let ledger = Arc::new(Ledger::new(Arc::clone(&storage), KeyRegistry::new()));
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "audit.procurement".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "require_signature".to_string(),
                config: json!({}),
            }],
        }]);
        storage
            .upsert_namespace(NamespaceDescriptor {
                namespace: "audit.procurement".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            })
            .expect("namespace should be tracked");

        let signer = ValidatorKeypair::generate("did:author:forms".to_string());
        let mut entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "audit.procurement".to_string(),
            action: "FORM_SUBMITTED".to_string(),
            object_id: "FORM-001".to_string(),
            payload: json!({
                "data_hash": "sha256:form-sensitive-onchain",
                "encrypted_fields": ["ssn", "medical_record"]
            }),
            privacy_flag: true,
            privacy_mode: citizen_types::PrivacyMode::Hybrid,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:forms".to_string(),
            signature: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
        };
        sign_entry_for_tests(&mut entry, &signer);
        ledger.apply_entry(entry).expect("entry should be accepted");

        let edge = Arc::new(ApiEdgeState::new(
            ApiEdgeConfig {
                offchain_encrypted_files_v1_enabled: false,
                ..ApiEdgeConfig::default()
            },
            Arc::new(LocalOffchainObjectStore),
        ));

        let (status, Json(payload)) = ApiServer::<MemoryStorage>::handle_get_payload_data_hash(
            ledger,
            edge,
            "form-sensitive-onchain".to_string(),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data_hash"], json!("sha256:form-sensitive-onchain"));
        assert_eq!(payload["matches"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["matches"][0]["source"], json!("payload.data_hash"));
        assert_eq!(
            payload["matches"][0]["namespace"],
            json!("audit.procurement")
        );
    }

    #[tokio::test]
    async fn payload_data_hash_endpoint_avoids_duplicate_matches_when_commitment_and_payload_match()
    {
        let storage = Arc::new(MemoryStorage::new());
        let ledger = Arc::new(Ledger::new(Arc::clone(&storage), KeyRegistry::new()));
        ledger.bootstrap_namespaces(vec![NamespaceRuleset {
            descriptor: NamespaceDescriptor {
                namespace: "forms.commitment".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            },
            writers: BTreeSet::new(),
            validators: vec![NamespaceRule {
                name: "require_signature".to_string(),
                config: json!({}),
            }],
        }]);
        storage
            .upsert_namespace(NamespaceDescriptor {
                namespace: "forms.commitment".to_string(),
                version: 1,
                rules_hash: "rules-v1".to_string(),
                governed_by: "governance".to_string(),
            })
            .expect("namespace should be tracked");

        let data_hash = "sha256:forms-commitment-overlap";
        let signer = ValidatorKeypair::generate("did:author:forms".to_string());
        let mut entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "forms.commitment".to_string(),
            action: "FORM_SUBMITTED".to_string(),
            object_id: "FORM-OVERLAP-001".to_string(),
            payload: json!({
                "data_hash": data_hash,
                "encrypted_form_url": "interest_submissions://test/FORM-OVERLAP-001"
            }),
            privacy_flag: true,
            privacy_mode: citizen_types::PrivacyMode::Hybrid,
            payload_commitment: Some(data_hash.to_string()),
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:forms".to_string(),
            signature: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
        };
        sign_entry_for_tests(&mut entry, &signer);
        ledger.apply_entry(entry).expect("entry should be accepted");

        let edge = Arc::new(ApiEdgeState::new(
            ApiEdgeConfig {
                offchain_encrypted_files_v1_enabled: false,
                ..ApiEdgeConfig::default()
            },
            Arc::new(LocalOffchainObjectStore),
        ));

        let (status, Json(payload)) = ApiServer::<MemoryStorage>::handle_get_payload_data_hash(
            ledger,
            edge,
            "forms-commitment-overlap".to_string(),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data_hash"], json!(data_hash));
        assert_eq!(payload["matches"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["matches"][0]["source"], json!("payload_commitment"));
    }

    #[tokio::test]
    async fn payload_data_hash_lookup_falls_back_to_block_scan_when_namespace_registry_is_empty() {
        let storage = Arc::new(MemoryStorage::new());
        let ledger = Arc::new(Ledger::new(Arc::clone(&storage), KeyRegistry::new()));

        let entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "forms.secure".to_string(),
            action: "FORM_SUBMITTED".to_string(),
            object_id: "FORM-BLOCK-ONLY-001".to_string(),
            payload: json!({
                "data_hash": "sha256:block-scan-data-hash"
            }),
            privacy_flag: true,
            privacy_mode: citizen_types::PrivacyMode::Hybrid,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:author:forms".to_string(),
            signature: "sig-block-only".to_string(),
            timestamp: chrono::Utc::now().timestamp(),
        };

        storage
            .store_block(Block {
                header: BlockHeader {
                    height: 0,
                    prev_hash: "genesis".to_string(),
                    entry_root: "entry-root-0".to_string(),
                    proposer: "local-validator".to_string(),
                    timestamp: chrono::Utc::now().timestamp(),
                    commit_proof: CommitProof {
                        aggregated_signature: "sig-finality".to_string(),
                        participant_ids: BTreeSet::new(),
                    },
                },
                entries: vec![entry],
            })
            .expect("block should be stored");

        let edge = Arc::new(ApiEdgeState::new(
            ApiEdgeConfig {
                offchain_encrypted_files_v1_enabled: false,
                ..ApiEdgeConfig::default()
            },
            Arc::new(LocalOffchainObjectStore),
        ));

        let (status, Json(payload)) = ApiServer::<MemoryStorage>::handle_get_payload_data_hash(
            ledger,
            edge,
            "block-scan-data-hash".to_string(),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload["data_hash"], json!("sha256:block-scan-data-hash"));
        assert_eq!(payload["matches"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["matches"][0]["source"], json!("payload.data_hash"));
        assert_eq!(payload["matches"][0]["namespace"], json!("forms.secure"));
    }

    #[tokio::test]
    async fn payload_commit_rejects_non_payload_commit_action() {
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();

        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:payload-action-check",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-action-check")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-ACT-2",
                            "author_did": "did:author:a",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:payload-action-check",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            },
                            "encrypted_field_refs": [
                                {
                                    "field_path": "payload.ssn",
                                    "blob_ref": "blob://a",
                                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                },
                                {
                                    "field_path": "payload.medical_record",
                                    "blob_ref": "blob://b",
                                    "ciphertext_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                                    "payload_commitment": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                                }
                            ],
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-payload-action",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_FILE_UPLOAD",
                                    "object_id": "PROC-ACT-2",
                                    "payload": {"field_refs": 2},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-payload-action",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn file_intent_rejects_consent_with_unapproved_policy_ref() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_policy(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD"],
            Some("policy:offchain:strict:v1"),
            None,
        )
        .router();

        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:policy-ref-check",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-POL-1",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 1024,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:policy-ref-check",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: Value = serde_json::from_slice(&body).expect("response json");
        assert_eq!(
            payload["error"],
            "consent receipt policy_ref does not satisfy namespace policy requirement: expected policy:offchain:strict:v1"
        );
    }

    #[tokio::test]
    async fn payload_commit_rejects_consent_with_unapproved_policy_ref() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_policy(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD"],
            Some("policy:offchain:strict:v1"),
            None,
        )
        .router();

        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:payload-policy-check",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-policy-check")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-PAY-1",
                            "author_did": "did:author:a",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:payload-policy-check",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            },
                            "encrypted_field_refs": [
                                {
                                    "field_path": "payload.ssn",
                                    "blob_ref": "blob://local/files.secure/PROC-PAY-1/field-ssn.cipher",
                                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                },
                                {
                                    "field_path": "payload.medical_record",
                                    "blob_ref": "blob://local/files.secure/PROC-PAY-1/field-medical.cipher",
                                    "ciphertext_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                                    "payload_commitment": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                                }
                            ],
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-payload-policy",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_PAYLOAD_FIELD_COMMIT",
                                    "object_id": "PROC-PAY-1",
                                    "payload": {"field_refs": 2},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-payload-policy",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: Value = serde_json::from_slice(&body).expect("response json");
        assert_eq!(
            payload["error"],
            "consent receipt policy_ref does not satisfy namespace policy requirement: expected policy:offchain:strict:v1"
        );
    }

    #[tokio::test]
    async fn payload_commit_rejects_policy_version_mismatch() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_policy(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD"],
            None,
            Some(json!({
                "policy_version": 3,
                "min_supported_policy_version": 2,
                "migration_guide_ref": "docs/migrations/offchain-policy-v3.md",
                "offchain_encrypted_fields": ["payload.ssn", "payload.medical_record"]
            })),
        )
        .router();

        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:payload-policy-version-1",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-policy-version-1")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-PAY-VERSION-1",
                            "author_did": "did:author:a",
                            "policy_version": 2,
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:payload-policy-version-1",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            },
                            "encrypted_field_refs": [
                                {
                                    "field_path": "payload.ssn",
                                    "blob_ref": "blob://local/files.secure/PROC-PAY-VERSION-1/field-ssn.cipher",
                                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                },
                                {
                                    "field_path": "payload.medical_record",
                                    "blob_ref": "blob://local/files.secure/PROC-PAY-VERSION-1/field-medical.cipher",
                                    "ciphertext_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                                    "payload_commitment": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                                }
                            ],
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-payload-policy-version-1",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_PAYLOAD_FIELD_COMMIT",
                                    "object_id": "PROC-PAY-VERSION-1",
                                    "payload": {"field_refs": 2},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-payload-policy-version-1",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: Value = serde_json::from_slice(&body).expect("response json");
        assert_eq!(
            payload["error"],
            "submitted payload policy version does not match namespace policy"
        );
        assert_eq!(payload["submitted_policy_version"], json!(2));
        assert_eq!(payload["expected_policy_version"], json!(3));
        assert_eq!(
            payload["migration_guide_ref"],
            json!("docs/migrations/offchain-policy-v3.md")
        );
    }

    #[tokio::test]
    async fn payload_commit_rejects_noncanonical_field_payload_commitment() {
        let grant_keys = grant_approver_keys(&[
            "grant:ops-1",
            "grant:ops-2",
            "grant:ops-3",
            "grant:ops-4",
            "grant:ops-5",
        ]);
        let app = build_server_with_grant_keys_and_file_actions(
            &grant_keys,
            &["ENCRYPTED_FILE_UPLOAD", "ENCRYPTED_PAYLOAD_FIELD_COMMIT"],
        )
        .router();

        let now = chrono::Utc::now().timestamp();
        let signer = ValidatorKeypair::generate("did:citizen:holder-1".to_string());
        let mut consent_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "consent.receipt".to_string(),
            action: "CONSENT_GRANTED".to_string(),
            object_id: "did:citizen:holder-1".to_string(),
            payload: json!({
                "data_hash": "sha256:payload-bad-field-commitment",
                "policy_ref": "policy:offchain:v1",
                "expires_at": now + 3_600
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:holder-1".to_string(),
            signature: String::new(),
            timestamp: now,
        };
        sign_entry_for_tests(&mut consent_entry, &signer);
        let consent_envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: consent_entry.author.clone(),
            signature: consent_entry.signature.clone(),
            signature_scope: None,
            co_signatures: Vec::new(),
            multisig_policy: None,
            submitted_at: chrono::Utc::now(),
            payload: consent_entry,
        };
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/envelopes/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&consent_envelope).expect("serialize envelope"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("submit response");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/payloads/commit")
                    .header("content-type", "application/json")
                    .header("idempotency-key", "payload-bad-field-commitment")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-PAY-BAD-COMMITMENT",
                            "author_did": "did:author:a",
                            "policy_version": 1,
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:payload-bad-field-commitment",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": now,
                                "expires_at": now + 3_600,
                                "authorized_readers": ["did:author:a"]
                            },
                            "encrypted_field_refs": [
                                {
                                    "field_path": "payload.ssn",
                                    "blob_ref": "blob://local/files.secure/PROC-PAY-BAD-COMMITMENT/field-ssn.cipher",
                                    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "payload_commitment": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                },
                                {
                                    "field_path": "payload.medical_record",
                                    "blob_ref": "blob://local/files.secure/PROC-PAY-BAD-COMMITMENT/field-medical.cipher",
                                    "ciphertext_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                                    "payload_commitment": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                                }
                            ],
                            "envelope": {
                                "envelope_id": Uuid::new_v4(),
                                "signer": "did:author:a",
                                "signature": "sig-payload-bad-field-commitment",
                                "submitted_at": chrono::Utc::now(),
                                "payload": {
                                    "entry_id": Uuid::new_v4(),
                                    "namespace": "files.secure",
                                    "action": "ENCRYPTED_PAYLOAD_FIELD_COMMIT",
                                    "object_id": "PROC-PAY-BAD-COMMITMENT",
                                    "payload": {"record_type": "medical_claim"},
                                    "privacy_flag": false,
                                    "privacy_mode": "none",
                                    "payload_commitment": null,
                                    "ciphertext_hex": null,
                                    "nonce_hex": null,
                                    "salt_hex": null,
                                    "kdf_params": null,
                                    "consent_receipt": null,
                                    "authorized_readers": [],
                                    "custodian_policy_id": null,
                                    "field_reader_acls": {},
                                    "key_wrapped_secrets": [],
                                    "revocation_events": [],
                                    "author": "did:author:a",
                                    "signature": "sig-payload-bad-field-commitment",
                                    "timestamp": now
                                }
                            }
                        }))
                        .expect("request body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: Value = serde_json::from_slice(&body).expect("response json");
        assert_eq!(
            payload["error"],
            "encrypted field payload_commitment does not match canonical commitment derivation"
        );
        let mismatches = payload["mismatches"]
            .as_array()
            .expect("mismatch array should exist");
        assert_eq!(mismatches.len(), 2);
        assert!(mismatches
            .iter()
            .all(|mismatch| mismatch["expected_payload_commitment"].as_str().is_some()));
    }

    #[tokio::test]
    async fn file_alerts_endpoint_requires_scope_when_auth_enabled() {
        let mut clients = BTreeMap::new();
        clients.insert(
            "files-read-only".to_string(),
            ApiClientProfile::with_scopes(["files.read"]),
        );
        clients.insert(
            "alerts-reader".to_string(),
            ApiClientProfile::with_scopes(["files.alerts.read"]),
        );
        let app = build_server_with_edge(ApiEdgeConfig {
            write_enabled: true,
            auth_required: true,
            max_write_requests_per_minute: 10,
            offchain_encrypted_files_v1_enabled: true,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: false,
            clients,
            ..ApiEdgeConfig::default()
        })
        .router();

        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/files/alerts")
                    .header("x-api-key", "files-read-only")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("denied response");
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        let allowed = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/files/alerts")
                    .header("x-api-key", "alerts-reader")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("allowed response");
        assert_eq!(allowed.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn file_intent_requires_matching_scope_when_auth_enabled() {
        let mut clients = BTreeMap::new();
        clients.insert(
            "entries-only".to_string(),
            ApiClientProfile::with_scopes(["entries.submit"]),
        );
        let app = build_server_with_edge(ApiEdgeConfig {
            write_enabled: true,
            auth_required: true,
            max_write_requests_per_minute: 10,
            offchain_encrypted_files_v1_enabled: true,
            enforce_manifest_payload_binding: false,
            require_builder_credit_for_all_writes: false,
            clients,
            ..ApiEdgeConfig::default()
        })
        .router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/files/intents")
                    .header("content-type", "application/json")
                    .header("x-api-key", "entries-only")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "namespace": "files.secure",
                            "object_id": "PROC-001",
                            "author_did": "did:author:a",
                            "mime_type": "application/pdf",
                            "file_size_bytes": 512,
                            "encryption_mode": "passphrase",
                            "consent_receipt": {
                                "subject_did": "did:citizen:holder-1",
                                "data_hash": "sha256:payload-001",
                                "policy_ref": "policy:offchain:v1",
                                "granted_at": 1_736_500_000,
                                "expires_at": 1_736_503_600
                            }
                        }))
                        .expect("intent body"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("intent response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn sha256_digest_validator_accepts_canonical_format() {
        assert!(ApiServer::<MemoryStorage>::is_valid_sha256_digest(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
    }

    #[test]
    fn sha256_digest_validator_rejects_invalid_format() {
        assert!(!ApiServer::<MemoryStorage>::is_valid_sha256_digest(
            "sha256:xyz"
        ));
        assert!(!ApiServer::<MemoryStorage>::is_valid_sha256_digest(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
    }

    #[tokio::test]
    async fn civic_proposal_lifecycle_and_tally() {
        let app = build_server().router();

        let open = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "civic.proposal".to_string(),
            action: "OPEN_PROPOSAL".to_string(),
            object_id: "prop-budget-2026".to_string(),
            payload: json!({
                "title": "Budget Approval 2026",
                "description": "Approve national budget"
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "governance:vote".to_string(),
            signature: "sig".to_string(),
            timestamp: 1_736_500_200,
        };
        let submit = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&open).expect("open body")))
                    .expect("open request"),
            )
            .await
            .expect("open submit");
        assert!(submit.status().is_success());

        let ballot1 = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "civic.ballot".to_string(),
            action: "CAST_BALLOT".to_string(),
            object_id: "ballot-alice-prop-budget-2026".to_string(),
            payload: json!({"proposal_id": "prop-budget-2026", "choice": "yes"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:alice".to_string(),
            signature: "sig".to_string(),
            timestamp: 1_736_500_210,
        };
        let ballot2 = LedgerEntry {
            author: "did:citizen:bob".to_string(),
            object_id: "ballot-bob-prop-budget-2026".to_string(),
            payload: json!({"proposal_id": "prop-budget-2026", "choice": "no"}),
            timestamp: 1_736_500_220,
            ..ballot1.clone()
        };
        let ballot3 = LedgerEntry {
            author: "did:citizen:carol".to_string(),
            object_id: "ballot-carol-prop-budget-2026".to_string(),
            payload: json!({"proposal_id": "prop-budget-2026", "choice": "yes"}),
            timestamp: 1_736_500_230,
            ..ballot1.clone()
        };

        for ballot in [&ballot1, &ballot2, &ballot3] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/v1/entries/submit")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::to_vec(ballot).expect("ballot body"),
                        ))
                        .expect("ballot request"),
                )
                .await
                .expect("ballot submit");
            assert!(resp.status().is_success());
        }

        let double_vote = LedgerEntry {
            author: "did:citizen:alice".to_string(),
            object_id: "ballot-alice-retry".to_string(),
            timestamp: 1_736_500_999,
            ..ballot1.clone()
        };
        let double_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&double_vote).expect("double body"),
                    ))
                    .expect("double request"),
            )
            .await
            .expect("double submit");
        assert_eq!(double_resp.status(), StatusCode::BAD_REQUEST);

        let tally_resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/civic/proposals/prop-budget-2026/tally")
                    .body(Body::empty())
                    .expect("tally request"),
            )
            .await
            .expect("tally response");
        assert_eq!(tally_resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(tally_resp.into_body(), usize::MAX)
            .await
            .expect("tally body");
        let payload: Value = serde_json::from_slice(&body).expect("tally payload");
        assert_eq!(payload["total_ballots"], 3);
        assert_eq!(payload["tally"]["yes"], 2);
        assert_eq!(payload["tally"]["no"], 1);
    }

    #[tokio::test]
    async fn civic_proposals_list_returns_open_proposals() {
        let app = build_server().router();

        let open = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "civic.proposal".to_string(),
            action: "OPEN_PROPOSAL".to_string(),
            object_id: "prop-roads-001".to_string(),
            payload: json!({"title": "Road Infrastructure", "description": "Highway expansion"}),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "governance:vote".to_string(),
            signature: "sig".to_string(),
            timestamp: 1_736_500_300,
        };
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&open).expect("body")))
                    .expect("submit"),
            )
            .await
            .expect("submit response");

        let list_resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/civic/proposals")
                    .body(Body::empty())
                    .expect("list request"),
            )
            .await
            .expect("list response");
        assert_eq!(list_resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(list_resp.into_body(), usize::MAX)
            .await
            .expect("list body");
        let payload: Value = serde_json::from_slice(&body).expect("list payload");
        assert_eq!(payload["proposals"][0]["proposal_id"], "prop-roads-001");
        assert_eq!(payload["proposals"][0]["status"], "open");
    }

    #[tokio::test]
    async fn civic_proposal_detail_returns_404_for_missing() {
        let app = build_server().router();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/civic/proposals/nonexistent")
                    .body(Body::empty())
                    .expect("detail request"),
            )
            .await
            .expect("detail response");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn election_lifecycle_and_tally() {
        let app = build_server().router();

        let open = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "civic.election".to_string(),
            action: "OPEN_ELECTION".to_string(),
            object_id: "elec-2026-national".to_string(),
            payload: json!({
                "title": "2026 National Elections",
                "races": [
                    {
                        "race_id": "president",
                        "title": "President",
                        "seat_type": "single",
                        "max_selections": 1,
                        "candidates": [
                            {"candidate_id": "p1", "name": "Alice Reyes", "party": "Party A"},
                            {"candidate_id": "p2", "name": "Bob Santos", "party": "Party B"}
                        ]
                    },
                    {
                        "race_id": "senator",
                        "title": "Senator (Top 12)",
                        "seat_type": "multi",
                        "max_selections": 12,
                        "candidates": [
                            {"candidate_id": "s1", "name": "Carol Cruz", "party": "Party A"},
                            {"candidate_id": "s2", "name": "Dave Lim", "party": "Party B"},
                            {"candidate_id": "s3", "name": "Eve Tan", "party": "Party C"}
                        ]
                    }
                ]
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "governance:vote".to_string(),
            signature: "sig".to_string(),
            timestamp: 1_736_600_100,
        };
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/entries/submit")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&open).expect("open body")))
                    .expect("open request"),
            )
            .await
            .expect("open submit");
        assert!(resp.status().is_success());

        let ballot1 = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "civic.election.ballot".to_string(),
            action: "CAST_BALLOT".to_string(),
            object_id: "ballot-alice-elec-2026-national".to_string(),
            payload: json!({
                "election_id": "elec-2026-national",
                "selections": [
                    {"race_id": "president", "candidate_ids": ["p1"]},
                    {"race_id": "senator", "candidate_ids": ["s1", "s3"]}
                ]
            }),
            privacy_flag: false,
            privacy_mode: citizen_types::PrivacyMode::None,
            payload_commitment: None,
            ciphertext_hex: None,
            nonce_hex: None,
            salt_hex: None,
            kdf_params: None,
            consent_receipt: None,
            authorized_readers: vec![],
            custodian_policy_id: None,
            field_reader_acls: BTreeMap::new(),
            key_wrapped_secrets: vec![],
            revocation_events: vec![],
            author: "did:citizen:alice".to_string(),
            signature: "sig".to_string(),
            timestamp: 1_736_600_200,
        };
        let ballot2 = LedgerEntry {
            author: "did:citizen:bob".to_string(),
            object_id: "ballot-bob-elec-2026-national".to_string(),
            payload: json!({
                "election_id": "elec-2026-national",
                "selections": [
                    {"race_id": "president", "candidate_ids": ["p2"]},
                    {"race_id": "senator", "candidate_ids": ["s2", "s3"]}
                ]
            }),
            timestamp: 1_736_600_210,
            ..ballot1.clone()
        };

        for ballot in [&ballot1, &ballot2] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/v1/entries/submit")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::to_vec(ballot).expect("ballot body"),
                        ))
                        .expect("ballot request"),
                )
                .await
                .expect("ballot submit");
            assert!(resp.status().is_success());
        }

        let list_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/civic/elections")
                    .body(Body::empty())
                    .expect("list request"),
            )
            .await
            .expect("list response");
        assert_eq!(list_resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(list_resp.into_body(), usize::MAX)
            .await
            .expect("list body");
        let payload: Value = serde_json::from_slice(&body).expect("list payload");
        assert_eq!(payload["elections"][0]["election_id"], "elec-2026-national");
        assert_eq!(payload["elections"][0]["status"], "open");
        assert_eq!(payload["elections"][0]["race_count"], 2);

        let detail_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/civic/elections/elec-2026-national")
                    .body(Body::empty())
                    .expect("detail request"),
            )
            .await
            .expect("detail response");
        assert_eq!(detail_resp.status(), StatusCode::OK);

        let tally_resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/civic/elections/elec-2026-national/tally")
                    .body(Body::empty())
                    .expect("tally request"),
            )
            .await
            .expect("tally response");
        assert_eq!(tally_resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(tally_resp.into_body(), usize::MAX)
            .await
            .expect("tally body");
        let payload: Value = serde_json::from_slice(&body).expect("tally payload");
        assert_eq!(payload["total_ballots"], 2);

        let pres = &payload["races"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["race_id"] == "president")
            .unwrap();
        assert_eq!(pres["tally"]["p1"], 1);
        assert_eq!(pres["tally"]["p2"], 1);

        let sen = &payload["races"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["race_id"] == "senator")
            .unwrap();
        assert_eq!(sen["tally"]["s1"], 1);
        assert_eq!(sen["tally"]["s2"], 1);
        assert_eq!(sen["tally"]["s3"], 2);
    }

    #[tokio::test]
    async fn election_detail_returns_404_for_missing() {
        let app = build_server().router();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/v1/civic/elections/nonexistent")
                    .body(Body::empty())
                    .expect("detail request"),
            )
            .await
            .expect("detail response");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
fn canonical_envelope_preimage(
    payload: &LedgerEntry,
    signature_scope: &str,
) -> Result<String, ProtocolError> {
    let base_signing_payload = serde_json::json!({
        "entry_id": payload.entry_id,
        "namespace": payload.namespace,
        "action": payload.action,
        "object_id": payload.object_id,
        "payload": payload.payload,
        "author": payload.author,
        "timestamp": payload.timestamp,
    });
    match signature_scope {
        "canonical_payload_v1" => Ok(canonical_json(&base_signing_payload)),
        "canonical_payload_v2" => {
            let replay_protection = payload
                .payload
                .get("replay_protection")
                .and_then(|value| value.as_object())
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "canonical_payload_v2 requires payload.replay_protection object".into(),
                    )
                })?;
            let request_id = replay_protection
                .get("request_id")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ProtocolError::ValidationFailed(
                        "canonical_payload_v2 requires payload.replay_protection.request_id".into(),
                    )
                })?;
            let expires_at = replay_protection
                .get("expires_at")
                .map(|value| {
                    value.as_i64().ok_or_else(|| {
                        ProtocolError::ValidationFailed(
                            "payload.replay_protection.expires_at must be a unix timestamp".into(),
                        )
                    })
                })
                .transpose()?;
            let signing_payload = serde_json::json!({
                "entry_id": payload.entry_id,
                "namespace": payload.namespace,
                "action": payload.action,
                "object_id": payload.object_id,
                "payload": payload.payload,
                "author": payload.author,
                "timestamp": payload.timestamp,
                "replay_protection": {
                    "request_id": request_id,
                    "expires_at": expires_at,
                }
            });
            Ok(canonical_json(&signing_payload))
        }
        _ => Err(ProtocolError::ValidationFailed(
            "unsupported signature_scope; expected canonical_payload_v1 or canonical_payload_v2"
                .into(),
        )),
    }
}

fn verify_signer_signature(
    signer: &str,
    signature_hex: &str,
    preimage: &str,
    payload: &LedgerEntry,
) -> Result<(), ProtocolError> {
    let verifying_key_hex = signer
            .strip_prefix("did:key:")
            .map(ToString::to_string)
            .or_else(|| {
                payload
                    .payload
                    .get("multisig_signer_keys")
                    .and_then(|value| value.as_object())
                    .and_then(|map| map.get(signer))
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
            })
            .ok_or_else(|| {
                ProtocolError::ValidationFailed(format!(
                    "unable to resolve verifying key for signer {signer}; use did:key or payload.multisig_signer_keys"
                ))
            })?;

    let verifying_key = parse_verifying_key(&verifying_key_hex).map_err(|err| {
        ProtocolError::ValidationFailed(format!("invalid verifying key for signer {signer}: {err}"))
    })?;
    let signature_bytes = hex::decode(signature_hex).map_err(|err| {
        ProtocolError::ValidationFailed(format!("invalid signature hex for signer {signer}: {err}"))
    })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|err| {
        ProtocolError::ValidationFailed(format!(
            "invalid signature bytes for signer {signer}: {err}"
        ))
    })?;
    if !verify_signature(&verifying_key, preimage.as_bytes(), &signature) {
        return Err(ProtocolError::ValidationFailed(format!(
            "signature verification failed for signer {signer}"
        )));
    }
    Ok(())
}

struct EnvelopeValidationResult {
    entry: LedgerEntry,
    outcome: String,
    multisig: Option<MultisigValidationSummary>,
}

fn validate_envelope_signatures(
    envelope: &SignedEnvelope<LedgerEntry>,
) -> Result<EnvelopeValidationResult, ProtocolError> {
    if envelope.signature.is_empty() {
        return Err(ProtocolError::ValidationFailed(
            "missing envelope signature".into(),
        ));
    }
    if envelope.signer != envelope.payload.author {
        return Err(ProtocolError::ValidationFailed(
            "envelope signer must match payload author".into(),
        ));
    }

    // Legacy single-signer path.
    if envelope.co_signatures.is_empty() {
        if !envelope.payload.signature.is_empty()
            && envelope.payload.signature != envelope.signature
        {
            return Err(ProtocolError::ValidationFailed(
                "envelope signature must match payload signature when both are present".into(),
            ));
        }
        let mut entry = envelope.payload.clone();
        if entry.signature.is_empty() {
            entry.signature = envelope.signature.clone();
        }
        return Ok(EnvelopeValidationResult {
            entry,
            outcome: "namespace rules accepted and finalized".to_string(),
            multisig: None,
        });
    }

    let policy = envelope.multisig_policy.as_ref().ok_or_else(|| {
        ProtocolError::ValidationFailed(
            "multisig_policy is required when co_signatures are present".into(),
        )
    })?;
    if policy.allowed_signers.is_empty() {
        return Err(ProtocolError::ValidationFailed(
            "multisig_policy.allowed_signers cannot be empty".into(),
        ));
    }
    if policy.threshold == 0 || usize::from(policy.threshold) > policy.allowed_signers.len() {
        return Err(ProtocolError::ValidationFailed(
            "multisig_policy.threshold must be between 1 and allowed_signers length".into(),
        ));
    }
    let signature_scope = envelope.signature_scope.as_deref().ok_or_else(|| {
        ProtocolError::ValidationFailed(
            "signature_scope is required when co_signatures are present".into(),
        )
    })?;
    let preimage = canonical_envelope_preimage(&envelope.payload, signature_scope)?;

    let mut unique_allowed: HashSet<String> = HashSet::new();
    for signer in &policy.allowed_signers {
        if !unique_allowed.insert(signer.clone()) {
            return Err(ProtocolError::ValidationFailed(
                "multisig_policy.allowed_signers must be unique".into(),
            ));
        }
    }

    let mut signed_by = Vec::with_capacity(envelope.co_signatures.len() + 1);
    let mut unique_signers = HashSet::new();
    let mut verify_and_track = |signer: &str, signature: &str| -> Result<(), ProtocolError> {
        if signature.is_empty() {
            return Err(ProtocolError::ValidationFailed(format!(
                "missing signature for signer {signer}"
            )));
        }
        if !unique_allowed.contains(signer) {
            return Err(ProtocolError::ValidationFailed(format!(
                "unauthorized signer {signer}; not in multisig_policy.allowed_signers"
            )));
        }
        if !unique_signers.insert(signer.to_string()) {
            return Err(ProtocolError::ValidationFailed(format!(
                "duplicate signer {signer} in envelope signatures"
            )));
        }
        verify_signer_signature(signer, signature, &preimage, &envelope.payload)?;
        signed_by.push(signer.to_string());
        Ok(())
    };

    verify_and_track(&envelope.signer, &envelope.signature)?;
    for item in &envelope.co_signatures {
        verify_and_track(&item.signer, &item.signature)?;
    }

    if signed_by.len() < usize::from(policy.threshold) {
        return Err(ProtocolError::ValidationFailed(format!(
            "multisig threshold not met: got {} unique signatures, need {}",
            signed_by.len(),
            policy.threshold
        )));
    }
    if policy.require_author_signature && !unique_signers.contains(&envelope.payload.author) {
        return Err(ProtocolError::ValidationFailed(
            "multisig author participation requirement not satisfied".into(),
        ));
    }

    let mut entry = envelope.payload.clone();
    if entry.signature.is_empty() {
        entry.signature = envelope.signature.clone();
    }
    Ok(EnvelopeValidationResult {
        entry,
        outcome: format!(
            "namespace rules accepted and finalized (multisig scope={signature_scope}, threshold={}, signers={})",
            policy.threshold,
            signed_by.join(",")
        ),
        multisig: Some(MultisigValidationSummary {
            signature_scope: signature_scope.to_string(),
            threshold: policy.threshold,
            signers: signed_by,
        }),
    })
}
