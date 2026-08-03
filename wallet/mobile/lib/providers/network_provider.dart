import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/models/network_config.dart';
import '../data/services/citizen_api_service.dart';
import '../data/services/storage_service.dart';
import 'service_providers.dart';

class NetworkState {
  final NetworkId selectedNetwork;
  final Map<NetworkId, bool> liveness;
  final bool checkingLiveness;

  const NetworkState({
    this.selectedNetwork = NetworkId.mainnet,
    this.liveness = const {},
    this.checkingLiveness = false,
  });

  NetworkState copyWith({
    NetworkId? selectedNetwork,
    Map<NetworkId, bool>? liveness,
    bool? checkingLiveness,
  }) {
    return NetworkState(
      selectedNetwork: selectedNetwork ?? this.selectedNetwork,
      liveness: liveness ?? this.liveness,
      checkingLiveness: checkingLiveness ?? this.checkingLiveness,
    );
  }

  bool isAlive(NetworkId id) => liveness[id] ?? false;
  bool get isSelectedAlive => isAlive(selectedNetwork);
}

class NetworkNotifier extends StateNotifier<NetworkState> {
  final CitizenApiService _api;
  final _storage = StorageService();

  NetworkNotifier(this._api) : super(const NetworkState());

  Future<void> initialize() async {
    final network = await _storage.getSelectedNetwork();
    state = state.copyWith(selectedNetwork: network);
    await checkLiveness();
  }

  Future<void> selectNetwork(NetworkId id) async {
    await _storage.setSelectedNetwork(id);
    state = state.copyWith(selectedNetwork: id);
  }

  Future<void> checkLiveness() async {
    state = state.copyWith(checkingLiveness: true);
    final liveness = await _api.getNetworkLiveness();
    state = state.copyWith(liveness: liveness, checkingLiveness: false);
  }
}

final networkProvider = StateNotifierProvider<NetworkNotifier, NetworkState>((ref) {
  return NetworkNotifier(ref.read(citizenApiServiceProvider));
});
