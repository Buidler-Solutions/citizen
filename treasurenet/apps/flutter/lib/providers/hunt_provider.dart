import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:sensors_plus/sensors_plus.dart';

import '../core/utils/anti_spoof.dart';
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
  if (position.isMocked) {
    throw LocationException(
      'device reports a mocked location source; check in from a real GPS fix',
    );
  }
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

/// Fix plus the anti-spoof evidence gathered while taking it. Server-side
/// verification never trusts these claims, but attaching them (and gating
/// on them locally) blocks the casual spoofing path.
@immutable
class TrustedFix {
  const TrustedFix({
    required this.fix,
    required this.assessment,
  });

  final GpsFix fix;
  final TrustAssessment assessment;
}

/// Samples gravity-free accelerometer magnitudes for [window] and returns
/// their variance. A motionless device sits near zero; handheld walking
/// motion is orders of magnitude above. Returns NaN when no sensor stream
Future<double> sampleAccelVariance(Duration window) async {
  final magnitudes = <double>[];
  final done = Completer<void>();
  final subscription = userAccelerometerEventStream().listen(
    (event) {
      magnitudes.add(
        math.sqrt(
          event.x * event.x + event.y * event.y + event.z * event.z,
        ),
      );
    },
    onError: (Object error) {},
    cancelOnError: false,
  );
  final timer = Timer(window, () {
    subscription.cancel();
    if (!done.isCompleted) done.complete();
  });
  await done.future;
  timer.cancel();
  if (magnitudes.isEmpty) return double.nan;
  return magnitudeVariance(magnitudes);
}

/// GPS fix hardened with gap-13 anti-spoof checks: OS mock-provider flag,
/// physically impossible inter-fix speeds, and the still-device-vs-moving-GPS
/// accelerometer contradiction. Takes [window] of sampling, so callers
/// should surface a progress state.
Future<TrustedFix> trustedFix({Duration window = const Duration(seconds: 4)}) async {
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

  final accelFuture = sampleAccelVariance(window);
  final first = await Geolocator.getCurrentPosition(
    locationSettings: const LocationSettings(
      accuracy: LocationAccuracy.best,
      timeLimit: Duration(seconds: 20),
    ),
  );
  if (first.isMocked) {
    throw LocationException(
      'device reports a mocked location source; check in from a real GPS fix',
    );
  }
  final firstFix = GpsFix(
    latitude: first.latitude,
    longitude: first.longitude,
    accuracyMeters: first.accuracy,
  );
  if (first.accuracy <= 0 ||
      first.accuracy < 0.5 ||
      first.accuracy > 500) {
    throw LocationException(
      'location fix quality insufficient (${first.accuracy.round()}m); '
      'try again outdoors',
    );
  }

  final accelVariance = await accelFuture;
  final second = await Geolocator.getCurrentPosition(
    locationSettings: const LocationSettings(
      accuracy: LocationAccuracy.best,
      timeLimit: Duration(seconds: 20),
    ),
  );
  if (second.isMocked) {
    throw LocationException(
      'device reports a mocked location source; check in from a real GPS fix',
    );
  }
  final secondFix = GpsFix(
    latitude: second.latitude,
    longitude: second.longitude,
    accuracyMeters: second.accuracy,
  );

  final assessment = assessLocationTrust(
    fixes: [
      FixSample(
        latitude: firstFix.latitude,
        longitude: firstFix.longitude,
        timestampMs: first.timestamp.millisecondsSinceEpoch,
      ),
      FixSample(
        latitude: secondFix.latitude,
        longitude: secondFix.longitude,
        timestampMs: second.timestamp.millisecondsSinceEpoch,
      ),
    ],
    userAccelVariance: accelVariance,
  );
  if (!assessment.ok) {
    throw LocationException(
      'location proof rejected: ${assessment.reasons.join('; ')}',
    );
  }
  return TrustedFix(fix: secondFix, assessment: assessment);
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
