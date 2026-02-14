use axum::extract::Path;
use axum::http::StatusCode;
use axum::http::{HeaderMap, HeaderValue};
use axum::routing::{get, post};
use axum::{serve, Json, Router};
use chrono::Utc;
use citizen_crypto::hash_block_header;
use citizen_ledger::Ledger;
use citizen_storage::LedgerStorage;
use citizen_types::{
    Block, BlockHeader, BlockHeight, CommitProof, ConsentPolicyCheck, ConsentReceipt,
    DeterministicReceipt, DidDocument, DidStatus, FinalityProof, LedgerEntry, ProtocolError,
    ReceiptStatus, SignedEnvelope, ValidationSummary,
};
use serde::Serialize;
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
            auth_required: false,
            max_write_requests_per_minute: 120,
            clients: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
struct ApiEdgeState {
    config: ApiEdgeConfig,
    write_windows: Mutex<BTreeMap<String, Vec<i64>>>,
}

impl ApiEdgeState {
    fn new(config: ApiEdgeConfig) -> Self {
        Self {
            config,
            write_windows: Mutex::new(BTreeMap::new()),
        }
    }
}

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

impl<S: LedgerStorage + 'static> ApiServer<S> {
    pub fn new(ledger: Arc<Ledger<S>>) -> Self {
        Self::with_edge_config(ledger, ApiEdgeConfig::default())
    }

    pub fn with_edge_config(ledger: Arc<Ledger<S>>, edge_config: ApiEdgeConfig) -> Self {
        Self {
            ledger,
            edge: Arc::new(ApiEdgeState::new(edge_config)),
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

        let check = if latest.is_none() {
            ConsentPolicyCheck {
                valid: false,
                reason: Some("consent receipt not found on-chain".to_string()),
            }
        } else if receipt.expires_at <= now {
            ConsentPolicyCheck {
                valid: false,
                reason: Some("consent receipt expired".to_string()),
            }
        } else if latest
            .as_ref()
            .map(|entry| entry.action.as_str() == "CONSENT_REVOKED")
            .unwrap_or(false)
        {
            ConsentPolicyCheck {
                valid: false,
                reason: Some("consent receipt revoked".to_string()),
            }
        } else {
            ConsentPolicyCheck {
                valid: true,
                reason: None,
            }
        };
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

    async fn process_envelope_submission(
        ledger: Arc<Ledger<S>>,
        envelope: SignedEnvelope<LedgerEntry>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        if envelope.signature.is_empty() {
            return protocol_error_response(ProtocolError::ValidationFailed(
                "missing envelope signature".into(),
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
                "CREDIT_GRANT" => credited = credited.saturating_add(amount),
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
            headers
                .get("x-forwarded-for")
                .and_then(header_to_string)
                .unwrap_or_else(|| "anonymous".to_string())
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

fn header_to_string(value: &HeaderValue) -> Option<String> {
    value.to_str().ok().map(ToString::to_string)
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
    use citizen_crypto::KeyRegistry;
    use citizen_ledger::Ledger;
    use citizen_storage::MemoryStorage;
    use citizen_types::{
        LedgerEntry, NamespaceDescriptor, NamespaceRule, NamespaceRuleset, SignedEnvelope,
    };
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::collections::BTreeSet;
    use std::sync::Arc;
    use tower::util::ServiceExt;
    use uuid::Uuid;

    fn build_server() -> ApiServer<MemoryStorage> {
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
                config: json!({"max_daily_spend": 10_000}),
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
        ApiServer::with_edge_config(ledger, edge)
    }

    fn test_envelope() -> SignedEnvelope<LedgerEntry> {
        SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: "did:author:a".to_string(),
            signature: "sig-envelope".to_string(),
            submitted_at: chrono::Utc::now(),
            payload: LedgerEntry {
                entry_id: Uuid::new_v4(),
                namespace: "audit.procurement".to_string(),
                action: "RECORD_EVENT".to_string(),
                object_id: "PROC-001".to_string(),
                payload: json!({"event":"BID_OPENED"}),
                author: "did:author:a".to_string(),
                signature: "sig-entry".to_string(),
                timestamp: chrono::Utc::now().timestamp(),
            },
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
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();
        let identity_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "identity.citizen".to_string(),
            action: "REGISTER_IDENTITY".to_string(),
            object_id: "did:ledger:alice".to_string(),
            payload: json!({"claims_hash":"0xabc"}),
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
        let app = build_server().router();
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
        let app = build_server().router();
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
        let app = build_server().router();
        let now = chrono::Utc::now().timestamp();
        let grant_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "builder.credits".to_string(),
            action: "CREDIT_GRANT".to_string(),
            object_id: "builder:alpha".to_string(),
            payload: json!({"amount": 100_u64}),
            author: "governance:ops".to_string(),
            signature: "sig".to_string(),
            timestamp: now,
        };
        let sponsor_entry = LedgerEntry {
            entry_id: Uuid::new_v4(),
            namespace: "builder.credits".to_string(),
            action: "SPONSOR_USAGE".to_string(),
            object_id: "builder:alpha".to_string(),
            payload: json!({"amount": 30_u64, "sponsorship_id":"spn-1", "sponsored_did":"did:ledger:user1"}),
            author: "builder:alpha".to_string(),
            signature: "sig".to_string(),
            timestamp: now + 1,
        };

        for entry in [grant_entry, sponsor_entry] {
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
        assert_eq!(payload["instrumentation"]["unique_sponsorship_count"], 1);
    }

    #[tokio::test]
    async fn asset_positions_endpoint_returns_trustline_holdings_and_disclosure() {
        let app = build_server().router();
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
    async fn write_endpoints_require_api_key_when_auth_enabled() {
        let mut clients = BTreeMap::new();
        clients.insert(
            "writer-key".to_string(),
            ApiClientProfile::with_scopes(["entries.submit", "envelopes.submit"]),
        );
        let app = build_server_with_edge(ApiEdgeConfig {
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
}
