import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/utils/canonical_json.dart';
import '../data/models/network_config.dart';
import '../data/services/citizen_api_service.dart';
import '../data/services/crypto_service.dart';
import 'network_provider.dart';
import 'service_providers.dart';
import 'wallet_provider.dart';

class CivicProposal {
  final String proposalId;
  final String? title;
  final String? description;
  final int openedAt;
  final String openedBy;
  final String status;

  const CivicProposal({
    required this.proposalId,
    this.title,
    this.description,
    required this.openedAt,
    required this.openedBy,
    required this.status,
  });

  factory CivicProposal.fromJson(Map<String, dynamic> json) {
    return CivicProposal(
      proposalId: json['proposal_id'] as String? ?? '',
      title: json['title'] as String?,
      description: json['description'] as String?,
      openedAt: (json['opened_at'] as num?)?.toInt() ?? 0,
      openedBy: json['opened_by'] as String? ?? '',
      status: json['status'] as String? ?? 'open',
    );
  }
}

class CivicTally {
  final String proposalId;
  final int totalBallots;
  final Map<String, int> tally;
  final List<String> voters;

  const CivicTally({
    required this.proposalId,
    required this.totalBallots,
    required this.tally,
    required this.voters,
  });

  factory CivicTally.fromJson(Map<String, dynamic> json) {
    final rawTally = json['tally'] as Map<String, dynamic>? ?? {};
    final voters = (json['voters'] as List? ?? []).cast<String>();
    return CivicTally(
      proposalId: json['proposal_id'] as String? ?? '',
      totalBallots: (json['total_ballots'] as num?)?.toInt() ?? 0,
      tally: rawTally.map((k, v) => MapEntry(k, (v as num).toInt())),
      voters: voters,
    );
  }
}

class VoteState {
  final bool loading;
  final String? error;
  final List<CivicProposal> proposals;
  final CivicProposal? selectedProposal;
  final CivicTally? tally;
  final bool submitting;
  final String? lastResult;

  const VoteState({
    this.loading = false,
    this.error,
    this.proposals = const [],
    this.selectedProposal,
    this.tally,
    this.submitting = false,
    this.lastResult,
  });

  VoteState copyWith({
    bool? loading,
    String? error,
    List<CivicProposal>? proposals,
    CivicProposal? selectedProposal,
    CivicTally? tally,
    bool? submitting,
    String? lastResult,
    bool clearSelected = false,
    bool clearTally = false,
    bool clearResult = false,
  }) {
    return VoteState(
      loading: loading ?? this.loading,
      error: error,
      proposals: proposals ?? this.proposals,
      selectedProposal: clearSelected ? null : (selectedProposal ?? this.selectedProposal),
      tally: clearTally ? null : (tally ?? this.tally),
      submitting: submitting ?? this.submitting,
      lastResult: clearResult ? null : (lastResult ?? this.lastResult),
    );
  }
}

class VoteNotifier extends StateNotifier<VoteState> {
  final CitizenApiService _api;
  final CryptoService _crypto;
  final Ref _ref;

  VoteNotifier(this._api, this._crypto, this._ref) : super(const VoteState());

  String _getBaseUrl() {
    final networkState = _ref.read(networkProvider);
    return NetworkInfo.fromId(networkState.selectedNetwork).apiBaseUrl;
  }

  Future<void> fetchProposals() async {
    state = state.copyWith(loading: true, error: null);
    try {
      final baseUrl = _getBaseUrl();
      final results = await _api.getCivicProposals(baseUrl);
      final proposals = results.map(CivicProposal.fromJson).toList();
      state = state.copyWith(loading: false, proposals: proposals);
    } catch (e) {
      state = state.copyWith(loading: false, error: e.toString());
    }
  }

  void selectProposal(CivicProposal proposal) {
    state = state.copyWith(
      selectedProposal: proposal,
      clearTally: true,
      clearResult: true,
      error: null,
    );
    fetchTally(proposal.proposalId);
  }

  Future<void> fetchTally(String proposalId) async {
    try {
      final baseUrl = _getBaseUrl();
      final result = await _api.getCivicTally(baseUrl, proposalId);
      if (result != null) {
        state = state.copyWith(tally: CivicTally.fromJson(result));
      }
    } catch (_) {}
  }

  Future<void> castBallot(String choice) async {
    final proposal = state.selectedProposal;
    if (proposal == null) return;

    final walletState = _ref.read(walletProvider);
    final wallet = walletState.activeWallet;
    if (wallet == null) {
      state = state.copyWith(error: 'No active wallet configured.');
      return;
    }

    state = state.copyWith(submitting: true, error: null, clearResult: true);

    try {
      final signer = await _crypto.getOrCreateProtocolSigner(wallet);
      final signerDid = signer.did;
      final entryId = _generateUuid();

      final payload = <String, dynamic>{
        'proposal_id': proposal.proposalId,
        'choice': choice,
      };

      final timestamp = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final objectId = 'ballot-$signerDid-${proposal.proposalId}';

      final signingPayload = canonicalJson(<String, dynamic>{
        'entry_id': entryId,
        'namespace': 'civic.ballot',
        'action': 'CAST_BALLOT',
        'object_id': objectId,
        'payload': payload,
        'author': signerDid,
        'timestamp': timestamp,
      });

      final signature = await _crypto.signWithEd25519(wallet, signingPayload);

      final entry = <String, dynamic>{
        'entry_id': entryId,
        'namespace': 'civic.ballot',
        'action': 'CAST_BALLOT',
        'object_id': objectId,
        'payload': payload,
        'author': signerDid,
        'signature': signature,
        'timestamp': timestamp,
        'privacy_flag': false,
        'privacy_mode': 'none',
      };

      final baseUrl = _getBaseUrl();
      await _api.submitBallot(apiBaseUrl: baseUrl, entry: entry);

      state = state.copyWith(
        submitting: false,
        lastResult: 'Ballot cast: "$choice"',
      );
      await fetchTally(proposal.proposalId);
    } catch (e) {
      state = state.copyWith(submitting: false, error: e.toString());
    }
  }

  String _generateUuid() {
    final now = DateTime.now().millisecondsSinceEpoch;
    return '${now.toRadixString(16)}-${now.remainder(0xffff).toRadixString(16).padLeft(4, '0')}';
  }
}

final voteProvider = StateNotifierProvider<VoteNotifier, VoteState>((ref) {
  return VoteNotifier(
    ref.read(citizenApiServiceProvider),
    ref.read(cryptoServiceProvider),
    ref,
  );
});
