import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:walletconnect_flutter_v2/walletconnect_flutter_v2.dart';

import '../../core/utils/canonical_json.dart';
import '../models/wallet_models.dart';
import 'crypto_service.dart';

const _kCitizenChainId = 'citizen:mainnet';
const _kCitizenNamespace = 'citizen';

const _kMethodSignAuth = 'ctzn_signAuthChallenge';
const _kMethodSignTx = 'ctzn_signCitizenTx';
const _kMethodDecrypt = 'ctzn_decryptTransaction';
const _kMethodGetKeyMaterial = 'ctzn_getKeyMaterial';
const _kMethodGetEncryptionPubKey = 'ctzn_getEncryptionPublicKey';

const _kAllMethods = [
  _kMethodSignAuth,
  _kMethodSignTx,
  _kMethodDecrypt,
  _kMethodGetKeyMaterial,
  _kMethodGetEncryptionPubKey,
];

const _kAllEvents = <String>[];

enum WCRequestType { signAuth, signTx, decrypt, getKeyMaterial, getEncryptionPubKey, unknown }

class WCRequest {
  final String topic;
  final int id;
  final String method;
  final dynamic params;
  final String dappName;
  final String dappUrl;
  final String dappIcon;

  const WCRequest({
    required this.topic,
    required this.id,
    required this.method,
    required this.params,
    this.dappName = '',
    this.dappUrl = '',
    this.dappIcon = '',
  });

  WCRequestType get type {
    switch (method) {
      case _kMethodSignAuth:
        return WCRequestType.signAuth;
      case _kMethodSignTx:
        return WCRequestType.signTx;
      case _kMethodDecrypt:
        return WCRequestType.decrypt;
      case _kMethodGetKeyMaterial:
        return WCRequestType.getKeyMaterial;
      case _kMethodGetEncryptionPubKey:
        return WCRequestType.getEncryptionPubKey;
      default:
        return WCRequestType.unknown;
    }
  }
}

class WCSessionInfo {
  final String topic;
  final String dappName;
  final String dappUrl;
  final String dappIcon;
  final String connectedAt;

  const WCSessionInfo({
    required this.topic,
    this.dappName = '',
    this.dappUrl = '',
    this.dappIcon = '',
    this.connectedAt = '',
  });
}

typedef WCRequestCallback = void Function(WCRequest request);
typedef WCSessionProposalCallback = void Function({
  required int id,
  required String dappName,
  required String dappUrl,
  required String dappIcon,
});

class WalletConnectService {
  Web3Wallet? _wallet;
  bool _initialized = false;

  bool get isInitialized => _initialized;

  final List<WCSessionInfo> _sessions = [];
  List<WCSessionInfo> get sessions => List.unmodifiable(_sessions);

  WCRequestCallback? onRequest;
  WCSessionProposalCallback? onSessionProposal;
  VoidCallback? onSessionsChanged;

  static const _projectId = String.fromEnvironment(
    'WALLETCONNECT_PROJECT_ID',
    defaultValue: 'citizen-wallet-mobile',
  );

  Future<void> initialize() async {
    if (_initialized) return;

    _wallet = await Web3Wallet.createInstance(
      projectId: _projectId,
      metadata: const PairingMetadata(
        name: 'Citizen Wallet',
        description: 'Citizen Protocol mobile wallet',
        url: 'https://greenarmor.github.io/citizen/',
        icons: ['https://greenarmor.github.io/citizen/icons/icon-192.png'],
        redirect: Redirect(
          native: 'citizenwallet://',
          universal: 'https://greenarmor.github.io/citizen/',
        ),
      ),
    );

    for (final method in _kAllMethods) {
      _wallet!.registerRequestHandler(
        chainId: _kCitizenChainId,
        method: method,
        handler: (topic, request) => _handleRequest(topic, request, method),
      );
    }

    _wallet!.onSessionProposal.subscribe(_onSessionProposal);
    _wallet!.onSessionDelete.subscribe(_onSessionDelete);
    _wallet!.onSessionConnect.subscribe(_onSessionConnect);

    await _refreshSessions();
    _initialized = true;
    onSessionsChanged?.call();
  }

  void _onSessionProposal(SessionProposalEvent? event) {
    if (event == null) return;
    final proposer = event.params.proposer;
    onSessionProposal?.call(
      id: event.id,
      dappName: proposer.metadata.name,
      dappUrl: proposer.metadata.url,
      dappIcon: proposer.metadata.icons.isNotEmpty ? proposer.metadata.icons.first : '',
    );
  }

  void _onSessionConnect(SessionConnect? event) {
    if (event == null) return;
    _refreshSessions();
  }

  void _onSessionDelete(SessionDelete? event) {
    if (event == null) return;
    _sessions.removeWhere((s) => s.topic == event.topic);
    onSessionsChanged?.call();
  }

  Future<void> _refreshSessions() async {
    _sessions.clear();
    final all = _wallet?.sessions.getAll() ?? [];
    for (final session in all) {
      final peer = session.peer.metadata;
      _sessions.add(WCSessionInfo(
        topic: session.topic,
        dappName: peer.name,
        dappUrl: peer.url,
        dappIcon: peer.icons.isNotEmpty ? peer.icons.first : '',
        connectedAt: session.expiry.toString(),
      ));
    }
    onSessionsChanged?.call();
  }

  Future<void> pairWithUri(String uri) async {
    if (!_initialized || _wallet == null) {
      throw Exception('WalletConnect not initialized.');
    }
    final parsed = Uri.tryParse(uri);
    if (parsed == null || !uri.startsWith('wc:')) {
      throw Exception('Invalid WalletConnect URI. Must start with "wc:"');
    }
    await _wallet!.pair(uri: parsed);
  }

