import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';

import '../../core/utils/hex_utils.dart';

/// Device identity for TreasureNet Citizen Edition.
///
/// Crypto parity contract (see chain/sdk/src/modules.ts claimMessages and
/// chain/sdk/src/keys.ts): a single raw 32-byte Ed25519 seed held in secure
/// storage, signatures are standard Ed25519 over UTF-8 message bytes,
/// hex-encoded, and the DID is `did:key:ed25519:<public_key_hex>`.
class DeviceCryptoService {
  DeviceCryptoService._();

  static final DeviceCryptoService instance = DeviceCryptoService._();

  final Ed25519 _ed25519 = Ed25519();

  static const int seedLengthBytes = 32;

  /// Generates a fresh device keypair and returns (seedHex, publicKeyHex).
  Future<DeviceIdentity> generateIdentity() async {
    final keyPair = await _ed25519.newKeyPair();
    final seed = await keyPair.extractPrivateKeyBytes();
    final publicKey = await keyPair.extractPublicKey();
    return DeviceIdentity(
      seedHex: bytesToHex(seed),
      publicKeyHex: bytesToHex(publicKey.bytes),
    );
  }

  Future<String> publicKeyHexFromSeed(String seedHex) async {
    final keyPair = await _ed25519.newKeyPairFromSeed(hexToBytes(seedHex));
    final publicKey = await keyPair.extractPublicKey();
    return bytesToHex(publicKey.bytes);
  }

  Future<String> signMessage(String message, String seedHex) async {
    final keyPair = await _ed25519.newKeyPairFromSeed(hexToBytes(seedHex));
    final signature = await _ed25519.sign(
      utf8.encode(message),
      keyPair: keyPair,
    );
    return bytesToHex(signature.bytes);
  }

  Future<bool> verifyMessage({
    required String message,
    required String signatureHex,
    required String publicKeyHex,
  }) async {
    final publicKey = SimplePublicKey(
      hexToBytes(publicKeyHex),
      type: KeyPairType.ed25519,
    );
    return _ed25519.verify(
      utf8.encode(message),
      signature: Signature(
        hexToBytes(signatureHex),
        publicKey: publicKey,
      ),
    );
  }
}

@immutable
class DeviceIdentity {
  const DeviceIdentity({required this.seedHex, required this.publicKeyHex});

  final String seedHex;
  final String publicKeyHex;

  String get did => 'did:key:ed25519:$publicKeyHex';
}

/// Canonical login challenge message. Must match the backend auth module
/// (`treasurenet-login:<nonce>`); the only string the player app signs.
String loginChallengeMessage(String nonce) => 'treasurenet-login:$nonce';

/// Utility for tests and debugging: raw seed bytes as Uint8List.
Uint8List seedBytes(String seedHex) =>
    Uint8List.fromList(hexToBytes(seedHex));
