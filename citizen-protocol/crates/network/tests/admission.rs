use blake3::Hasher;
use chrono::Utc;
use citizen_network::{AdmissionControl, HandshakeIdentity, PeerHandshake};
use citizen_types::{ValidatorMetadata, ValidatorSetSnapshot};
use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

#[derive(Serialize)]
struct HandshakeSigningPayload<'a> {
    validator_id: &'a str,
    public_key: &'a str,
    key_epoch: u64,
    network_id: &'a str,
    genesis_hash: &'a str,
    manifest_digest: &'a str,
    nonce: u64,
    timestamp_ms: u64,
    psk_proof: &'a Option<String>,
}

fn validator_signing_keys() -> HashMap<String, SigningKey> {
    let mut validators = HashMap::new();
    validators.insert(
        "validator.a".to_string(),
        SigningKey::from_bytes(&[1u8; 32]),
    );
    validators.insert(
        "validator.b".to_string(),
        SigningKey::from_bytes(&[2u8; 32]),
    );
    validators
}

fn build_snapshot(keys: &HashMap<String, SigningKey>) -> ValidatorSetSnapshot {
    let mut validators = BTreeMap::new();
    for (validator_id, signing_key) in keys {
        validators.insert(
            validator_id.clone(),
            ValidatorMetadata {
                validator_id: validator_id.clone(),
                public_key: hex::encode(signing_key.verifying_key().to_bytes()),
                anchors: vec!["test".into()],
                joined_at: Utc::now(),
                suspended: false,
            },
        );
    }

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

fn handshake_signature(handshake: &PeerHandshake, key: &SigningKey) -> String {
    let payload = bincode::serialize(&HandshakeSigningPayload {
        validator_id: &handshake.validator_id,
        public_key: &handshake.public_key,
        key_epoch: handshake.key_epoch,
        network_id: &handshake.network_id,
        genesis_hash: &handshake.genesis_hash,
        manifest_digest: &handshake.manifest_digest,
        nonce: handshake.nonce,
        timestamp_ms: handshake.timestamp_ms,
        psk_proof: &handshake.psk_proof,
    })
    .expect("handshake payload");
    hex::encode(key.sign(&payload).to_bytes())
}

fn handshake_with_overrides(
    validator_id: &str,
    public_key: &str,
    signing_key: &SigningKey,
    network_id: &str,
    genesis_hash: &str,
    manifest_digest: &str,
    nonce: u64,
    timestamp_ms: u64,
    psk_proof: Option<String>,
) -> PeerHandshake {
    let mut handshake = PeerHandshake {
        validator_id: validator_id.into(),
        public_key: public_key.into(),
        key_epoch: 0,
        network_id: network_id.into(),
        genesis_hash: genesis_hash.into(),
        manifest_digest: manifest_digest.into(),
        nonce,
        timestamp_ms,
        psk_proof,
        handshake_signature: String::new(),
    };
    handshake.handshake_signature = handshake_signature(&handshake, signing_key);
    handshake
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
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_secs(1),
        test_identity(None),
    );
    let key = keys.get("validator.a").unwrap();
    let public_key = hex::encode(key.verifying_key().to_bytes());
    let handshake = handshake_with_overrides(
        "validator.a",
        &public_key,
        key,
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
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_secs(1),
        test_identity(None),
    );
    let unknown_signing_key = SigningKey::from_bytes(&[9u8; 32]);
    let unknown_public_key = hex::encode(unknown_signing_key.verifying_key().to_bytes());
    let handshake = handshake_with_overrides(
        "validator.unknown",
        &unknown_public_key,
        &unknown_signing_key,
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
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_millis(10),
        test_identity(None),
    );
    assert_eq!(0, admission.current_epoch().await);

    tokio::time::sleep(Duration::from_millis(15)).await;
    let rotated = admission.maybe_rotate().await;
    assert!(rotated >= 1);

    let stable = admission.maybe_rotate().await;
    assert_eq!(rotated, stable);
}

#[tokio::test]
async fn admission_rejects_network_mismatch() {
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_secs(1),
        test_identity(None),
    );
    let key = keys.get("validator.a").unwrap();
    let public_key = hex::encode(key.verifying_key().to_bytes());
    let handshake = handshake_with_overrides(
        "validator.a",
        &public_key,
        key,
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
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_secs(1),
        test_identity(None),
    );
    let key = keys.get("validator.a").unwrap();
    let public_key = hex::encode(key.verifying_key().to_bytes());
    let handshake = handshake_with_overrides(
        "validator.a",
        &public_key,
        key,
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
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_secs(1),
        test_identity(None),
    );
    let key = keys.get("validator.a").unwrap();
    let public_key = hex::encode(key.verifying_key().to_bytes());
    let handshake = handshake_with_overrides(
        "validator.a",
        &public_key,
        key,
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
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_secs(1),
        test_identity(Some("shared-secret")),
    );
    let key = keys.get("validator.a").unwrap();
    let public_key = hex::encode(key.verifying_key().to_bytes());
    let handshake = handshake_with_overrides(
        "validator.a",
        &public_key,
        key,
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
    assert_eq!(
        metrics
            .handshake_reject_total_by_reason
            .get("invalid_psk_proof"),
        Some(&1)
    );
}

