import 'package:flutter_test/flutter_test.dart';
import 'package:treasurenet_mobile/core/utils/anti_spoof.dart';

FixSample fix(double lat, double lon, int seconds) => FixSample(
      latitude: lat,
      longitude: lon,
      timestampMs: seconds * 1000,
    );

void main() {
  group('assessLocationTrust', () {
    test('still device near a fixed point is trusted', () {
      final assessment = assessLocationTrust(
        fixes: [fix(10.3167, 123.8908, 0), fix(10.31670, 123.89080, 4)],
        userAccelVariance: 0.0001,
      );
      expect(assessment.verdict, TrustVerdict.trusted);
      expect(assessment.reasons, isEmpty);
    });

    test('walking device with jiggling accelerometer is trusted', () {
      final assessment = assessLocationTrust(
        fixes: [fix(10.3167, 123.8908, 0), fix(10.31675, 123.89085, 4)],
        userAccelVariance: 0.8,
      );
      expect(assessment.verdict, TrustVerdict.trusted);
    });

    test('still device whose GPS claims walking speed is rejected', () {
      final assessment = assessLocationTrust(
        fixes: [fix(10.3167, 123.8908, 0), fix(10.31675, 123.89085, 4)],
        userAccelVariance: 0.00005,
      );
      expect(assessment.verdict, TrustVerdict.rejected);
      expect(assessment.ok, isFalse);
      expect(
        assessment.reasons.join('; '),
        contains('device is motionless'),
      );
    });

    test('impossible inter-fix speed is rejected regardless of accelerometer',
        () {
      final assessment = assessLocationTrust(
        fixes: [fix(10.3167, 123.8908, 0), fix(10.3300, 123.9000, 2)],
        userAccelVariance: 1.5,
      );
      expect(assessment.verdict, TrustVerdict.rejected);
      expect(assessment.reasons.join('; '), contains('exceeds'));
    });

    test('non-increasing timestamps are rejected', () {
      final assessment = assessLocationTrust(
        fixes: [fix(10.3167, 123.8908, 5), fix(10.3168, 123.8909, 5)],
        userAccelVariance: 0.5,
      );
      expect(assessment.verdict, TrustVerdict.rejected);
      expect(assessment.reasons.join('; '),
          contains('not strictly increasing'));
    });

    test('fewer than two fixes is suspicious but not a hard failure', () {
      final assessment = assessLocationTrust(
        fixes: [fix(10.3167, 123.8908, 0)],
        userAccelVariance: 0.5,
      );
      expect(assessment.verdict, TrustVerdict.suspicious);
      expect(assessment.ok, isTrue);
    });
  });

  group('impliedSpeedMps', () {
    test('one degree of latitude in an hour is about 111 km/h', () {
      final speed = impliedSpeedMps(fix(10, 123, 0), fix(11, 123, 3600));
      expect(speed, closeTo(30.9, 0.5));
    });
  });

  group('magnitudeVariance', () {
    test('constant series has zero variance', () {
      expect(magnitudeVariance([2, 2, 2, 2]), 0);
    });

    test('varied series has positive variance', () {
      expect(magnitudeVariance([0, 1, 0, 1]), closeTo(0.3333, 0.001));
    });

    test('short series do not divide by zero', () {
      expect(magnitudeVariance([]), 0);
      expect(magnitudeVariance([3.2]), 0);
    });
  });
}
