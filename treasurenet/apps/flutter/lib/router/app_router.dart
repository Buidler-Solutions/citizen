import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../providers/session_provider.dart';
import '../presentation/screens/claim_screen.dart';
import '../presentation/screens/consent_screen.dart';
import '../presentation/screens/hunt_detail_screen.dart';
import '../presentation/screens/hunts_screen.dart';
import '../presentation/screens/login_screen.dart';
import '../presentation/screens/onboarding_screen.dart';
import '../presentation/screens/wallet_screen.dart';

/// Routing: onboarding -> login -> hunts, gated by session state.
final appRouterProvider = Provider<GoRouter>((ref) {
  final auth = ref.watch(sessionProvider);
  return GoRouter(
    initialLocation: '/hunts',
    redirect: (context, state) {
      final loggingIn = state.matchedLocation == '/login' ||
          state.matchedLocation == '/onboarding';
      switch (auth.status) {
        case AuthStatus.loading:
          return null;
        case AuthStatus.needsIdentity:
          return '/onboarding';
        case AuthStatus.needsLogin:
          return '/login';
        case AuthStatus.authenticated:
          return loggingIn ? '/hunts' : null;
      }
    },
    routes: [
      GoRoute(
        path: '/onboarding',
        builder: (context, state) => const OnboardingScreen(),
      ),
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: '/hunts',
        builder: (context, state) => const HuntsScreen(),
        routes: [
          GoRoute(
            path: ':huntId',
            builder: (context, state) =>
                HuntDetailScreen(huntId: state.pathParameters['huntId']!),
            routes: [
              GoRoute(
                path: 'claim',
                builder: (context, state) =>
                    ClaimScreen(huntId: state.pathParameters['huntId']!),
              ),
            ],
          ),
        ],
      ),
      GoRoute(
        path: '/wallet',
        builder: (context, state) => const WalletScreen(),
      ),
      GoRoute(
        path: '/consent',
        builder: (context, state) => const ConsentScreen(),
      ),
    ],
    errorBuilder: (context, state) => Scaffold(
      body: Center(child: Text('route not found: ${state.uri}')),
    ),
  );
});
