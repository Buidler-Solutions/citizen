import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

import '../data/models/hunt_models.dart';
import '../data/services/api_service.dart';
import 'session_provider.dart';

@immutable
class HuntsState {
  const HuntsState({
    this.hunts = const [],
    this.loading = false,
    this.error,
  });

  final List<Hunt> hunts;
  final bool loading;
  final String? error;

  HuntsState copyWith({List<Hunt>? hunts, bool? loading, String? error}) =>
      HuntsState(
        hunts: hunts ?? this.hunts,
        loading: loading ?? this.loading,
        error: error,
      );
}

/// Shared API instance owned by the session controller (bearer attached).
final apiProvider = Provider<TreasurenetApi>(
  (ref) => ref.read(sessionProvider.notifier).api,
);

class HuntsController extends StateNotifier<HuntsState> {
  HuntsController(this._api) : super(const HuntsState());

  final TreasurenetApi _api;

  Future<void> load() async {
    state = state.copyWith(loading: true, error: null);
    try {
      final hunts = await _api.listHunts();
      state = state.copyWith(hunts: hunts, loading: false);
    } catch (error) {
      state = state.copyWith(
        loading: false,
        error: toApiException(error).toString(),
      );
    }
  }
}

final huntsProvider =
    StateNotifierProvider<HuntsController, HuntsState>((ref) {
  return HuntsController(ref.watch(apiProvider));
});

/// Live progress for a single hunt (player's unlocked clue chain).
final huntProgressProvider =
    FutureProvider.family<HuntProgress?, String>((ref, huntId) {
  return ref.watch(apiProvider).huntProgress(huntId);
});

final huntProvider = FutureProvider.family<Hunt, String>((ref, huntId) {
  return ref.watch(apiProvider).getHunt(huntId);
});

/// One-shot GPS fix with a location-services sanity gate. Rejects fixes that
/// are impossibly exact (a hallmark of injected mock locations on emulators)
/// or too coarse to prove presence at a clue checkpoint.
@immutable
class GpsFix {
  const GpsFix({
    required this.latitude,
    required this.longitude,
    required this.accuracyMeters,
  });

  final double latitude;
  final double longitude;
  final double accuracyMeters;
}

class LocationException implements Exception {
  LocationException(this.message);
  final String message;

  @override
  String toString() => message;
}

Future<GpsFix> currentFix() async {
  var enabled = await Geolocator.isLocationServiceEnabled();
  if (!enabled) {
    enabled = await Geolocator.openLocationSettings();
    if (!enabled) throw LocationException('location services are off');
  }
  var permission = await Geolocator.checkPermission();
  if (permission == LocationPermission.denied) {
    permission = await Geolocator.requestPermission();
  }
  if (permission == LocationPermission.denied ||
      permission == LocationPermission.deniedForever) {
    throw LocationException('location permission is required to check in');
  }
  final position = await Geolocator.getCurrentPosition(
    locationSettings: const LocationSettings(
      accuracy: LocationAccuracy.best,
      timeLimit: Duration(seconds: 20),
    ),
  );
  final accuracy = position.accuracy;
  if (accuracy <= 0 || accuracy < 0.5) {
    throw LocationException('location fix looks mocked; try again outdoors');
  }
  if (accuracy > 500) {
    throw LocationException(
      'location fix too imprecise (${accuracy.round()}m)',
    );
  }
  return GpsFix(
    latitude: position.latitude,
    longitude: position.longitude,
    accuracyMeters: accuracy,
  );
}

double distanceMeters({
  required double lat1,
  required double lon1,
  required double lat2,
  required double lon2,
}) {
  // Haversine, mirroring the backend geo module.
  const earthRadiusMeters = 6371000.0;
  double toRad(double deg) => deg * math.pi / 180.0;
  final dLat = toRad(lat2 - lat1);
  final dLon = toRad(lon2 - lon1);
  final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(toRad(lat1)) *
          math.cos(toRad(lat2)) *
          math.sin(dLon / 2) *
          math.sin(dLon / 2);
  return 2 * earthRadiusMeters * math.asin(math.sqrt(a));
}
