use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use citizen_types::ProtocolError;
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

pub type Result<T> = std::result::Result<T, ProtocolError>;

pub fn generate_dek() -> [u8; 32] {
    let mut dek = [0u8; 32];
    OsRng.fill_bytes(&mut dek);
    dek
}

pub fn wrap_dek_for_reader(
    dek: &[u8],
    author_secret: &StaticSecret,
    reader_pubkey: &PublicKey,
) -> Result<String> {
    let shared_secret = author_secret.diffie_hellman(reader_pubkey);
    let key_material = Sha256::digest(shared_secret.as_bytes());
    let cipher = XChaCha20Poly1305::new_from_slice(&key_material)
        .map_err(|err| ProtocolError::crypto(format!("invalid wrap key material: {err}")))?;
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), dek)
        .map_err(|err| ProtocolError::crypto(format!("failed to wrap DEK: {err}")))?;

    let mut wrapped = Vec::with_capacity(24 + ciphertext.len());
    wrapped.extend_from_slice(&nonce);
    wrapped.extend_from_slice(&ciphertext);
    Ok(hex::encode(wrapped))
}

pub fn unwrap_dek_for_reader(
    wrapped_dek: &str,
    reader_secret: &StaticSecret,
    author_pubkey: &PublicKey,
) -> Result<[u8; 32]> {
    let wrapped = hex::decode(wrapped_dek)
        .map_err(|err| ProtocolError::crypto(format!("invalid wrapped DEK hex: {err}")))?;
    if wrapped.len() <= 24 {
        return Err(ProtocolError::crypto(
            "wrapped DEK must include nonce and ciphertext".to_string(),
        ));
    }
    let (nonce, ciphertext) = wrapped.split_at(24);
    let shared_secret = reader_secret.diffie_hellman(author_pubkey);
    let key_material = Sha256::digest(shared_secret.as_bytes());
    let cipher = XChaCha20Poly1305::new_from_slice(&key_material)
        .map_err(|err| ProtocolError::crypto(format!("invalid unwrap key material: {err}")))?;
    let dek = cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|err| ProtocolError::crypto(format!("failed to unwrap DEK: {err}")))?;
    let dek_len = dek.len();
    dek.try_into().map_err(|_| {
        ProtocolError::crypto(format!(
            "invalid DEK length after unwrap: expected 32 bytes, got {dek_len}"
        ))
    })
}
