use chrono::Utc;
use citizen_network::{AdmissionControl, PeerHandshake};
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

#[tokio::test]
async fn admission_accepts_allowlisted_peer() {
    let admission = AdmissionControl::from_snapshot(build_snapshot(), Duration::from_secs(1));
    let handshake = PeerHandshake {
        validator_id: "validator.a".into(),
        public_key: "pk_a".into(),
        key_epoch: 0,
    };

    assert!(admission.allows(&handshake).await);
}

#[tokio::test]
async fn admission_rejects_unknown_peer() {
    let admission = AdmissionControl::from_snapshot(build_snapshot(), Duration::from_secs(1));
    let handshake = PeerHandshake {
        validator_id: "validator.unknown".into(),
        public_key: "pk_z".into(),
        key_epoch: 0,
    };

    assert!(!admission.allows(&handshake).await);
}

#[tokio::test]
async fn key_rotation_advances_epoch() {
    let admission = AdmissionControl::from_snapshot(build_snapshot(), Duration::from_millis(10));
    assert_eq!(0, admission.current_epoch().await);

    tokio::time::sleep(Duration::from_millis(15)).await;
    let rotated = admission.maybe_rotate().await;
    assert!(rotated >= 1);

    // Ensure subsequent calls without waiting do not double-rotate immediately
    let stable = admission.maybe_rotate().await;
    assert_eq!(rotated, stable);
}
