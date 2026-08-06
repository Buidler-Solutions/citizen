import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme/app_theme.dart';
import 'providers/wallet_provider.dart';
import 'providers/network_provider.dart';
import 'providers/security_provider.dart';
import 'providers/activity_provider.dart';
import 'providers/profile_provider.dart';
import 'providers/direct_submit_provider.dart';
import 'providers/walletconnect_provider.dart';
import 'router/app_router.dart';

void main() {
  runApp(const ProviderScope(child: CitizenWalletApp()));
}

class CitizenWalletApp extends ConsumerStatefulWidget {
  const CitizenWalletApp({super.key});

  @override
  ConsumerState<CitizenWalletApp> createState() => _CitizenWalletAppState();
}

class _CitizenWalletAppState extends ConsumerState<CitizenWalletApp> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _initializeProviders();
    });
  }

  void _initializeProviders() {
    ref.read(securityProvider.notifier).initialize();
    ref.read(walletProvider.notifier).initialize();
    ref.read(networkProvider.notifier).initialize();
    ref.read(activityProvider.notifier).refresh();
    ref.read(profileProvider.notifier).refresh();
    ref.read(directSubmitProvider.notifier).initialize();
    ref.read(walletConnectProvider.notifier).initialize();
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(appRouterProvider);
    return MaterialApp.router(
      title: 'Citizen Wallet',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.dark(),
      routerConfig: router,
    );
  }
}