#[tokio::test]
async fn admission_rejects_replayed_nonce_timestamp() {
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_secs(1),
        test_identity(Some("shared-secret")),
    );
    let key = keys.get("validator.a").unwrap();
    let public_key = hex::encode(key.verifying_key().to_bytes());
    let timestamp_ms = current_timestamp_ms();
    let mut handshake = handshake_with_overrides(
        "validator.a",
        &public_key,
        key,
        "citizen-localnet",
        "genesis-hash",
        "manifest-digest",
        13,
        timestamp_ms,
        None,
    );
    handshake.psk_proof = Some(derive_psk_proof("shared-secret", &handshake));
    handshake.handshake_signature = handshake_signature(&handshake, key);

    assert!(admission.allows(&handshake).await);
    assert!(!admission.allows(&handshake).await);

    let metrics = admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
    assert_eq!(metrics.psk_challenge_fail_total, 0);
    assert_eq!(
        metrics
            .handshake_reject_total_by_reason
            .get("replay_detected"),
        Some(&1)
    );
}

#[tokio::test]
async fn admission_rejection_metrics_track_non_psk_failures() {
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_secs(1),
        test_identity(None),
    );
    let key = keys.get("validator.a").unwrap();
    let public_key = hex::encode(key.verifying_key().to_bytes());
    let handshake = handshake_with_overrides(
        "validator.a",
        &public_key,
        key,
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
    assert_eq!(
        metrics
            .handshake_reject_total_by_reason
            .get("network_identity_mismatch"),
        Some(&1)
    );
}

