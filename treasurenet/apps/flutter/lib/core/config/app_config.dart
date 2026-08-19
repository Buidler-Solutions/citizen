import 'dart:io';

/// App configuration. The backend base URL is overridable at build time:
///
///   flutter run --dart-define=TREASURENET_API=http://10.0.2.2:7755
///
/// 10.0.2.2 reaches the host loopback from the Android emulator; the iOS
/// simulator can use 127.0.0.1 directly.
class AppConfig {
  const AppConfig._();

  static const String apiBaseUrl = String.fromEnvironment(
    'TREASURENET_API',
    defaultValue: 'http://127.0.0.1:7755',
  );

  static bool get usesLoopbackHost =>
      apiBaseUrl.contains('127.0.0.1') && !Platform.isIOS && !Platform.isAndroid;

  static String get effectiveApiBaseUrl {
    if (apiBaseUrl.contains('127.0.0.1') && Platform.isAndroid) {
      return apiBaseUrl.replaceFirst('127.0.0.1', '10.0.2.2');
    }
    return apiBaseUrl;
  }
}
