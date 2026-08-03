import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../../core/utils/hex_utils.dart';
import '../models/wallet_models.dart';

class CryptoService {
  static final CryptoService _instance = CryptoService._internal();
  factory CryptoService() => _instance;
  CryptoService._internal();

  final _ed25519 = Ed25519();
  final _x25519 = X25519();
  final _sha256 = Sha256();
  final _hmacSha512 = Hmac.sha512();
  final _chacha20 = Chacha20.poly1305Aead();
  final _aesGcm = AesGcm.with256bits();

  static const _defaultDerivationPath = "m/44'/930'/0'/0'/0'";

  // ─── Hashing ──────────────────────────────────────────────

  Future<String> sha256Hex(String input) async {
    final bytes = utf8.encode(input);
    final digest = await _sha256.hash(bytes);
    return bytesToHex(digest.bytes);
  }

  Future<String> sha256DigestHex(String input) async {
    final hex = await sha256Hex(input);
    return 'sha256:$hex';
  }

  // ─── SLIP-0010 Ed25519 Derivation ────────────────────────

  Future<Uint8List> _hmacSha512Mac(List<int> key, List<int> data) async {
    final mac = await _hmacSha512.calculateMac(
      data,
      secretKey: SecretKey(key),
    );
    return Uint8List.fromList(mac.bytes);
  }

  List<int> _parseHardenedDerivationPath(String path) {
    final trimmed = path.trim();
    if (!trimmed.startsWith('m')) {
      throw ArgumentError('Derivation path must start with m.');
    }
    final parts = trimmed.split('/').skip(1).where((p) => p.isNotEmpty).toList();
    return parts.map((part) {
      if (!part.endsWith("'")) {
        throw ArgumentError('Only hardened derivation path segments are supported.');
      }
      final index = int.parse(part.substring(0, part.length - 1));
      if (index < 0) throw ArgumentError('Invalid hardened derivation index.');
      return index;
    }).toList();
  }

  Future<Uint8List> deriveEd25519SecretFromMnemonic(
    String mnemonicPhrase,
    String derivationPath,
  ) async {
    final seed = await _mnemonicToSeed(mnemonicPhrase);

    var i = await _hmacSha512Mac(utf8.encode('ed25519 seed'), seed);
    var key = i.sublist(0, 32);
    var chainCode = i.sublist(32);

    final pathIndices = _parseHardenedDerivationPath(derivationPath);
    for (final index in pathIndices) {
      final data = Uint8List(1 + key.length + 4);
      data[0] = 0x00;
      data.setRange(1, 1 + key.length, key);
      final offset = 1 + key.length;
      data[offset] = (index >> 24) & 0xff;
      data[offset + 1] = (index >> 16) & 0xff;
      data[offset + 2] = (index >> 8) & 0xff;
      data[offset + 3] = index & 0xff;

      i = await _hmacSha512Mac(chainCode, data);
      key = i.sublist(0, 32);
      chainCode = i.sublist(32);
    }

    return Uint8List.fromList(key);
  }

  Future<List<int>> _mnemonicToSeed(String mnemonicPhrase) async {
    final normalized = mnemonicPhrase.trim().toLowerCase();
    final salt = utf8.encode('mnemonic$normalized');
    final password = utf8.encode(normalized);

    final pbkdf2 = Pbkdf2(
      macAlgorithm: Hmac.sha512(),
      iterations: 2048,
      bits: 512,
    );
    final seed = await pbkdf2.deriveKey(
      secretKey: SecretKey(password),
      nonce: salt,
    );
    final seedBytes = await seed.extractBytes();
    return seedBytes.sublist(0, 32);
  }

  // ─── Ed25519 Signer ───────────────────────────────────────

  Future<ProtocolSigner> getOrCreateProtocolSigner(StoredWallet walletRecord) async {
    final secret = await _resolveProtocolSecret(walletRecord);
    final keyPair = await _ed25519.newKeyPairFromSeed(secret);
    final pubKey = await keyPair.extractPublicKey();
    final verifyingKeyHex = bytesToHex(pubKey.bytes);

    return ProtocolSigner(
      did: 'did:key:ed25519:$verifyingKeyHex',
      verifyingKeyHex: verifyingKeyHex,
    );
  }

