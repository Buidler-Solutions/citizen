use blake3::Hasher;
use chrono::Utc;
use citizen_network::{AdmissionControl, HandshakeIdentity, PeerHandshake};
use citizen_types::{ValidatorMetadata, ValidatorSetSnapshot};
use std::collections::BTreeMap;
use std::time::Duration;

fn build_snapshot() -> ValidatorSetSnapshot {
    let mut validators = BTreeMap::new();
    validators.insert(
        "validator.a".into(),
        ValidatorMetadata {
            validator_id: "validator.a".into(),
            public_key: "pk_a".into(),
            anchors: vec!["test".into()],
            joined_at: Utc::now(),
            suspended: false,
        },
    );
    validators.insert(
        "validator.b".into(),
        ValidatorMetadata {
            validator_id: "validator.b".into(),
            public_key: "pk_b".into(),
            anchors: vec!["test".into()],
            joined_at: Utc::now(),
            suspended: false,
        },
    );

    ValidatorSetSnapshot {
        height: 1,
        validators,
        quorum_bps: 8000,
    }
}

fn test_identity(startup_secret: Option<&str>) -> HandshakeIdentity {
    HandshakeIdentity {
        network_id: "citizen-localnet".into(),
        genesis_hash: "genesis-hash".into(),
        manifest_digest: "manifest-digest".into(),
        startup_secret: startup_secret.map(str::to_string),
        max_clock_skew: Duration::from_secs(30),
    }
}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64
}

fn handshake_with_overrides(
    validator_id: &str,
    public_key: &str,
    network_id: &str,
    genesis_hash: &str,
    manifest_digest: &str,
    nonce: u64,
    timestamp_ms: u64,
    psk_proof: Option<String>,
) -> PeerHandshake {
    PeerHandshake {
        validator_id: validator_id.into(),
        public_key: public_key.into(),
        key_epoch: 0,
        network_id: network_id.into(),
        genesis_hash: genesis_hash.into(),
        manifest_digest: manifest_digest.into(),
        nonce,
        timestamp_ms,
        psk_proof,
    }
}

fn derive_psk_proof(secret: &str, handshake: &PeerHandshake) -> String {
    let mut hasher = Hasher::new();
    hasher.update(secret.as_bytes());
    hasher.update(handshake.validator_id.as_bytes());
    hasher.update(handshake.public_key.as_bytes());
    hasher.update(handshake.network_id.as_bytes());
    hasher.update(handshake.genesis_hash.as_bytes());
    hasher.update(handshake.manifest_digest.as_bytes());
    hasher.update(&handshake.key_epoch.to_le_bytes());
    hasher.update(&handshake.nonce.to_le_bytes());
    hasher.update(&handshake.timestamp_ms.to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

#[tokio::test]
async fn admission_accepts_allowlisted_peer() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(None),
    );
    let handshake = handshake_with_overrides(
        "validator.a",
        "pk_a",
        "citizen-localnet",
        "genesis-hash",
        "manifest-digest",
        7,
        current_timestamp_ms(),
        None,
    );

    assert!(admission.allows(&handshake).await);
}

#[tokio::test]
async fn admission_rejects_unknown_peer() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(None),
    );
    let handshake = handshake_with_overrides(
        "validator.unknown",
        "pk_z",
        "citizen-localnet",
        "genesis-hash",
        "manifest-digest",
        7,
        current_timestamp_ms(),
        None,
    );

    assert!(!admission.allows(&handshake).await);
}

#[tokio::test]
async fn key_rotation_advances_epoch() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_millis(10),
        test_identity(None),
    );
    assert_eq!(0, admission.current_epoch().await);

    tokio::time::sleep(Duration::from_millis(15)).await;
    let rotated = admission.maybe_rotate().await;
    assert!(rotated >= 1);

    // Ensure subsequent calls without waiting do not double-rotate immediately
    let stable = admission.maybe_rotate().await;
    assert_eq!(rotated, stable);
}

#[tokio::test]
async fn admission_rejects_network_mismatch() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(None),
    );
    let handshake = handshake_with_overrides(
        "validator.a",
        "pk_a",
        "citizen-othernet",
        "genesis-hash",
        "manifest-digest",
        9,
        current_timestamp_ms(),
        None,
    );

    assert!(!admission.allows(&handshake).await);
}

#[tokio::test]
async fn admission_rejects_genesis_mismatch() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(None),
    );
    let handshake = handshake_with_overrides(
        "validator.a",
        "pk_a",
        "citizen-localnet",
        "other-genesis",
        "manifest-digest",
        10,
        current_timestamp_ms(),
        None,
    );

    assert!(!admission.allows(&handshake).await);
}

