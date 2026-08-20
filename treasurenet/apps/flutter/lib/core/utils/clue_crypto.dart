import 'package:cryptography/cryptography.dart';

import 'hex_utils.dart';

/// Clue decryption for the encrypted clue store (gap 12 reader side).
///
/// The GM console encrypts clue plaintext in-browser with a fresh AES-GCM-256
/// key and wraps that key with HKDF-SHA256(manifest_id). This util reverses
/// the wrap + decrypt so players who unlocked a clue can read it. Byte-exact
/// parity with the browser scheme is pinned by clue_crypto_test.dart.
const _kdfSalt = 'treasurenet:clue-key-wrap';
const _kdfInfo = 'clue-aes-key';
const _gcmTagBytes = 16;

final _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
final _aesGcm = AesGcm.with256bits();

Future<List<int>> _deriveWrapKey(String manifestId) async {
  final derived = await _hkdf.deriveKey(
    secretKey: SecretKey(utf8Bytes(manifestId)),
    nonce: utf8Bytes(_kdfSalt),
    info: utf8Bytes(_kdfInfo),
  );
  return derived.extractBytes();
}

/// Unwraps the transport-wrapped clue key using the manifest id.
Future<List<int>> unwrapClueKey({
  required String manifestId,
  required String keyWrappedB64,
}) async {
  final wrapped = base64DecodeBytes(keyWrappedB64);
  final wrapKey = await _deriveWrapKey(manifestId);
  final cipherText = wrapped.sublist(0, wrapped.length - _gcmTagBytes);
  final mac = wrapped.sublist(wrapped.length - _gcmTagBytes);
  final clear = await _aesGcm.decrypt(
    SecretBox(cipherText, nonce: List<int>.filled(12, 0), mac: Mac(mac)),
    secretKey: SecretKey(wrapKey),
  );
  return clear;
}

/// Decrypts clue ciphertext with the unwrapped key (WebCrypto ciphertext
/// form: AES-GCM tag appended to the ciphertext).
Future<String> decryptClue({
  required String manifestId,
  required String keyWrappedB64,
  required String ivB64,
  required String ciphertextB64,
}) async {
  final clueKey = await unwrapClueKey(
    manifestId: manifestId,
    keyWrappedB64: keyWrappedB64,
  );
  final ciphertext = base64DecodeBytes(ciphertextB64);
  final cipherText = ciphertext.sublist(0, ciphertext.length - _gcmTagBytes);
  final mac = ciphertext.sublist(ciphertext.length - _gcmTagBytes);
  final clear = await _aesGcm.decrypt(
    SecretBox(cipherText, nonce: base64DecodeBytes(ivB64), mac: Mac(mac)),
    secretKey: SecretKey(clueKey),
  );
  return String.fromCharCodes(clear);
}
