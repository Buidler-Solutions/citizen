use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{serve, Json, Router};
use chrono::Utc;
use citizen_crypto::hash_block_header;
use citizen_ledger::Ledger;
use citizen_storage::LedgerStorage;
use citizen_types::{
    Block, BlockHeader, BlockHeight, CommitProof, DeterministicReceipt, FinalityProof, LedgerEntry,
    ProtocolError, ReceiptStatus, SignedEnvelope, ValidationSummary,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
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
        if let Err(err) = ledger.apply_entry(entry.clone()) {
            return protocol_error_response(err);
        }

        let finality = match Self::finalize_entry(ledger, entry).await {
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
    use super::ApiServer;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use citizen_crypto::KeyRegistry;
    use citizen_ledger::Ledger;
    use citizen_storage::MemoryStorage;
    use citizen_types::{
        LedgerEntry, NamespaceDescriptor, NamespaceRule, NamespaceRuleset, SignedEnvelope,
    };
    use serde_json::{json, Value};
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
        ApiServer::new(ledger)
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
}
