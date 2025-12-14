use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use citizen_ledger::Ledger;
use citizen_storage::LedgerStorage;
use citizen_types::BlockHeight;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tracing::info;

#[derive(Clone)]
struct ApiState<S: LedgerStorage + 'static> {
    ledger: Arc<Ledger<S>>,
}

#[derive(Clone)]
pub struct ApiServer<S: LedgerStorage + 'static> {
    ledger: Arc<Ledger<S>>,
}

impl<S: LedgerStorage + 'static> ApiServer<S> {
    pub fn new(ledger: Arc<Ledger<S>>) -> Self {
        Self { ledger }
    }

    pub async fn serve(self, addr: SocketAddr) -> JoinHandle<()> {
        let router = self.router();
        info!(%addr, "starting API server");
        tokio::spawn(async move {
            if let Err(err) = axum::Server::bind(&addr)
                .serve(router.into_make_service())
                .await
            {
                tracing::error!(?err, "api server error");
            }
        })
    }

    fn router(&self) -> Router<ApiState<S>> {
        Router::new()
            .route("/health", get(Self::health::<S>))
            .route("/blocks/:height", get(Self::get_block::<S>))
            .route("/namespaces", get(Self::list_namespaces::<S>))
            .route("/entries/:namespace", get(Self::list_entries::<S>))
            .with_state(ApiState {
                ledger: self.ledger.clone(),
            })
    }

    async fn health<T: LedgerStorage + 'static>() -> Json<serde_json::Value> {
        Json(serde_json::json!({"status": "ok"}))
    }

    async fn get_block<T: LedgerStorage + 'static>(
        State(state): State<ApiState<T>>,
        Path(height): Path<BlockHeight>,
    ) -> Json<serde_json::Value> {
        let block = state.ledger.storage().get_block(height).unwrap_or(None);
        Json(serde_json::json!({"height": height, "block": block}))
    }

    async fn list_namespaces<T: LedgerStorage + 'static>(
        State(state): State<ApiState<T>>,
    ) -> Json<serde_json::Value> {
        let namespaces = state
            .ledger
            .storage()
            .namespace_registry()
            .unwrap_or_default();
        Json(serde_json::json!({"namespaces": namespaces}))
    }

    async fn list_entries<T: LedgerStorage + 'static>(
        State(state): State<ApiState<T>>,
        Path(namespace): Path<String>,
    ) -> Json<serde_json::Value> {
        let entries = state
            .ledger
            .storage()
            .namespace_entries(&namespace)
            .unwrap_or_default();
        Json(serde_json::json!({"namespace": namespace, "entries": entries}))
    }
}