  Future<void> approveSession({
    required int id,
    required StoredWallet wallet,
  }) async {
    if (!_initialized || _wallet == null) return;

    final signer = await CryptoService().getOrCreateProtocolSigner(wallet);
    final reader = await CryptoService().getOrCreateEncryptionReaderKey(wallet);

    final namespace = Namespace(
      accounts: [
        '$_kCitizenChainId:${signer.did}',
        '$_kCitizenChainId:${reader.did}',
      ],
      methods: _kAllMethods,
      events: _kAllEvents,
    );

    await _wallet!.approveSession(
      id: id,
      namespaces: {_kCitizenNamespace: namespace},
    );
    await _refreshSessions();
  }

  Future<void> rejectSession({required int id}) async {
    if (!_initialized || _wallet == null) return;
    await _wallet!.rejectSession(
      id: id,
      reason: const WalletConnectError(
        code: 5000,
        message: 'User rejected session',
      ),
    );
  }

  Future<void> disconnectSession(String topic) async {
    if (!_initialized || _wallet == null) return;
    await _wallet!.disconnectSession(
      topic: topic,
      reason: const WalletConnectError(
        code: 4900,
        message: 'User disconnected',
      ),
    );
    _sessions.removeWhere((s) => s.topic == topic);
    onSessionsChanged?.call();
  }

  void _handleRequest(String topic, dynamic params, String method) {
    final session = _wallet?.sessions.get(topic);
    final peerMeta = session?.peer.metadata;

    final request = WCRequest(
      topic: topic,
      id: 0,
      method: method,
      params: params,
      dappName: peerMeta?.name ?? 'Unknown dApp',
      dappUrl: peerMeta?.url ?? '',
      dappIcon: peerMeta?.icons.isNotEmpty == true ? peerMeta!.icons.first : '',
    );

    onRequest?.call(request);
  }

  Future<void> respondRequest({
    required String topic,
    required int id,
    required dynamic result,
    bool isError = false,
  }) async {
    if (!_initialized || _wallet == null) return;
    await _wallet!.respondSessionRequest(
      topic: topic,
      response: JsonRpcResponse<dynamic>(id: id, result: result),
    );
  }

  Future<void> respondError({
    required String topic,
    required int id,
    required String error,
  }) async {
    if (!_initialized || _wallet == null) return;
    await _wallet!.respondSessionRequest(
      topic: topic,
      response: JsonRpcResponse<dynamic>(
        id: id,
        error: JsonRpcError.serverError(error),
      ),
    );
  }

  Future<Map<String, dynamic>> processRequest({
    required WCRequest request,
    required StoredWallet wallet,
  }) async {
    final crypto = CryptoService();

    switch (request.type) {
      case WCRequestType.signAuth:
        final message = _extractParam(request.params) as String;
        final signer = await crypto.getOrCreateProtocolSigner(wallet);
        final signature = await crypto.signAuthChallenge(wallet, message);
        return {
          'signer': signer.did,
          'verifyingKey': signer.verifyingKeyHex,
          'algorithm': 'ed25519',
          'signature': signature,
          'signatureEncoding': 'base64url',
        };

      case WCRequestType.signTx:
        final payload = _extractParam(request.params);
        final payloadMap = payload is String
            ? jsonDecode(payload) as Map<String, dynamic>
            : payload as Map<String, dynamic>;
        final signingPayload = canonicalJson(payloadMap);
        final payloadHash = await crypto.sha256DigestHex(signingPayload);
        final signResult = await crypto.signProtocolPayload(wallet, signingPayload);
        return {
          'signer': signResult.signerDid,
          'verifyingKey': signResult.verifyingKey,
          'signature': signResult.signature,
          'signingPayload': signingPayload,
          'payloadHash': payloadHash,
          'algorithm': 'ed25519',
          'signatureScope': 'canonical_payload_v1',
        };

      case WCRequestType.decrypt:
        final params = _extractParam(request.params) as Map<String, dynamic>;
        final plaintext = await crypto.decryptOwnedTransactionCiphertext(
          wallet: wallet,
          authorPublicKeyHex: params['authorPublicKeyHex'] as String,
          ciphertextHex: params['ciphertextHex'] as String,
          nonceHex: params['nonceHex'] as String,
          wrappedDekHex: params['wrappedDekHex'] as String,
        );
        return {
          'plaintext': plaintext,
          'plaintextJson': _tryParseJson(plaintext),
        };

      case WCRequestType.getKeyMaterial:
        final material = await crypto.getKeyMaterial(wallet);
        return {
          'signer': {
            'did': material.signer.did,
            'verifyingKey': material.signer.verifyingKeyHex,
            'algorithm': 'ed25519',
          },
          'reader': {
            'readerDid': material.reader.did,
            'publicKeyHex': material.reader.publicKeyHex,
            'algorithm': 'x25519',
          },
        };

      case WCRequestType.getEncryptionPubKey:
        final reader = await crypto.getOrCreateEncryptionReaderKey(wallet);
        return {
          'readerDid': reader.did,
          'publicKeyHex': reader.publicKeyHex,
          'algorithm': 'x25519',
        };

      case WCRequestType.unknown:
        throw Exception('Unknown request method: ${request.method}');
    }
  }

  dynamic _extractParam(dynamic params) {
    if (params is List && params.isNotEmpty) return params.first;
    return params;
  }

  dynamic _tryParseJson(String input) {
    try {
      return jsonDecode(input);
    } catch (_) {
      return null;
    }
  }
}
