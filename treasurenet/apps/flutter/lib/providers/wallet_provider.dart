import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/models/hunt_models.dart';
import '../data/services/api_service.dart';
import 'hunt_provider.dart';
import 'session_provider.dart';

@immutable
class WalletState {
  const WalletState({
    this.balance,
    this.receipts = const [],
    this.notifications = const [],
    this.loading = false,
    this.error,
  });

  final WalletBalance? balance;
  final List<FinalityReceipt> receipts;
  final List<WalletNotification> notifications;
  final bool loading;
  final String? error;

  WalletState copyWith({
    WalletBalance? balance,
    List<FinalityReceipt>? receipts,
    List<WalletNotification>? notifications,
    bool? loading,
    String? error,
  }) =>
      WalletState(
        balance: balance ?? this.balance,
        receipts: receipts ?? this.receipts,
        notifications: notifications ?? this.notifications,
        loading: loading ?? this.loading,
        error: error,
      );
}

class WalletController extends StateNotifier<WalletState> {
  WalletController(this._api, this._did) : super(const WalletState());

  final TreasurenetApi _api;
  final String _did;

  Future<void> load() async {
    state = state.copyWith(loading: true, error: null);
    try {
      final results = await Future.wait<dynamic>([
        _api.balance(_did),
        _api.receipts(_did),
        _api.notifications(_did),
      ]);
      state = WalletState(
        balance: results[0] as WalletBalance,
        receipts: results[1] as List<FinalityReceipt>,
        notifications: results[2] as List<WalletNotification>,
      );
    } catch (error) {
      state = state.copyWith(loading: false, error: error.toString());
    }
  }
}

final sessionDidProvider = Provider<String?>(
  (ref) => ref.watch(sessionProvider.select((auth) => auth.did)),
);

final walletProvider = StateNotifierProvider<WalletController, WalletState>(
  (ref) => WalletController(
    ref.watch(apiProvider),
    ref.watch(sessionDidProvider.select((did) => did ?? '')),
  ),
);

final consentProvider = FutureProvider<ConsentStatus?>((ref) async {
  final did = ref.watch(sessionDidProvider);
  if (did == null) return null;
  return ref.watch(apiProvider).consentStatus();
});
