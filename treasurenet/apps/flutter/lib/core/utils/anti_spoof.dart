import 'dart:math' as math;

/// Anti-spoof heuristics for GPS check-ins (gap 13).
///
/// The device-side signal is weak by nature (any client can lie), so these
/// checks aim to raise the cost of casual spoofing: mock-provider flags from
/// the OS, physically impossible inter-fix speeds, and the accelerometer
/// cross-check that flags a perfectly still device whose GPS claims walking
/// speed displacement. Everything here is pure Dart so the heuristics are
/// unit-testable without platform channels.
class FixSample {
  const FixSample({
    required this.latitude,
    required this.longitude,
    required this.timestampMs,
    this.accuracyMeters,
  });

  final double latitude;
  final double longitude;
  final int timestampMs;
  final double? accuracyMeters;
}

enum TrustVerdict { trusted, suspicious, rejected }

class TrustAssessment {
  const TrustAssessment(this.verdict, this.reasons);

  final TrustVerdict verdict;
  final List<String> reasons;

  bool get ok => verdict != TrustVerdict.rejected;
}

const double _earthRadiusMeters = 6371000.0;

double _distanceMeters(FixSample a, FixSample b) {
  double toRad(double deg) => deg * math.pi / 180.0;
  final dLat = toRad(b.latitude - a.latitude);
  final dLon = toRad(b.longitude - a.longitude);
  final h = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(toRad(a.latitude)) *
          math.cos(toRad(b.latitude)) *
          math.sin(dLon / 2) *
          math.sin(dLon / 2);
  return 2 * _earthRadiusMeters * math.asin(math.sqrt(h));
}

/// ~200 km/h: faster than any ground transport a treasure hunt allows.
const double maxPlausibleSpeedMps = 56.0;

/// ~5 km/h: the floor of sustained human walking pace.
const double sustainedWalkSpeedMps = 1.4;

/// Variance of gravity-free acceleration magnitude below which the device
/// counts as perfectly still. Handheld walking motion jitters well above
/// this; a phone resting on a desk sits two orders of magnitude below.
const double stillAccelVariance = 0.0025;

/// Speed implied by two consecutive fixes, in m/s.
double impliedSpeedMps(FixSample a, FixSample b) {
  final dtSeconds = (b.timestampMs - a.timestampMs) / 1000.0;
  if (dtSeconds <= 0) return double.infinity;
  return _distanceMeters(a, b) / dtSeconds;
}

/// Verdict over a sequence of fixes plus the accelerometer evidence
/// gathered over the same window.
TrustAssessment assessLocationTrust({
  required List<FixSample> fixes,
  required double userAccelVariance,
}) {
  final reasons = <String>[];
  var worst = TrustVerdict.trusted;

  if (fixes.length < 2) {
    return const TrustAssessment(TrustVerdict.suspicious, [
      'not enough fixes for anti-spoof analysis',
    ]);
  }

  var maxSpeed = 0.0;
  for (var i = 1; i < fixes.length; i++) {
    final speed = impliedSpeedMps(fixes[i - 1], fixes[i]);
    if (speed.isNaN || speed.isInfinite) {
      reasons.add('fix timestamps are not strictly increasing');
      worst = TrustVerdict.rejected;
      continue;
    }
    maxSpeed = math.max(maxSpeed, speed);
  }
  if (maxSpeed > maxPlausibleSpeedMps) {
    reasons.add(
      'implied speed ${maxSpeed.toStringAsFixed(1)} m/s exceeds '
      '${maxPlausibleSpeedMps.toStringAsFixed(0)} m/s',
    );
    worst = TrustVerdict.rejected;
  }

  final window = fixes.last.timestampMs - fixes.first.timestampMs;
  final displacement = _distanceMeters(fixes.first, fixes.last);
  final sustainedSpeed =
      window > 0 ? displacement / (window / 1000.0) : double.infinity;
  if (sustainedSpeed >= sustainedWalkSpeedMps &&
      userAccelVariance < stillAccelVariance) {
    reasons.add(
      'GPS shows sustained ${sustainedSpeed.toStringAsFixed(1)} m/s '
      'displacement but the device is motionless (accelerometer variance '
      '${userAccelVariance.toStringAsFixed(5)} < '
      '${stillAccelVariance.toStringAsFixed(4)})',
    );
    worst = TrustVerdict.rejected;
  }

  if (reasons.isEmpty) return const TrustAssessment(TrustVerdict.trusted, []);
  return TrustAssessment(worst, reasons);
}

/// Variance of a magnitude series; used by the sensor sampler so the same
/// math runs in production and in tests.
double magnitudeVariance(List<double> magnitudes) {
  if (magnitudes.length < 2) return 0;
  final mean = magnitudes.reduce((a, b) => a + b) / magnitudes.length;
  final sum = magnitudes
      .map((m) => (m - mean) * (m - mean))
      .reduce((a, b) => a + b);
  return sum / (magnitudes.length - 1);
}