fn handshake_from_identity(
    validator_id: &str,
    signing_key: &SigningKey,
    identity: &HandshakeIdentity,
    nonce: u64,
) -> PeerHandshake {
    handshake_with_overrides(
        validator_id,
        &hex::encode(signing_key.verifying_key().to_bytes()),
        signing_key,
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
    let keys = validator_signing_keys();
    let snapshot = build_snapshot(&keys);
    let observer_identity = test_identity(None);
    let validator_identity = HandshakeIdentity {
        network_id: "citizen-othernet".into(),
        ..test_identity(None)
    };
    let observer_admission =
        AdmissionControl::from_snapshot(snapshot, Duration::from_secs(1), observer_identity);

    let key = keys.get("validator.a").unwrap();
    let handshake = handshake_from_identity("validator.a", key, &validator_identity, 301);

    let reason = observer_admission
        .check_handshake(&handshake)
        .await
        .expect_err("observer must reject network mismatch");
    assert_eq!(
        reason,
        citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch
    );

    let metrics = observer_admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
    assert_eq!(
        metrics
            .handshake_reject_total_by_reason
            .get("network_identity_mismatch"),
        Some(&1)
    );
}

#[tokio::test]
async fn observer_inbound_rejects_validator_manifest_digest_mismatch() {
    let keys = validator_signing_keys();
    let snapshot = build_snapshot(&keys);
    let observer_identity = test_identity(None);
    let validator_identity = HandshakeIdentity {
        manifest_digest: "manifest-other".into(),
        ..test_identity(None)
    };
    let observer_admission =
        AdmissionControl::from_snapshot(snapshot, Duration::from_secs(1), observer_identity);

    let key = keys.get("validator.a").unwrap();
    let handshake = handshake_from_identity("validator.a", key, &validator_identity, 302);

    let reason = observer_admission
        .check_handshake(&handshake)
        .await
        .expect_err("observer must reject manifest mismatch");
    assert_eq!(
        reason,
        citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch
    );

    let metrics = observer_admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
    assert_eq!(
        metrics
            .handshake_reject_total_by_reason
            .get("network_identity_mismatch"),
        Some(&1)
    );
}

#[tokio::test]
async fn validator_inbound_rejects_observer_invalid_identity_tuple() {
    let keys = validator_signing_keys();
    let snapshot = build_snapshot(&keys);
    let validator_admission =
        AdmissionControl::from_snapshot(snapshot, Duration::from_secs(1), test_identity(None));
    let observer_identity = HandshakeIdentity {
        network_id: "citizen-observer-othernet".into(),
        ..test_identity(None)
    };

    let key = keys.get("validator.b").unwrap();
    let handshake = handshake_from_identity("validator.b", key, &observer_identity, 303);

    let reason = validator_admission
        .check_handshake(&handshake)
        .await
        .expect_err("validator must reject observer invalid identity tuple");
    assert_eq!(
        reason,
        citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch
    );

    let metrics = validator_admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
}

#[tokio::test]
async fn observer_and_validator_share_identity_mismatch_rejection_matrix() {
    let keys = validator_signing_keys();
    let snapshot = build_snapshot(&keys);
    let observer_admission = AdmissionControl::from_snapshot(
        snapshot.clone(),
        Duration::from_secs(1),
        test_identity(None),
    );
    let validator_admission =
        AdmissionControl::from_snapshot(snapshot, Duration::from_secs(1), test_identity(None));

    let signer = keys.get("validator.a").expect("validator signing key");
    let cases = [
        (
            "network_id mismatch",
            HandshakeIdentity {
                network_id: "citizen-othernet".into(),
                ..test_identity(None)
            },
            citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch,
        ),
        (
            "genesis_hash mismatch",
            HandshakeIdentity {
                genesis_hash: "other-genesis".into(),
                ..test_identity(None)
            },
            citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch,
        ),
        (
            "manifest_digest mismatch",
            HandshakeIdentity {
                manifest_digest: "manifest-other".into(),
                ..test_identity(None)
            },
            citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch,
        ),
    ];

    for (index, (label, identity, expected_reason)) in cases.into_iter().enumerate() {
        let observer_handshake =
            handshake_from_identity("validator.a", signer, &identity, 400 + index as u64);
        let observer_reason = observer_admission
            .check_handshake(&observer_handshake)
            .await
            .expect_err("observer should reject mismatched identity");

        let validator_handshake =
            handshake_from_identity("validator.a", signer, &identity, 500 + index as u64);
        let validator_reason = validator_admission
            .check_handshake(&validator_handshake)
            .await
            .expect_err("validator should reject mismatched identity");

        assert_eq!(
            observer_reason, expected_reason,
            "observer reason mismatch for {label}"
        );
        assert_eq!(
            validator_reason, expected_reason,
            "validator reason mismatch for {label}"
        );
        assert_eq!(
            observer_reason, validator_reason,
            "roles diverged on rejection reason for {label}"
        );
    }
}

#[tokio::test]
async fn admission_rejects_invalid_handshake_signature() {
    let keys = validator_signing_keys();
    let admission = AdmissionControl::from_snapshot(
        build_snapshot(&keys),
        Duration::from_secs(1),
        test_identity(None),
    );
    let key = keys.get("validator.a").unwrap();
    let public_key = hex::encode(key.verifying_key().to_bytes());
    let mut handshake = handshake_with_overrides(
        "validator.a",
        &public_key,
        key,
        "citizen-localnet",
        "genesis-hash",
        "manifest-digest",
        999,
        current_timestamp_ms(),
        None,
    );
    handshake.handshake_signature = "00".repeat(64);

    let reason = admission
        .check_handshake(&handshake)
        .await
        .expect_err("invalid signature must be rejected");
    assert_eq!(
        reason,
        citizen_network::AdmissionRejectionReason::InvalidHandshakeSignature
    );

    let metrics = admission.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
    assert_eq!(
        metrics
            .handshake_reject_total_by_reason
            .get("invalid_handshake_signature"),
        Some(&1)
    );
}

#[tokio::test]
async fn identity_transition_rejects_pre_transition_handshake_tuple() {
    let keys = validator_signing_keys();
    let snapshot = build_snapshot(&keys);
    let signer = keys.get("validator.a").expect("validator signing key");

    let old_identity = HandshakeIdentity {
        network_id: "citizen-localnet-v1".into(),
        genesis_hash: "genesis-v1".into(),
        manifest_digest: "manifest-v1".into(),
        startup_secret: None,
        max_clock_skew: Duration::from_secs(30),
    };
    let transitioned_identity = HandshakeIdentity {
        network_id: "citizen-localnet-v2".into(),
        genesis_hash: "genesis-v2".into(),
        manifest_digest: "manifest-v2".into(),
        startup_secret: None,
        max_clock_skew: Duration::from_secs(30),
    };

    let admission_before_transition = AdmissionControl::from_snapshot(
        snapshot.clone(),
        Duration::from_secs(1),
        old_identity.clone(),
    );
    let admission_after_transition = AdmissionControl::from_snapshot(
        snapshot,
        Duration::from_secs(1),
        transitioned_identity.clone(),
    );

    let old_handshake = handshake_from_identity("validator.a", signer, &old_identity, 6_001);
    assert!(admission_before_transition.allows(&old_handshake).await);

    let post_transition_reason = admission_after_transition
        .check_handshake(&old_handshake)
        .await
        .expect_err("post-transition peers must reject pre-transition identity tuple");
    assert_eq!(
        post_transition_reason,
        citizen_network::AdmissionRejectionReason::NetworkIdentityMismatch
    );

    let transitioned_handshake =
        handshake_from_identity("validator.a", signer, &transitioned_identity, 6_002);
    assert!(
        admission_after_transition
            .allows(&transitioned_handshake)
            .await
    );

    let metrics = admission_after_transition.metrics_snapshot();
    assert_eq!(metrics.handshake_reject_total, 1);
    assert_eq!(
        metrics
            .handshake_reject_total_by_reason
            .get("network_identity_mismatch"),
        Some(&1)
    );
}
