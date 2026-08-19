import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/services/api_service.dart';
import '../data/services/crypto_service.dart';
import '../data/services/storage_service.dart';

/// Session lifecycle: device identity bootstrap, challenge-response login,
/// and logout. The Ed25519 seed is generated on device and never leaves
/// secure storage; the backend only ever sees the DID and signatures.
enum AuthStatus { loading, needsIdentity, needsLogin, authenticated }

@immutable
class AuthState {
  const AuthState({
    required this.status,
    this.did,
    this.seedHex,
    this.error,
  });

  final AuthStatus status;
  final String? did;
  final String? seedHex;
  final String? error;

  AuthState copyWith({
    AuthStatus? status,
    String? did,
    String? seedHex,
    String? error,
  }) =>
      AuthState(
        status: status ?? this.status,
        did: did ?? this.did,
        seedHex: seedHex ?? this.seedHex,
        error: error,
      );
}

class SessionController extends StateNotifier<AuthState> {
  SessionController(this._storage)
      : super(const AuthState(status: AuthStatus.loading)) {
    _bootstrap();
  }

  final StorageService _storage;

  TreasurenetApi? _api;
  String? _sessionToken;

  TreasurenetApi get api =>
      _api ??= TreasurenetApi(sessionToken: _sessionToken);

  Future<void> _bootstrap() async {
    final seedHex = await _storage.readSeedHex();
    final did = await _storage.readDid();
    if (seedHex == null || did == null) {
      state = const AuthState(status: AuthStatus.needsIdentity);
      return;
    }
    final session = _storage.readSession();
    if (session == null) {
      state = AuthState(
        status: AuthStatus.needsLogin,
        did: did,
        seedHex: seedHex,
      );
      return;
    }
    _sessionToken = session.token;
    state = AuthState(
      status: AuthStatus.authenticated,
      did: did,
      seedHex: seedHex,
    );
  }

  /// Onboarding: generate a device keypair and register the wallet DID.
  Future<void> createIdentity() async {
    try {
      final identity = await DeviceCryptoService.instance.generateIdentity();
      await _storage.writeIdentity(
        seedHex: identity.seedHex,
        did: identity.did,
      );
      await api.registerWallet(identity.did);
      state = AuthState(
        status: AuthStatus.needsLogin,
        did: identity.did,
        seedHex: identity.seedHex,
      );
    } catch (error) {
      state = state.copyWith(error: 'identity creation failed: $error');
    }
  }

  /// Challenge-response login: sign `treasurenet-login:<nonce>` on device.
  Future<void> login() async {
    final did = state.did;
    final seedHex = state.seedHex;
    if (did == null || seedHex == null) return;
    try {
      final challenge = await api.requestChallenge(did);
      final signature = await DeviceCryptoService.instance
          .signMessage(challenge.message, seedHex);
      final token = await api.verifyChallenge(did: did, signatureHex: signature);
      await _storage.writeSession(
        token: token,
        did: did,
        expiresAt: DateTime.now().add(const Duration(hours: 12)),
      );
      _sessionToken = token;
      api.updateSession(token);
      state = AuthState(
        status: AuthStatus.authenticated,
        did: did,
        seedHex: seedHex,
      );
    } catch (error) {
      state = state.copyWith(error: 'login failed: ${toApiException(error)}');
    }
  }

  Future<void> logout() async {
    await _storage.clearSession();
    _sessionToken = null;
    api.updateSession(null);
    state = AuthState(
      status: AuthStatus.needsLogin,
      did: state.did,
      seedHex: state.seedHex,
    );
  }
}

/// Overridden in main() once platform storage is initialized.
final storageProvider = Provider<StorageService>((ref) {
  throw UnimplementedError('storageProvider must be overridden in main');
});

final sessionProvider =
    StateNotifierProvider<SessionController, AuthState>((ref) {
  return SessionController(ref.watch(storageProvider));
});
