import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/models/wallet_models.dart';
import '../data/services/walletconnect_service.dart';

class WalletConnectState {
  final bool initialized;
  final List<WCSessionInfo> sessions;
  final WCRequest? pendingRequest;
  final SessionProposalData? pendingProposal;
  final String? error;

  const WalletConnectState({
    this.initialized = false,
    this.sessions = const [],
    this.pendingRequest,
    this.pendingProposal,
    this.error,
  });

  WalletConnectState copyWith({
    bool? initialized,
    List<WCSessionInfo>? sessions,
    WCRequest? pendingRequest,
    SessionProposalData? pendingProposal,
    String? error,
  }) {
    return WalletConnectState(
      initialized: initialized ?? this.initialized,
      sessions: sessions ?? this.sessions,
      pendingRequest: pendingRequest ?? this.pendingRequest,
      pendingProposal: pendingProposal ?? this.pendingProposal,
      error: error,
    );
  }
}

class SessionProposalData {
  final int id;
  final String dappName;
  final String dappUrl;
  final String dappIcon;

  const SessionProposalData({
    required this.id,
    required this.dappName,
    required this.dappUrl,
    this.dappIcon = '',
  });
}

class WalletConnectNotifier extends StateNotifier<WalletConnectState> {
  final WalletConnectService _service;

  WalletConnectNotifier(this._service) : super(const WalletConnectState());

  Future<void> initialize() async {
    _service.onRequest = (request) {
      state = state.copyWith(pendingRequest: request);
    };
    _service.onSessionProposal = ({
      required int id,
      required String dappName,
      required String dappUrl,
      required String dappIcon,
    }) {
      state = state.copyWith(
        pendingProposal: SessionProposalData(
          id: id,
          dappName: dappName,
          dappUrl: dappUrl,
          dappIcon: dappIcon,
        ),
      );
    };
    _service.onSessionsChanged = _onServiceChanged;

    try {
      await _service.initialize();
      state = state.copyWith(
        initialized: true,
        sessions: _service.sessions,
      );
    } catch (e) {
      state = state.copyWith(error: e.toString());
    }
  }

  void _onServiceChanged() {
    state = state.copyWith(sessions: _service.sessions);
  }

  Future<void> pairWithUri(String uri) async {
    try {
      await _service.pairWithUri(uri);
    } catch (e) {
      state = state.copyWith(error: e.toString());
    }
  }

  Future<void> approveProposal(StoredWallet wallet) async {
    final proposal = state.pendingProposal;
    if (proposal == null) return;
    try {
      await _service.approveSession(id: proposal.id, wallet: wallet);
      state = state.copyWith(pendingProposal: null);
    } catch (e) {
      state = state.copyWith(error: e.toString());
    }
  }

  Future<void> rejectProposal() async {
    final proposal = state.pendingProposal;
    if (proposal == null) return;
    try {
      await _service.rejectSession(id: proposal.id);
    } catch (e) {
      state = state.copyWith(error: e.toString());
    }
    state = state.copyWith(pendingProposal: null);
  }

  Future<void> approveRequest(StoredWallet wallet) async {
    final request = state.pendingRequest;
    if (request == null) return;
    try {
      final result = await _service.processRequest(
        request: request,
        wallet: wallet,
      );
      await _service.respondRequest(
        topic: request.topic,
        id: request.id,
        result: result,
      );
    } catch (e) {
      await _service.respondError(
        topic: request.topic,
        id: request.id,
        error: e.toString(),
      );
    }
    state = state.copyWith(pendingRequest: null);
  }

  Future<void> rejectRequest() async {
    final request = state.pendingRequest;
    if (request == null) return;
    await _service.respondError(
      topic: request.topic,
      id: request.id,
      error: 'User rejected request',
    );
    state = state.copyWith(pendingRequest: null);
  }

  Future<void> disconnectSession(String topic) async {
    try {
      await _service.disconnectSession(topic);
    } catch (e) {
      state = state.copyWith(error: e.toString());
    }
  }

  void clearError() {
    state = state.copyWith(error: null);
  }

  @override
  void dispose() {
    _service.onSessionsChanged = null;
    super.dispose();
  }
}

final walletConnectServiceProvider = Provider<WalletConnectService>((ref) {
  return WalletConnectService();
});

final walletConnectProvider =
    StateNotifierProvider<WalletConnectNotifier, WalletConnectState>((ref) {
  return WalletConnectNotifier(ref.read(walletConnectServiceProvider));
});
