use axum::extract::Path;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{serve, Json, Router};
use chrono::Utc;
use citizen_crypto::{canonical_json, hash_block_header, sha256_hex};
use citizen_ledger::Ledger;
use citizen_storage::LedgerStorage;
use citizen_types::{
    Block, BlockHeader, BlockHeight, CommitProof, ConsentPolicyCheck, ConsentReceipt,
    DeterministicReceipt, DidDocument, DidStatus, FinalityProof, LedgerEntry, NamespaceRuleset,
    ProtocolError, ReceiptStatus, SignedEnvelope, ValidationSummary,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
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
    pub clients: BTreeMap<String, ApiClientProfile>,
}

#[derive(Clone, Debug)]
pub struct ApiClientProfile {
    pub scopes: BTreeSet<String>,
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
    file_commit_idempotency: Mutex<BTreeMap<String, serde_json::Value>>,
    payload_commit_idempotency: Mutex<BTreeMap<String, serde_json::Value>>,
    file_manifests: Mutex<BTreeMap<String, StoredFileManifest>>,
    payload_field_refs: Mutex<BTreeMap<String, EncryptedFieldRef>>,
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

#[derive(Clone, Debug, Deserialize)]
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
}

#[derive(Clone, Debug, Deserialize)]
struct PayloadCommitRequest {
    namespace: String,
    object_id: String,
    author_did: String,
    #[serde(default = "default_payload_policy_version")]
    policy_version: u32,
    consent_receipt: ConsentReceipt,
    encrypted_field_refs: Vec<EncryptedFieldRef>,
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
        let namespaces_ledger = Arc::clone(&self.ledger);
        let entries_ledger = Arc::clone(&self.ledger);
        let resolve_did_ledger = Arc::clone(&self.ledger);
        let consent_check_ledger = Arc::clone(&self.ledger);
        let submit_ledger = Arc::clone(&self.ledger);
        let submit_edge = Arc::clone(&self.edge);
        let submit_envelope_ledger = Arc::clone(&self.ledger);
        let submit_envelope_edge = Arc::clone(&self.edge);
        let file_intent_ledger = Arc::clone(&self.ledger);
        let file_intent_edge = Arc::clone(&self.edge);
        let file_commit_ledger = Arc::clone(&self.ledger);
        let file_commit_edge = Arc::clone(&self.edge);
        let payload_commit_ledger = Arc::clone(&self.ledger);
        let payload_commit_edge = Arc::clone(&self.edge);
        let file_read_ledger = Arc::clone(&self.ledger);
        let file_read_edge = Arc::clone(&self.edge);
        let get_receipt_ledger = Arc::clone(&self.ledger);
        let builder_credits_ledger = Arc::clone(&self.ledger);
        let asset_positions_ledger = Arc::clone(&self.ledger);
        let module_runtime_ledger = Arc::clone(&self.ledger);
        let interop_status_ledger = Arc::clone(&self.ledger);
        Router::new()
            .route("/health", get(Self::health))
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
                        let edge = Arc::clone(&payload_commit_edge);
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
                "/api/v1/interop/:object_id",
                get(move |Path(object_id): Path<String>| {
                    let ledger = Arc::clone(&interop_status_ledger);
                    async move { Self::handle_get_interop_status(ledger, object_id).await }
                }),
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
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: entry.author.clone(),
            signature: entry.signature.clone(),
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
        if let Err(response) = Self::authorize_write(edge, &headers, "envelopes.submit").await {
            return response;
        }
        Self::process_envelope_submission(ledger, envelope).await
    }

    async fn handle_create_file_intent(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        request: FileIntentRequest,
    ) -> (StatusCode, Json<serde_json::Value>) {
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
        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "files.commit").await
        {
            return response;
        }

        let idempotency_key = match Self::required_idempotency_key(&headers) {
            Ok(key) => key,
            Err(response) => return response,
        };

        if let Some(cached) = edge
            .file_commit_idempotency
            .lock()
            .await
            .get(&idempotency_key)
            .cloned()
        {
            return (StatusCode::OK, Json(cached));
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
        edge.file_commit_idempotency
            .lock()
            .await
            .insert(idempotency_key, response.clone());

        (StatusCode::ACCEPTED, Json(response))
    }

    async fn handle_commit_payload(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        request: PayloadCommitRequest,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if let Err(response) =
            Self::authorize_write(Arc::clone(&edge), &headers, "payloads.commit").await
        {
            return response;
        }

        let idempotency_key = match Self::required_idempotency_key(&headers) {
            Ok(key) => key,
            Err(response) => return response,
        };

        if let Some(cached) = edge
            .payload_commit_idempotency
            .lock()
            .await
            .get(&idempotency_key)
            .cloned()
        {
            return (StatusCode::OK, Json(cached));
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

        let entry_id = request.envelope.payload.entry_id;
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
            "encrypted_field_refs": request.encrypted_field_refs,
            "result": base,
        });
        edge.payload_commit_idempotency
            .lock()
            .await
            .insert(idempotency_key, response.clone());

        (StatusCode::ACCEPTED, Json(response))
    }

    async fn handle_read_file(
        ledger: Arc<Ledger<S>>,
        edge: Arc<ApiEdgeState>,
        headers: HeaderMap,
        request: FileReadRequest,
    ) -> (StatusCode, Json<serde_json::Value>) {
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
        if envelope.signature.is_empty() {
            return protocol_error_response(ProtocolError::ValidationFailed(
                "missing envelope signature".into(),
            ));
        }

        if envelope.signer != envelope.payload.author {
            return protocol_error_response(ProtocolError::ValidationFailed(
                "envelope signer must match payload author".into(),
            ));
        }

        if !envelope.payload.signature.is_empty()
            && envelope.payload.signature != envelope.signature
        {
            return protocol_error_response(ProtocolError::ValidationFailed(
                "envelope signature must match payload signature when both are present".into(),
            ));
        }

        let action = envelope.payload.action.clone();
        let mut entry = envelope.payload;
        if entry.signature.is_empty() {
            entry.signature = envelope.signature.clone();
        }

        if let Err(err) = ledger.validate_entry_submission(&entry) {
            return protocol_error_response(err);
        }

        let entry_id = entry.entry_id;
        let namespace = entry.namespace.clone();
        if let Err(err) = ledger.apply_entry(entry.clone()) {
            return protocol_error_response(err);
        }

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
                outcome: "namespace rules accepted and finalized".into(),
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
        let block = Block {
            header: BlockHeader {
                height: next_height,
                prev_hash,
                entry_root: format!("entry:{}", entry.entry_id),
                proposer: "local-validator".to_string(),
                timestamp: Utc::now().timestamp(),
                commit_proof: commit_proof.clone(),
            },
            entries: vec![entry],
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
        if !edge.config.write_enabled {
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
        Ok(())
    }
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

#[cfg(test)]
mod tests {
    use super::{ApiClientProfile, ApiEdgeConfig, ApiServer};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use citizen_crypto::{sign_message, verifying_key_to_string, KeyRegistry, ValidatorKeypair};
    use citizen_ledger::Ledger;
    use citizen_storage::MemoryStorage;
    use citizen_types::{
        LedgerEntry, NamespaceDescriptor, NamespaceRule, NamespaceRuleset, SignedEnvelope,
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
                            "allowed_mime_types": ["application/pdf", "application/json"],
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
        ApiServer::new(ledger)
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
            submitted_at: chrono::Utc::now(),
            payload,
        }
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

        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
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
                "audit_hash": "audit:abc"
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
    async fn unauthenticated_rate_limits_are_not_bypassable_via_forwarded_for_header() {
        let app = build_server_with_edge(ApiEdgeConfig {
            write_enabled: true,
            auth_required: false,
            max_write_requests_per_minute: 1,
            clients: BTreeMap::new(),
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
            clients,
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
            clients,
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
            clients,
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
            clients,
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

        let read_response = app.oneshot(Request::builder().method("POST").uri("/api/v1/files/read").header("content-type", "application/json").body(Body::from(serde_json::to_vec(&json!({"manifest_id":commit_payload["manifest_id"],"reader_did":"did:reader:1","consent_receipt":{"subject_did":"did:citizen:holder-1","data_hash":"sha256:file-revoke-read","policy_ref":"policy:offchain:v1","granted_at":now,"expires_at":now+3600,"authorized_readers":["did:reader:1"]}})).expect("read"))).expect("request")).await.expect("read response");
        assert_eq!(read_response.status(), StatusCode::FORBIDDEN);
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
            clients,
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
}
