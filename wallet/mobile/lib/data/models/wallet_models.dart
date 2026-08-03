class StoredWallet {
  final String id;
  final String name;
  final String createdAt;
  final String privateKeyHex;
  final String? mnemonicPhrase;
  final String? derivationPath;

  const StoredWallet({
    required this.id,
    required this.name,
    required this.createdAt,
    required this.privateKeyHex,
    this.mnemonicPhrase,
    this.derivationPath,
  });

  bool get hasMnemonic => mnemonicPhrase != null && mnemonicPhrase!.isNotEmpty;

  int? get mnemonicWordCount {
    final phrase = mnemonicPhrase;
    if (phrase == null || phrase.trim().isEmpty) return null;
    final count = phrase.trim().split(RegExp(r'\s+')).length;
    return (count == 12 || count == 24) ? count : null;
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'createdAt': createdAt,
        'privateKeyHex': privateKeyHex,
        if (mnemonicPhrase != null) 'mnemonicPhrase': mnemonicPhrase,
        if (derivationPath != null) 'derivationPath': derivationPath,
      };

  factory StoredWallet.fromJson(Map<String, dynamic> json) {
    return StoredWallet(
      id: json['id'] as String,
      name: json['name'] as String,
      createdAt: json['createdAt'] as String,
      privateKeyHex: json['privateKeyHex'] as String,
      mnemonicPhrase: json['mnemonicPhrase'] as String?,
      derivationPath: json['derivationPath'] as String?,
    );
  }
}

class VaultWalletInfo {
  final String id;
  final String name;
  final String signerDid;
  final bool hasMnemonic;
  final int? mnemonicWordCount;
  final String createdAt;
  final bool isActive;

  const VaultWalletInfo({
    required this.id,
    required this.name,
    required this.signerDid,
    required this.hasMnemonic,
    this.mnemonicWordCount,
    required this.createdAt,
    required this.isActive,
  });
}

class ProtocolSigner {
  final String did;
  final String verifyingKeyHex;
  final String algorithm;

  const ProtocolSigner({
    required this.did,
    required this.verifyingKeyHex,
    this.algorithm = 'ed25519',
  });
}

class EncryptionReaderKey {
  final String did;
  final String publicKeyHex;
  final String algorithm;

  const EncryptionReaderKey({
    required this.did,
    required this.publicKeyHex,
    this.algorithm = 'x25519',
  });
}

class ProtocolKeyMaterial {
  final ProtocolSigner signer;
  final EncryptionReaderKey reader;

  const ProtocolKeyMaterial({required this.signer, required this.reader});
}
