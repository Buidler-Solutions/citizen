import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/config/app_config.dart';
import '../data/models/wallet_models.dart';
import '../data/services/crypto_service.dart';
import '../data/services/mnemonic_service.dart';
import '../data/services/storage_service.dart';
import 'service_providers.dart';

enum WalletStateStatus { idle, loading, ready, error }

class WalletState {
  final WalletStateStatus status;
  final List<StoredWallet> vault;
  final StoredWallet? activeWallet;
  final String? error;
  final ProtocolSigner? signer;

  const WalletState({
    this.status = WalletStateStatus.idle,
    this.vault = const [],
    this.activeWallet,
    this.error,
    this.signer,
  });

  WalletState copyWith({
    WalletStateStatus? status,
    List<StoredWallet>? vault,
    StoredWallet? activeWallet,
    String? error,
    ProtocolSigner? signer,
  }) {
    return WalletState(
      status: status ?? this.status,
      vault: vault ?? this.vault,
      activeWallet: activeWallet ?? this.activeWallet,
      error: error,
      signer: signer ?? this.signer,
    );
  }
}

class WalletNotifier extends StateNotifier<WalletState> {
  final StorageService _storage;
  final CryptoService _crypto;

  WalletNotifier(this._storage, this._crypto) : super(const WalletState());

  Future<void> initialize() async {
    state = state.copyWith(status: WalletStateStatus.loading);
    try {
      final vault = await _storage.getVault();
      final active = vault.isEmpty ? null : await _storage.getActiveWallet();
      ProtocolSigner? signer;
      if (active != null) {
        signer = await _crypto.getOrCreateProtocolSigner(active);
      }
      state = WalletState(
        status: WalletStateStatus.ready,
        vault: vault,
        activeWallet: active,
        signer: signer,
      );
    } catch (e) {
      state = state.copyWith(status: WalletStateStatus.error, error: e.toString());
    }
  }

  Future<StoredWallet> generateWallet({int wordCount = 12}) async {
    state = state.copyWith(status: WalletStateStatus.loading);
    try {
      final mnemonic = MnemonicService.generate(wordCount: wordCount);
      final privateKeyHex = await _crypto.derivePrivateKeyHex(
        mnemonic,
        "m/44'/930'/0'/0'/0'",
      );
      final wallet = StoredWallet(
        id: _crypto.generateWalletId(),
        name: 'Wallet ${DateTime.now().millisecondsSinceEpoch}',
        createdAt: DateTime.now().toIso8601String(),
        privateKeyHex: privateKeyHex,
        mnemonicPhrase: mnemonic,
        derivationPath: "m/44'/930'/0'/0'/0'",
      );
      final vault = [wallet, ...state.vault];
      await _storage.saveVault(vault, activeWalletId: wallet.id);
      final signer = await _crypto.getOrCreateProtocolSigner(wallet);
      state = WalletState(
        status: WalletStateStatus.ready,
        vault: vault,
        activeWallet: wallet,
        signer: signer,
      );
      return wallet;
    } catch (e) {
      state = state.copyWith(status: WalletStateStatus.error, error: e.toString());
      rethrow;
    }
  }

  Future<void> importWallet(String mnemonicPhrase) async {
    state = state.copyWith(status: WalletStateStatus.loading);
    try {
      if (!MnemonicService.validate(mnemonicPhrase)) {
        throw Exception('Invalid mnemonic phrase.');
      }
      final privateKeyHex = await _crypto.derivePrivateKeyHex(
        mnemonicPhrase,
        "m/44'/930'/0'/0'/0'",
      );
      final wallet = StoredWallet(
        id: _crypto.generateWalletId(),
        name: 'Imported ${DateTime.now().millisecondsSinceEpoch}',
        createdAt: DateTime.now().toIso8601String(),
        privateKeyHex: privateKeyHex,
        mnemonicPhrase: mnemonicPhrase,
        derivationPath: "m/44'/930'/0'/0'/0'",
      );
      final vault = [wallet, ...state.vault];
      await _storage.saveVault(vault, activeWalletId: wallet.id);
      final signer = await _crypto.getOrCreateProtocolSigner(wallet);
      state = WalletState(
        status: WalletStateStatus.ready,
        vault: vault,
        activeWallet: wallet,
        signer: signer,
      );
    } catch (e) {
      state = state.copyWith(status: WalletStateStatus.error, error: e.toString());
    }
  }

  Future<void> setActiveWallet(String walletId) async {
    final wallet = state.vault.firstWhere((w) => w.id == walletId);
    await (await _storage.prefs).setString(AppConfig.activeWalletIdKey, walletId);
    final signer = await _crypto.getOrCreateProtocolSigner(wallet);
    state = state.copyWith(activeWallet: wallet, signer: signer);
  }

  Future<void> deleteWallet(String walletId) async {
    final vault = state.vault.where((w) => w.id != walletId).toList();
    final activeId = state.activeWallet?.id == walletId
        ? vault.firstOrNull?.id
        : state.activeWallet?.id;
    await _storage.deleteWalletSecrets(walletId);
    await _storage.saveVaultMetadata(
      vault.map((w) => WalletMetadata(
        id: w.id,
        name: w.name,
        createdAt: w.createdAt,
        derivationPath: w.derivationPath,
        hasMnemonic: w.hasMnemonic,
        mnemonicWordCount: w.mnemonicWordCount,
      )).toList(),
      activeWalletId: activeId,
    );
    final active = vault.isEmpty ? null : vault.firstWhere(
      (w) => w.id == activeId,
      orElse: () => vault.first,
    );
    ProtocolSigner? signer;
    if (active != null) {
      signer = await _crypto.getOrCreateProtocolSigner(active);
    }
    state = WalletState(
      status: WalletStateStatus.ready,
      vault: vault,
      activeWallet: active,
      signer: signer,
    );
  }

  Future<ProtocolKeyMaterial?> getKeyMaterial() async {
    final wallet = state.activeWallet;
    if (wallet == null) return null;
    return _crypto.getKeyMaterial(wallet);
  }

  Future<ProtocolKeyMaterial?> getKeyMaterialForWallet(StoredWallet wallet) async {
    return _crypto.getKeyMaterial(wallet);
  }

  Future<EncryptionReaderKey?> getReaderKey() async {
    final wallet = state.activeWallet;
    if (wallet == null) return null;
    return _crypto.getOrCreateEncryptionReaderKey(wallet);
  }
}

final walletProvider = StateNotifierProvider<WalletNotifier, WalletState>((ref) {
  return WalletNotifier(ref.read(storageServiceProvider), ref.read(cryptoServiceProvider));
});
