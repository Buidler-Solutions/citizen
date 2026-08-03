import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/services/crypto_service.dart';
import 'service_providers.dart';
import 'wallet_provider.dart';

class DecryptState {
  final bool decrypting;
  final String? plaintext;
  final String? error;

  const DecryptState({
    this.decrypting = false,
    this.plaintext,
    this.error,
  });

  DecryptState copyWith({
    bool? decrypting,
    String? plaintext,
    String? error,
  }) {
    return DecryptState(
      decrypting: decrypting ?? this.decrypting,
      plaintext: plaintext,
      error: error,
    );
  }
}

class DecryptNotifier extends StateNotifier<DecryptState> {
  final CryptoService _crypto;
  final Ref _ref;

  DecryptNotifier(this._crypto, this._ref) : super(const DecryptState());

  Future<void> decrypt({
    required String authorPublicKeyHex,
    required String ciphertextHex,
    required String nonceHex,
    required String wrappedDekHex,
  }) async {
    final walletState = _ref.read(walletProvider);
    final wallet = walletState.activeWallet;
    if (wallet == null) {
      state = state.copyWith(error: 'No active wallet configured.');
      return;
    }

    state = DecryptState(decrypting: true);
    try {
      final plaintext = await _crypto.decryptOwnedTransactionCiphertext(
        wallet: wallet,
        authorPublicKeyHex: authorPublicKeyHex.trim(),
        ciphertextHex: ciphertextHex.trim(),
        nonceHex: nonceHex.trim(),
        wrappedDekHex: wrappedDekHex.trim(),
      );
      state = DecryptState(plaintext: plaintext);
    } catch (e) {
      state = DecryptState(error: e.toString());
    }
  }

  void reset() {
    state = const DecryptState();
  }
}

final decryptProvider = StateNotifierProvider<DecryptNotifier, DecryptState>((ref) {
  return DecryptNotifier(
    ref.read(cryptoServiceProvider),
    ref,
  );
});