  Future<String> signWithEd25519(StoredWallet wallet, String message) async {
    final secret = await _resolveProtocolSecret(wallet);
    final keyPair = await _ed25519.newKeyPairFromSeed(secret);
    final signature = await _ed25519.sign(utf8.encode(message), keyPair: keyPair);
    return bytesToHex(signature.bytes);
  }

  Future<({String signature, String signerDid, String verifyingKey})> signProtocolPayload(
    StoredWallet wallet,
    String signingPayload,
  ) async {
    final signer = await getOrCreateProtocolSigner(wallet);
    final signatureHex = await signWithEd25519(wallet, signingPayload);
    return (
      signature: signatureHex,
      signerDid: signer.did,
      verifyingKey: signer.verifyingKeyHex,
    );
  }

  // ─── X25519 Reader Key ────────────────────────────────────

  Future<EncryptionReaderKey> getOrCreateEncryptionReaderKey(StoredWallet walletRecord) async {
    final secret = await _resolveProtocolSecret(walletRecord);
    final keyPair = await _x25519.newKeyPairFromSeed(secret);
    final pubKey = await keyPair.extractPublicKey();
    final publicKeyHex = bytesToHex(pubKey.bytes);

    return EncryptionReaderKey(
      did: 'did:key:x25519:$publicKeyHex',
      publicKeyHex: publicKeyHex,
    );
  }

  Future<ProtocolKeyMaterial> getKeyMaterial(StoredWallet wallet) async {
    final signer = await getOrCreateProtocolSigner(wallet);
    final reader = await getOrCreateEncryptionReaderKey(wallet);
    return ProtocolKeyMaterial(signer: signer, reader: reader);
  }

  // ─── Hybrid Decryption (X25519 + ChaCha20-Poly1305) ───────

  Future<String> decryptOwnedTransactionCiphertext({
    required StoredWallet wallet,
    required String authorPublicKeyHex,
    required String ciphertextHex,
    required String nonceHex,
    required String wrappedDekHex,
  }) async {
    final readerSecret = await _resolveProtocolSecret(wallet);
    if (readerSecret.length != 32) {
      throw Exception('Reader key is invalid for X25519 decryption.');
    }

    final authorPubBytes = hexToBytes(authorPublicKeyHex);
    if (authorPubBytes.length != 32) {
      throw Exception('authorPublicKeyHex must be 32 bytes.');
    }

    final readerKeyPair = await _x25519.newKeyPairFromSeed(readerSecret);
    final authorPubKey = SimplePublicKey(authorPubBytes, type: KeyPairType.x25519);
    final sharedSecret = await _x25519.sharedSecretKey(
      keyPair: readerKeyPair,
      remotePublicKey: authorPubKey,
    );
    final sharedSecretBytes = await sharedSecret.extractBytes();

    final wrapKeyDigest = await _sha256.hash(sharedSecretBytes);
    final wrapKey = wrapKeyDigest.bytes;

    final wrappedDek = hexToBytes(wrappedDekHex);
    if (wrappedDek.length <= 12) {
      throw Exception('wrappedDekHex must include nonce + ciphertext.');
    }

    Uint8List? dekBytes;
    for (final nonceLen in [12, 24]) {
      if (wrappedDek.length <= nonceLen + 16) continue;
      final dekNonce = wrappedDek.sublist(0, nonceLen);
      final dekCipher = wrappedDek.sublist(nonceLen);
      if (nonceLen == 12) {
        try {
          final box = SecretBox(
            dekCipher.sublist(0, dekCipher.length - 16),
            nonce: dekNonce,
            mac: Mac(dekCipher.sublist(dekCipher.length - 16)),
          );
          final unwrapped = await _chacha20.decrypt(box, secretKey: SecretKey(wrapKey));
          dekBytes = Uint8List.fromList(unwrapped);
          break;
        } catch (_) {
          // try next configuration
        }
      }
    }
    if (dekBytes == null) throw Exception('Unable to unwrap transaction DEK.');
    if (dekBytes.length != 32) throw Exception('Unwrapped DEK is not 32 bytes.');

    final payloadNonce = hexToBytes(nonceHex);
    if (payloadNonce.length != 12) {
      throw Exception('Only 12-byte ChaCha20-Poly1305 nonce is supported.');
    }
    final payloadCipher = hexToBytes(ciphertextHex);
    try {
      final box = SecretBox(
        payloadCipher.sublist(0, payloadCipher.length - 16),
        nonce: payloadNonce,
        mac: Mac(payloadCipher.sublist(payloadCipher.length - 16)),
      );
      final plaintext = await _chacha20.decrypt(box, secretKey: SecretKey(dekBytes));
      return utf8.decode(plaintext);
    } catch (e) {
      throw Exception('Payload decryption failed: $e');
    }
  }

