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
#[tokio::test]
async fn admission_accepts_allowlisted_peer() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(None),
    );
    let handshake = PeerHandshake {
        validator_id: "validator.a".into(),
        public_key: "pk_a".into(),
        key_epoch: 0,
        network_id: "citizen-localnet".into(),
        genesis_hash: "genesis-hash".into(),
        manifest_digest: "manifest-digest".into(),
        nonce: 7,
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
        psk_proof: None,
    };

    assert!(admission.allows(&handshake).await);
}

#[tokio::test]
async fn admission_rejects_unknown_peer() {
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(),
        Duration::from_secs(1),
        test_identity(None),
    );
    let handshake = PeerHandshake {
        validator_id: "validator.unknown".into(),
        public_key: "pk_z".into(),
        key_epoch: 0,
        network_id: "citizen-localnet".into(),
        genesis_hash: "genesis-hash".into(),
        manifest_digest: "manifest-digest".into(),
        nonce: 7,
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
        psk_proof: None,
    };

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
