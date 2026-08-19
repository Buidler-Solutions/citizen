import 'package:flutter_test/flutter_test.dart';
import 'package:treasurenet_mobile/core/utils/hex_utils.dart';
import 'package:treasurenet_mobile/data/services/crypto_service.dart';

/// Ed25519 parity with the TreasureNet chain SDK (node:crypto, raw 32-byte
/// seeds, hex signatures). The golden vector was generated with the SDK's
/// exact key stitching and signing path; the seed is RFC 8032 test vector 1.
void main() {
  const seedHex =
      '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
  const expectedPublicKeyHex =
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const message = 'treasurenet-login:01234567-89ab-cdef-0123-456789abcdef';
  const expectedSignatureHex =
      'aa6d7a2cb2145df8d35293b3032f70ed2a846a9fd7ef03acd923b504ab1533a4'
      '1b6264dbe5865780d9dd45b1ed9de35882301879434c4d1c9ebcf22b9f087407';

  final crypto = DeviceCryptoService.instance;

  test('derives the same public key from the seed as the node SDK', () async {
    final publicKeyHex = await crypto.publicKeyHexFromSeed(seedHex);
    expect(publicKeyHex, expectedPublicKeyHex);
  });

  test('DID format is did:key:ed25519:<pubhex>', () async {
    final publicKeyHex = await crypto.publicKeyHexFromSeed(seedHex);
    final identity = DeviceIdentity(
      seedHex: seedHex,
      publicKeyHex: publicKeyHex,
    );
    expect(identity.did, 'did:key:ed25519:$expectedPublicKeyHex');
  });

  test('login challenge signature matches the node SDK byte for byte',
      () async {
    final signature = await crypto.signMessage(message, seedHex);
    expect(signature, expectedSignatureHex);
  });

  test('challenge message format matches the backend auth module', () {
    expect(
      loginChallengeMessage('nonce-abc'),
      'treasurenet-login:nonce-abc',
    );
  });

  test('generated identities sign and verify round-trip', () async {
    final identity = await crypto.generateIdentity();
    final signature = await crypto.signMessage(message, identity.seedHex);
    final valid = await crypto.verifyMessage(
      message: message,
      signatureHex: signature,
      publicKeyHex: identity.publicKeyHex,
    );
    final tampered = await crypto.verifyMessage(
      message: 'treasurenet-login:other',
      signatureHex: signature,
      publicKeyHex: identity.publicKeyHex,
    );
    expect(valid, isTrue);
    expect(tampered, isFalse);
  });

  test('hex utils round-trip', () {
    final bytes = hexToBytes('deadbeef');
    expect(bytes, [0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToHex(bytes), 'deadbeef');
  });
}
