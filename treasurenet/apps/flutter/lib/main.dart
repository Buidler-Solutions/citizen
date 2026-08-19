import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/theme/app_theme.dart';
import 'data/services/storage_service.dart';
import 'providers/session_provider.dart';
import 'router/app_router.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  const secure = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  final prefs = await SharedPreferences.getInstance();
  runApp(
    ProviderScope(
      overrides: [
        storageProvider.overrideWithValue(StorageService(secure, prefs)),
      ],
      child: const TreasurenetApp(),
    ),
  );
}

class TreasurenetApp extends ConsumerWidget {
  const TreasurenetApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    return MaterialApp.router(
      title: 'TreasureNet',
      themeMode: ThemeMode.dark,
      darkTheme: AppTheme.dark(),
      routerConfig: router,
    );
  }
}
