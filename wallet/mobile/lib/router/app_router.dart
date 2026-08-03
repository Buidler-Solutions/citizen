import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../presentation/screens/lock_screen.dart';
import '../presentation/screens/main_screen.dart';
import '../providers/security_provider.dart';

final appRouterProvider = Provider<GoRouter>((ref) {
  final securityState = ref.watch(securityProvider);

  return GoRouter(
    initialLocation: '/',
    redirect: (context, state) {
      final isLocked = securityState.hasPassword && !securityState.isUnlocked;
      final isOnLock = state.matchedLocation == '/lock';

      if (isLocked && !isOnLock) return '/lock';
      if (!isLocked && isOnLock) return '/';
      return null;
    },
    routes: [
      GoRoute(
        path: '/lock',
        builder: (context, state) => const LockScreen(),
      ),
      GoRoute(
        path: '/',
        builder: (context, state) => const MainScreen(),
      ),
    ],
  );
});
