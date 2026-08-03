import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/config/app_config.dart';
import '../models/activity_entry.dart';
import '../models/direct_submit.dart';
import '../models/network_config.dart';
import '../models/profile_details.dart';
import '../models/wallet_models.dart';

class StorageService {
  static final StorageService _instance = StorageService._internal();
  factory StorageService() => _instance;
  StorageService._internal();

  final _secureStorage = const FlutterSecureStorage(
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
  );

  SharedPreferences? _prefs;

  Future<SharedPreferences> get prefs async {
    _prefs ??= await SharedPreferences.getInstance();
    return _prefs!;
  }

  // ─── Wallet Vault ─────────────────────────────────────────
  // Metadata lives in shared_preferences; secrets in flutter_secure_storage.

  static const _privKeyPrefix = 'citizen.mobile.wallet.priv.';
  static const _mnemonicKeyPrefix = 'citizen.mobile.wallet.mnemonic.';

  String _privKeyStorageKey(String walletId) => '$_privKeyPrefix$walletId';
  String _mnemonicStorageKey(String walletId) => '$_mnemonicKeyPrefix$walletId';

  Future<List<WalletMetadata>> getVaultMetadata() async {
    final raw = (await prefs).getString(AppConfig.vaultKey);
    if (raw == null) return [];
    final list = jsonDecode(raw) as List;
    return list.map((e) => WalletMetadata.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<void> saveVaultMetadata(List<WalletMetadata> vault, {String? activeWalletId}) async {
    final nextActiveId = activeWalletId ?? vault.firstOrNull?.id;
    await (await prefs).setString(AppConfig.vaultKey, jsonEncode(vault.map((e) => e.toJson()).toList()));
    if (nextActiveId != null) {
      await (await prefs).setString(AppConfig.activeWalletIdKey, nextActiveId);
    }
  }

  Future<void> storeWalletSecrets(StoredWallet wallet) async {
    await _secureStorage.write(key: _privKeyStorageKey(wallet.id), value: wallet.privateKeyHex);
    if (wallet.mnemonicPhrase != null) {
      await _secureStorage.write(key: _mnemonicStorageKey(wallet.id), value: wallet.mnemonicPhrase);
    }
  }

  Future<String?> getPrivateKey(String walletId) async {
    return _secureStorage.read(key: _privKeyStorageKey(walletId));
  }

  Future<String?> getMnemonic(String walletId) async {
    return _secureStorage.read(key: _mnemonicStorageKey(walletId));
  }

  Future<void> deleteWalletSecrets(String walletId) async {
    await _secureStorage.delete(key: _privKeyStorageKey(walletId));
    await _secureStorage.delete(key: _mnemonicStorageKey(walletId));
  }

  Future<List<StoredWallet>> getVault() async {
    final metadataList = await getVaultMetadata();
    final result = <StoredWallet>[];
    for (final meta in metadataList) {
      final privateKey = await getPrivateKey(meta.id);
      if (privateKey == null) continue;
      final mnemonic = await getMnemonic(meta.id);
      result.add(StoredWallet(
        id: meta.id,
        name: meta.name,
        createdAt: meta.createdAt,
        privateKeyHex: privateKey,
        mnemonicPhrase: mnemonic,
        derivationPath: meta.derivationPath,
      ));
    }
    return result;
  }

  Future<void> saveVault(List<StoredWallet> vault, {String? activeWalletId}) async {
    final metadataList = vault.map((w) => WalletMetadata(
      id: w.id,
      name: w.name,
      createdAt: w.createdAt,
      derivationPath: w.derivationPath,
      hasMnemonic: w.hasMnemonic,
      mnemonicWordCount: w.mnemonicWordCount,
    )).toList();
    await saveVaultMetadata(metadataList, activeWalletId: activeWalletId);
    for (final wallet in vault) {
      await storeWalletSecrets(wallet);
    }
  }

  Future<String?> getActiveWalletId() async {
    return (await prefs).getString(AppConfig.activeWalletIdKey);
  }

  Future<StoredWallet?> getActiveWallet() async {
    final vault = await getVault();
    if (vault.isEmpty) return null;
    final activeId = await getActiveWalletId();
    return vault.firstWhere(
      (w) => w.id == activeId,
      orElse: () => vault.first,
    );
  }

  // ─── Password ─────────────────────────────────────────────

  Future<void> setPasswordHash(String hash) async {
    await _secureStorage.write(key: AppConfig.passwordHashKey, value: hash);
  }

  Future<String?> getPasswordHash() async {
    return _secureStorage.read(key: AppConfig.passwordHashKey);
  }

  Future<void> deletePassword() async {
    await _secureStorage.delete(key: AppConfig.passwordHashKey);
  }

  // ─── Lock State ───────────────────────────────────────────

  bool _isUnlocked = false;
  bool get isUnlocked => _isUnlocked;
  void markUnlocked() => _isUnlocked = true;
  void markLocked() => _isUnlocked = false;

  // ─── Network Selection ────────────────────────────────────

  Future<NetworkId> getSelectedNetwork() async {
    final value = (await prefs).getString(AppConfig.networkKey);
    if (value == null) return NetworkId.mainnet;
    return networkIdFromString(value);
  }

  Future<void> setSelectedNetwork(NetworkId network) async {
    await (await prefs).setString(AppConfig.networkKey, network.name);
  }

  // ─── Activity ─────────────────────────────────────────────

  Future<List<ActivityEntry>> getActivity() async {
    final raw = (await prefs).getString(AppConfig.activityKey);
    if (raw == null) return [];
    final list = jsonDecode(raw) as List;
    return list.map((e) => ActivityEntry.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<void> appendActivity(ActivityEntry entry) async {
    final existing = await getActivity();
    final updated = [entry, ...existing].take(AppConfig.maxActivity).toList();
    await (await prefs).setString(
      AppConfig.activityKey,
      jsonEncode(updated.map((e) => e.toJson()).toList()),
    );
  }

  // ─── Direct Submit Receipts ───────────────────────────────

  Future<List<DirectSubmitReceipt>> getReceipts() async {
    final raw = (await prefs).getString(AppConfig.directSubmitReceiptsKey);
    if (raw == null) return [];
    final list = jsonDecode(raw) as List;
    return list.map((e) => DirectSubmitReceipt.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<void> appendReceipt(DirectSubmitReceipt receipt) async {
    final existing = await getReceipts();
    final updated = [receipt, ...existing].take(AppConfig.maxDirectSubmitReceipts).toList();
    await (await prefs).setString(
      AppConfig.directSubmitReceiptsKey,
      jsonEncode(updated.map((e) => e.toJson()).toList()),
    );
  }

  Future<String> getDirectSubmitDefaultDestination() async {
    final value = (await prefs).getString(AppConfig.directSubmitDefaultDestKey);
    if (value != null && value.isNotEmpty) return value;
    return AppConfig.directSubmitAllowlist.first;
  }

  Future<void> setDirectSubmitDefaultDestination(String url) async {
    await (await prefs).setString(AppConfig.directSubmitDefaultDestKey, url);
  }

  // ─── Profile ──────────────────────────────────────────────

  Future<ProfileDetails> getProfile() async {
    final raw = (await prefs).getString(AppConfig.profileKey);
    if (raw == null) return const ProfileDetails();
    return ProfileDetails.fromJson(jsonDecode(raw) as Map<String, dynamic>);
  }

  Future<void> saveProfile(ProfileDetails profile) async {
    await (await prefs).setString(AppConfig.profileKey, jsonEncode(profile.toJson()));
  }

  // ─── Backup Vault State ───────────────────────────────────

  Future<Map<String, dynamic>?> getBackupVaultState() async {
    final raw = (await prefs).getString(AppConfig.backupVaultStateKey);
    if (raw == null) return null;
    return jsonDecode(raw) as Map<String, dynamic>;
  }

  Future<void> saveBackupVaultState(Map<String, dynamic> state) async {
    await (await prefs).setString(AppConfig.backupVaultStateKey, jsonEncode(state));
  }

  Future<String?> getBackupPosture() async {
    return (await prefs).getString(AppConfig.backupPostureKey);
  }

  Future<void> setBackupPosture(String isoTimestamp) async {
    await (await prefs).setString(AppConfig.backupPostureKey, isoTimestamp);
  }
}
