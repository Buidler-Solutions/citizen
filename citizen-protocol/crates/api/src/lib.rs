use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{serve, Json, Router};
use chrono::Utc;
use citizen_ledger::Ledger;
use citizen_storage::LedgerStorage;
use citizen_types::{
    BlockHeight, DeterministicReceipt, LedgerEntry, ProtocolError, ReceiptStatus, SignedEnvelope,
    ValidationSummary,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tracing::info;
use uuid::Uuid;

#[derive(Clone)]
pub struct ApiServer<S: LedgerStorage + 'static> {
    ledger: Arc<Ledger<S>>,
    receipts: Arc<RwLock<BTreeMap<Uuid, DeterministicReceipt>>>,
}

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

impl<S: LedgerStorage + 'static> ApiServer<S> {
    pub fn new(ledger: Arc<Ledger<S>>) -> Self {
        Self {
            ledger,
            receipts: Arc::new(RwLock::new(BTreeMap::new())),
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
        let submit_ledger = Arc::clone(&self.ledger);
        let submit_envelope_ledger = Arc::clone(&self.ledger);
        let submit_receipts = Arc::clone(&self.receipts);
        let submit_legacy_receipts = Arc::clone(&self.receipts);
        let get_receipt_store = Arc::clone(&self.receipts);

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
                "/api/v1/entries/submit",
                post(move |Json(entry): Json<LedgerEntry>| {
                    let ledger = Arc::clone(&submit_ledger);
                    let receipts = Arc::clone(&submit_legacy_receipts);
                    async move { Self::handle_submit_entry(ledger, receipts, entry).await }
                }),
            )
            .route(
                "/api/v1/envelopes/submit",
                post(move |Json(envelope): Json<SignedEnvelope<LedgerEntry>>| {
                    let ledger = Arc::clone(&submit_envelope_ledger);
                    let receipts = Arc::clone(&submit_receipts);
                    async move { Self::handle_submit_envelope(ledger, receipts, envelope).await }
                }),
            )
            .route(
                "/api/v1/receipts/:receipt_id",
                get(move |Path(receipt_id): Path<Uuid>| {
                    let receipts = Arc::clone(&get_receipt_store);
                    async move { Self::handle_get_receipt(receipts, receipt_id).await }
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
        receipts: Arc<RwLock<BTreeMap<Uuid, DeterministicReceipt>>>,
        entry: LedgerEntry,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let envelope = SignedEnvelope {
            envelope_id: Uuid::new_v4(),
            signer: entry.author.clone(),
            signature: entry.signature.clone(),
            submitted_at: Utc::now(),
            payload: entry,
        };
        Self::handle_submit_envelope(ledger, receipts, envelope).await
    }

    async fn handle_submit_envelope(
        ledger: Arc<Ledger<S>>,
        receipts: Arc<RwLock<BTreeMap<Uuid, DeterministicReceipt>>>,
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
        if let Err(err) = ledger.apply_entry(entry) {
            return protocol_error_response(err);
        }

        let receipt = DeterministicReceipt {
            receipt_id: Uuid::new_v4(),
            envelope_id: envelope.envelope_id,
            status: ReceiptStatus::Accepted,
            validation: ValidationSummary {
                namespace: namespace.clone(),
                action,
                outcome: "namespace rules accepted; pending block commit proof".into(),
            },
            finality: None,
            recorded_at: Utc::now(),
        };
        receipts
            .write()
            .await
            .insert(receipt.receipt_id, receipt.clone());

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
        receipts: Arc<RwLock<BTreeMap<Uuid, DeterministicReceipt>>>,
        receipt_id: Uuid,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let store = receipts.read().await;
        if let Some(receipt) = store.get(&receipt_id) {
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
