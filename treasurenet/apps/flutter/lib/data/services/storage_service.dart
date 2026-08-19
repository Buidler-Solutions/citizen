import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Secure storage for the device key material plus session persistence.
///
/// The Ed25519 seed never leaves secure platform storage (iOS Keychain /
/// Android Keystore). The session token is a bearer credential stored in
/// shared preferences; the private key is never exposed to the network layer.
class StorageService {
  StorageService(this._secure, this._prefs);

  final FlutterSecureStorage _secure;
  final SharedPreferences _prefs;

  static const _seedKey = 'treasurenet.seed.hex';
  static const _didKey = 'treasurenet.did';
  static const _sessionTokenKey = 'treasurenet.session.token';
  static const _sessionDidKey = 'treasurenet.session.did';
  static const _sessionExpiryKey = 'treasurenet.session.expiry';

  Future<String?> readSeedHex() => _secure.read(key: _seedKey);

  Future<String?> readDid() => _secure.read(key: _didKey);

  Future<void> writeIdentity({
    required String seedHex,
    required String did,
  }) async {
    await _secure.write(key: _seedKey, value: seedHex);
    await _secure.write(key: _didKey, value: did);
  }

  Future<void> clearIdentity() async {
    await _secure.delete(key: _seedKey);
    await _secure.delete(key: _didKey);
    await clearSession();
  }

  Future<void> writeSession({
    required String token,
    required String did,
    required DateTime expiresAt,
  }) async {
    await _prefs.setString(_sessionTokenKey, token);
    await _prefs.setString(_sessionDidKey, did);
    await _prefs.setInt(_sessionExpiryKey, expiresAt.millisecondsSinceEpoch);
  }

  StoredSession? readSession() {
    final token = _prefs.getString(_sessionTokenKey);
    final did = _prefs.getString(_sessionDidKey);
    final expiryMillis = _prefs.getInt(_sessionExpiryKey);
    if (token == null || did == null || expiryMillis == null) return null;
    final expiresAt = DateTime.fromMillisecondsSinceEpoch(expiryMillis);
    if (expiresAt.isBefore(DateTime.now())) return null;
    return StoredSession(token: token, did: did, expiresAt: expiresAt);
  }

  Future<void> clearSession() async {
    await _prefs.remove(_sessionTokenKey);
    await _prefs.remove(_sessionDidKey);
    await _prefs.remove(_sessionExpiryKey);
  }
}

class StoredSession {
  const StoredSession({
    required this.token,
    required this.did,
    required this.expiresAt,
  });

  final String token;
  final String did;
  final DateTime expiresAt;
}
