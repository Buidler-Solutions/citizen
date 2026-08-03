abstract final class AppConfig {
  static const String storagePrefix = 'citizen.mobile.wallet';
  static const String vaultKey = '${storagePrefix}.vault.v1';
  static const String activeWalletIdKey = '${storagePrefix}.active_wallet_id.v1';
  static const String passwordHashKey = '${storagePrefix}.password_hash.v1';
  static const String networkKey = '${storagePrefix}.network.v1';
  static const String activityKey = '${storagePrefix}.activity.v1';
  static const String directSubmitReceiptsKey = '${storagePrefix}.direct_submit_receipts.v1';
  static const String directSubmitDefaultDestKey = '${storagePrefix}.direct_submit_default_dest.v1';
  static const String profileKey = '${storagePrefix}.profile.v1';
  static const String backupVaultStateKey = '${storagePrefix}.backup_vault_state.v1';
  static const String backupPostureKey = '${storagePrefix}.backup_posture.v1';

  static const String defaultDerivationPath = "m/44'/930'/0'/0'/0'";
  static const int backupKdfIterations = 210000;
  static const int maxActivity = 100;
  static const int maxDirectSubmitReceipts = 100;

  static const List<String> directSubmitAllowlist = [
    'https://mainnet.ctzn.space/api/v1/direct-submit',
    'https://futurenet.ctzn.space/api/v1/direct-submit',
    'https://testnet.ctzn.space/api/v1/direct-submit',
    'http://localhost:8081/api/v1/direct-submit',
  ];

  static const List<String> apiBaseAllowlist = [
    'https://mainnet.ctzn.space',
    'https://futurenet.ctzn.space',
    'https://testnet.ctzn.space',
    'http://localhost:8081',
  ];
}