  // ─── Auth Challenge Signing ───────────────────────────────

  Future<String> signAuthChallenge(StoredWallet wallet, String message) async {
    final secret = await _resolveProtocolSecret(wallet);
    final keyPair = await _ed25519.newKeyPairFromSeed(secret);
    final signature = await _ed25519.sign(utf8.encode(message), keyPair: keyPair);
    return bytesToBase64Url(signature.bytes);
  }

  // ─── Backup Vault Encryption ──────────────────────────────

  Future<String> encryptBackupPayload(String passphrase, String payloadJson) async {
    final pbkdf2 = Pbkdf2(
      macAlgorithm: Hmac.sha256(),
      iterations: 210000,
      bits: 256,
    );
    final salt = nonceBytes(16);
    final key = await pbkdf2.deriveKey(
      secretKey: SecretKey(utf8.encode(passphrase)),
      nonce: salt,
    );
    final iv = nonceBytes(12);
    final box = await _aesGcm.encrypt(
      utf8.encode(payloadJson),
      secretKey: key,
      nonce: iv,
    );

    final envelope = {
      'version': 1,
      'algorithm': 'aes-256-gcm',
      'kdf': {'name': 'pbkdf2-sha256', 'iterations': 210000},
      'salt': bytesToHex(salt),
      'iv': bytesToHex(iv),
      'ciphertext': bytesToHex(box.cipherText) + bytesToHex(box.mac.bytes),
    };
    return base64.encode(utf8.encode(jsonEncode(envelope)));
  }

  Future<String> decryptBackupPayload(String passphrase, String encoded) async {
    final json = jsonDecode(utf8.decode(base64.decode(encoded))) as Map<String, dynamic>;
    final saltHex = json['salt'] as String;
    final ivHex = json['iv'] as String;
    final cipherHex = json['ciphertext'] as String;
    final iterations = (json['kdf'] as Map<String, dynamic>)['iterations'] as int;

    final pbkdf2 = Pbkdf2(
      macAlgorithm: Hmac.sha256(),
      iterations: iterations,
      bits: 256,
    );
    final key = await pbkdf2.deriveKey(
      secretKey: SecretKey(utf8.encode(passphrase)),
      nonce: hexToBytes(saltHex),
    );

    final cipherBytes = hexToBytes(cipherHex);
    final box = SecretBox(
      cipherBytes.sublist(0, cipherBytes.length - 16),
      nonce: hexToBytes(ivHex),
      mac: Mac(cipherBytes.sublist(cipherBytes.length - 16)),
    );
    final plaintext = await _aesGcm.decrypt(box, secretKey: key);
    return utf8.decode(plaintext);
  }

  // ─── Helpers ──────────────────────────────────────────────

  Future<Uint8List> _resolveProtocolSecret(StoredWallet wallet) async {
    if (wallet.mnemonicPhrase != null && wallet.mnemonicPhrase!.isNotEmpty) {
      final path = wallet.derivationPath ?? _defaultDerivationPath;
      return deriveEd25519SecretFromMnemonic(wallet.mnemonicPhrase!, path);
    }
    return hexToBytes(wallet.privateKeyHex);
  }

  Future<String> derivePrivateKeyHex(String mnemonicPhrase, String derivationPath) async {
    final secret = await deriveEd25519SecretFromMnemonic(mnemonicPhrase, derivationPath);
    return bytesToHex(secret);
  }

  Uint8List nonceBytes(int length) {
    final random = Random.secure();
    return Uint8List.fromList(List<int>.generate(length, (_) => random.nextInt(256)));
  }

  String generateWalletId() {
    final ts = DateTime.now().millisecondsSinceEpoch;
    final rand = bytesToHex(nonceBytes(4));
    return 'wallet-$ts-$rand';
  }
}