#[tokio::test]
async fn admission_rejects_manifest_digest_mismatch() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(None),
    );
    let handshake = handshake_with_overrides(
        "validator.a",
        "pk_a",
        "citizen-localnet",
        "genesis-hash",
        "other-manifest",
        11,
        current_timestamp_ms(),
        None,
    );

    assert!(!admission.allows(&handshake).await);
}

#[tokio::test]
async fn admission_rejects_invalid_psk_proof() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(Some("shared-secret")),
    );
    let handshake = handshake_with_overrides(
        "validator.a",
        "pk_a",
        "citizen-localnet",
        "genesis-hash",
        "manifest-digest",
        12,
        current_timestamp_ms(),
        Some("invalid-proof".to_string()),
    );

    assert!(!admission.allows(&handshake).await);
    let metrics = admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
    assert_eq!(metrics.psk_challenge_fail_total, 1);
}

#[tokio::test]
async fn admission_rejects_replayed_nonce_timestamp() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(Some("shared-secret")),
    );
    let timestamp_ms = current_timestamp_ms();
    let mut handshake = handshake_with_overrides(
        "validator.a",
        "pk_a",
        "citizen-localnet",
        "genesis-hash",
        "manifest-digest",
        13,
        timestamp_ms,
        None,
    );
    handshake.psk_proof = Some(derive_psk_proof("shared-secret", &handshake));

    assert!(admission.allows(&handshake).await);
    assert!(!admission.allows(&handshake).await);

    let metrics = admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
    assert_eq!(metrics.psk_challenge_fail_total, 0);
}

#[tokio::test]
async fn admission_rejection_metrics_track_non_psk_failures() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(None),
    );
    let handshake = handshake_with_overrides(
        "validator.a",
        "pk_a",
        "citizen-othernet",
        "genesis-hash",
        "manifest-digest",
        88,
        current_timestamp_ms(),
        None,
    );

    assert!(!admission.allows(&handshake).await);

    let metrics = admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
    assert_eq!(metrics.psk_challenge_fail_total, 0);
}

fn handshake_from_identity(
    validator_id: &str,
    public_key: &str,
    identity: &HandshakeIdentity,
    nonce: u64,
) -> PeerHandshake {
    handshake_with_overrides(
        validator_id,
        public_key,
        &identity.network_id,
        &identity.genesis_hash,
        &identity.manifest_digest,
        nonce,
        current_timestamp_ms(),
        None,
    )
}

#[tokio::test]
async fn observer_inbound_rejects_validator_network_identity_mismatch() {
    let snapshot = build_snapshot();
    let observer_identity = test_identity(None);
    let validator_identity = HandshakeIdentity {
        network_id: "citizen-othernet".into(),
        ..test_identity(None)
    };
    let observer_admission = AdmissionControl::from_snapshot(
        snapshot,
        Duration::from_secs(1),
        observer_identity,
    );

    let handshake = handshake_from_identity("validator.a", "pk_a", &validator_identity, 301);

    let reason = observer_admission
        .check_handshake(&handshake)
        .await
        .expect_err("observer must reject network mismatch");
    assert_eq!(reason, citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch);

    let metrics = observer_admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
}

#[tokio::test]
async fn observer_inbound_rejects_validator_manifest_digest_mismatch() {
    let snapshot = build_snapshot();
    let observer_identity = test_identity(None);
    let validator_identity = HandshakeIdentity {
        manifest_digest: "manifest-other".into(),
        ..test_identity(None)
    };
    let observer_admission = AdmissionControl::from_snapshot(
        snapshot,
        Duration::from_secs(1),
        observer_identity,
    );

    let handshake = handshake_from_identity("validator.a", "pk_a", &validator_identity, 302);

    let reason = observer_admission
        .check_handshake(&handshake)
        .await
        .expect_err("observer must reject manifest mismatch");
    assert_eq!(reason, citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch);

    let metrics = observer_admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
}

#[tokio::test]
async fn validator_inbound_rejects_observer_invalid_identity_tuple() {
    let snapshot = build_snapshot();
    let validator_admission = AdmissionControl::from_snapshot(
        snapshot,
        Duration::from_secs(1),
        test_identity(None),
    );
    let observer_identity = HandshakeIdentity {
        network_id: "citizen-observer-othernet".into(),
        ..test_identity(None)
    };

    let handshake = handshake_from_identity("validator.b", "pk_b", &observer_identity, 303);

    let reason = validator_admission
        .check_handshake(&handshake)
        .await
        .expect_err("validator must reject observer invalid identity tuple");
    assert_eq!(reason, citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch);

    let metrics = validator_admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
}
