import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/services/crypto_service.dart';
import '../data/services/storage_service.dart';
import 'service_providers.dart';

class SecurityState {
  final bool hasPassword;
  final bool isUnlocked;
  final String? error;

  const SecurityState({
    this.hasPassword = false,
    this.isUnlocked = false,
    this.error,
  });

  SecurityState copyWith({
    bool? hasPassword,
    bool? isUnlocked,
    String? error,
  }) {
    return SecurityState(
      hasPassword: hasPassword ?? this.hasPassword,
      isUnlocked: isUnlocked ?? this.isUnlocked,
      error: error,
    );
  }
}

class SecurityNotifier extends StateNotifier<SecurityState> {
  final StorageService _storage;
  final CryptoService _crypto;

  SecurityNotifier(this._storage, this._crypto) : super(const SecurityState());

  Future<void> initialize() async {
    final hash = await _storage.getPasswordHash();
    final hasPassword = hash != null && hash.isNotEmpty;
    final isUnlocked = !hasPassword || _storage.isUnlocked;
    state = SecurityState(hasPassword: hasPassword, isUnlocked: isUnlocked);
  }

  Future<bool> setPassword(String password) async {
    if (password.length < 8) {
      state = state.copyWith(error: 'Password must be at least 8 characters.');
      return false;
    }
    final hash = await _crypto.sha256Hex(password);
    await _storage.setPasswordHash(hash);
    _storage.markUnlocked();
    state = SecurityState(hasPassword: true, isUnlocked: true);
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
    state = SecurityState(hasPassword: true, isUnlocked: true);
    return true;
  }

  void lock() {
    _storage.markLocked();
    state = state.copyWith(isUnlocked: false);
  }

  Future<void> removePassword() async {
    await _storage.deletePassword();
    _storage.markLocked();
    state = const SecurityState(hasPassword: false, isUnlocked: false);
  }
}

final securityProvider = StateNotifierProvider<SecurityNotifier, SecurityState>((ref) {
  return SecurityNotifier(ref.read(storageServiceProvider), ref.read(cryptoServiceProvider));
});
