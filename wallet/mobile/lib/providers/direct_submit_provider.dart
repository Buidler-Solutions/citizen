import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/utils/canonical_json.dart';
import '../data/models/direct_submit.dart';
import '../data/models/wallet_models.dart';
import '../data/services/citizen_api_service.dart';
import '../data/services/crypto_service.dart';
import '../data/services/storage_service.dart';
import 'service_providers.dart';
import 'wallet_provider.dart';

class DirectSubmitState {
  final List<DirectSubmitReceipt> receipts;
  final String defaultDestination;
  final bool submitting;
  final String? lastError;
  final DirectSubmitResponse? lastResponse;

  const DirectSubmitState({
    this.receipts = const [],
    this.defaultDestination = '',
    this.submitting = false,
    this.lastError,
    this.lastResponse,
  });

  DirectSubmitState copyWith({
    List<DirectSubmitReceipt>? receipts,
    String? defaultDestination,
    bool? submitting,
    String? lastError,
    DirectSubmitResponse? lastResponse,
  }) {
    return DirectSubmitState(
      receipts: receipts ?? this.receipts,
      defaultDestination: defaultDestination ?? this.defaultDestination,
      submitting: submitting ?? this.submitting,
      lastError: lastError,
      lastResponse: lastResponse ?? this.lastResponse,
    );
  }
}

class DirectSubmitNotifier extends StateNotifier<DirectSubmitState> {
  final CitizenApiService _api;
  final StorageService _storage;
  final CryptoService _crypto;
  final Ref _ref;

  DirectSubmitNotifier(this._api, this._storage, this._crypto, this._ref)
      : super(const DirectSubmitState());

  Future<void> initialize() async {
    final receipts = await _storage.getReceipts();
    final dest = await _storage.getDirectSubmitDefaultDestination();
    state = state.copyWith(receipts: receipts, defaultDestination: dest);
  }

  Future<void> setDefaultDestination(String url) async {
    await _storage.setDirectSubmitDefaultDestination(url);
    state = state.copyWith(defaultDestination: url);
  }

  Future<DirectSubmitResponse?> submitSignedPayload({
    required Map<String, dynamic> payload,
    String? destinationUrl,
    bool consentToShareSigningPayload = false,
  }) async {
    final walletState = _ref.read(walletProvider);
    final wallet = walletState.activeWallet;
    if (wallet == null) {
      state = state.copyWith(lastError: 'No active wallet configured.');
      return null;
    }

    state = state.copyWith(submitting: true, lastError: null);

    try {
      final signingPayload = canonicalJson(payload);
      final payloadHash = await _crypto.sha256DigestHex(signingPayload);
      final signResult = await _crypto.signProtocolPayload(wallet, signingPayload);

      final artifact = SignedSubmissionArtifact(
        signerDid: signResult.signerDid,
        verifyingKey: signResult.verifyingKey,
        signature: signResult.signature,
        payloadHash: payloadHash,
        signingPayload: signingPayload,
        signatureScope: 'canonical_payload_v1',
        algorithm: 'ed25519',
      );

      final dest = destinationUrl ?? state.defaultDestination;
      final response = await _api.submitSignedArtifact(
        destinationUrl: dest,
        signedArtifact: artifact,
        consentToShareSigningPayload: consentToShareSigningPayload,
      );

      final networkId = await _storage.getSelectedNetwork();
      final receipt = DirectSubmitReceipt(
        requestId: artifact.requestId ?? 'direct-${DateTime.now().millisecondsSinceEpoch}',
        payloadHash: artifact.payloadHash,
        walletId: wallet.id,
        signerDid: signResult.signerDid,
        networkId: networkId,
        destinationUrl: dest,
        traceId: response.traceId,
        status: response.status,
        latencyMs: response.latencyMs,
        receiptId: response.receiptId,
        receiptHash: response.receiptHash,
        blockHeight: response.blockHeight,
        submittedAt: DateTime.now().toIso8601String(),
      );
      await _storage.appendReceipt(receipt);
      final receipts = await _storage.getReceipts();

      state = DirectSubmitState(
        receipts: receipts,
        defaultDestination: state.defaultDestination,
        lastResponse: response,
      );
      return response;
    } catch (e) {
      state = state.copyWith(submitting: false, lastError: e.toString());
      return null;
    }
  }

  Future<String?> signMessage(StoredWallet wallet, String message) async {
    return _crypto.signWithEd25519(wallet, message);
  }

  Future<String?> signAuthChallenge(StoredWallet wallet, String message) async {
    return _crypto.signAuthChallenge(wallet, message);
  }
}

final directSubmitProvider =
    StateNotifierProvider<DirectSubmitNotifier, DirectSubmitState>((ref) {
  return DirectSubmitNotifier(
    ref.read(citizenApiServiceProvider),
    ref.read(storageServiceProvider),
    ref.read(cryptoServiceProvider),
    ref,
  );
});
