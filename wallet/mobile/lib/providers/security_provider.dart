import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';

import '../data/services/crypto_service.dart';
import '../data/services/storage_service.dart';
import 'service_providers.dart';

class SecurityState {
  final bool hasPassword;
  final bool isUnlocked;
  final bool biometricEnabled;
  final bool biometricAvailable;
  final String? error;

  const SecurityState({
    this.hasPassword = false,
    this.isUnlocked = false,
    this.biometricEnabled = false,
    this.biometricAvailable = false,
    this.error,
  });

  SecurityState copyWith({
    bool? hasPassword,
    bool? isUnlocked,
    bool? biometricEnabled,
    bool? biometricAvailable,
    String? error,
  }) {
    return SecurityState(
      hasPassword: hasPassword ?? this.hasPassword,
      isUnlocked: isUnlocked ?? this.isUnlocked,
      biometricEnabled: biometricEnabled ?? this.biometricEnabled,
      biometricAvailable: biometricAvailable ?? this.biometricAvailable,
      error: error,
    );
  }
}

class SecurityNotifier extends StateNotifier<SecurityState> {
  final StorageService _storage;
  final CryptoService _crypto;
  final LocalAuthentication _localAuth = LocalAuthentication();

  SecurityNotifier(this._storage, this._crypto) : super(const SecurityState());

  Future<void> initialize() async {
    final hash = await _storage.getPasswordHash();
    final hasPassword = hash != null && hash.isNotEmpty;
    final isUnlocked = !hasPassword || _storage.isUnlocked;
    final biometricEnabled = await _storage.isBiometricEnabled();
    final biometricAvailable = await _localAuth.isDeviceSupported();

    state = SecurityState(
      hasPassword: hasPassword,
      isUnlocked: isUnlocked,
      biometricEnabled: biometricEnabled,
      biometricAvailable: biometricAvailable,
    );
  }

  Future<bool> setPassword(String password) async {
    if (password.length < 8) {
      state = state.copyWith(error: 'Password must be at least 8 characters.');
      return false;
    }
    final hash = await _crypto.sha256Hex(password);
    await _storage.setPasswordHash(hash);
    _storage.markUnlocked();

    final bioAvailable = await _localAuth.isDeviceSupported();
    state = SecurityState(
      hasPassword: true,
      isUnlocked: true,
      biometricAvailable: bioAvailable,
    );
    return true;
  }

  Future<bool> unlock(String password) async {
    final storedHash = await _storage.getPasswordHash();
    if (storedHash == null) {
      state = state.copyWith(error: 'No password configured.');
      return false;
    }
    final inputHash = await _crypto.sha256Hex(password);
    if (inputHash != storedHash) {
      _storage.markLocked();
      state = state.copyWith(isUnlocked: false, error: 'Invalid password.');
      return false;
    }
    _storage.markUnlocked();
    state = state.copyWith(hasPassword: true, isUnlocked: true, error: null);
    return true;
  }

  /// Authenticate using device biometrics (fingerprint / face).
  /// Returns true if authentication succeeded.
  Future<bool> unlockWithBiometrics() async {
    if (!state.biometricEnabled) {
      state = state.copyWith(error: 'Biometric unlock is not enabled.');
      return false;
    }
    if (!state.biometricAvailable) {
      state = state.copyWith(error: 'Biometric authentication is not available on this device.');
      return false;
    }
    try {
      final authenticated = await _localAuth.authenticate(
        localizedReason: 'Authenticate to unlock your Citizen wallet',
        options: const AuthenticationOptions(
          stickyAuth: true,
          biometricOnly: true,
        ),
      );
      if (authenticated) {
        _storage.markUnlocked();
        state = state.copyWith(isUnlocked: true, error: null);
        return true;
      }
      state = state.copyWith(error: 'Biometric authentication failed.');
      return false;
    } catch (e) {
      state = state.copyWith(error: 'Biometric error: $e');
      return false;
    }
  }

  /// Enable biometric unlock for future sessions.
  Future<void> enableBiometrics() async {
    await _storage.setBiometricEnabled(true);
    state = state.copyWith(biometricEnabled: true, error: null);
  }

  /// Disable biometric unlock.
  Future<void> disableBiometrics() async {
    await _storage.setBiometricEnabled(false);
    state = state.copyWith(biometricEnabled: false, error: null);
  }

  void lock() {
    _storage.markLocked();
    state = state.copyWith(isUnlocked: false);
  }

  Future<void> removePassword() async {
    await _storage.deletePassword();
    await _storage.setBiometricEnabled(false);
    _storage.markLocked();
    state = const SecurityState(
      hasPassword: false,
      isUnlocked: false,
      biometricEnabled: false,
    );
  }
}

final securityProvider = StateNotifierProvider<SecurityNotifier, SecurityState>((ref) {
  return SecurityNotifier(ref.read(storageServiceProvider), ref.read(cryptoServiceProvider));
});
