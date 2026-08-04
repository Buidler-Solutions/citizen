import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/network_config.dart';
import '../../providers/network_provider.dart';
import '../../providers/walletconnect_provider.dart';
import '../widgets/wc_request_dialog.dart';
import 'activity_screen.dart';
import 'connect_screen.dart';
import 'decrypt_screen.dart';
import 'compose_screen.dart';
import 'vote_screen.dart';
import 'vault_screen.dart';
import 'security_screen.dart';
import 'profile_screen.dart';

class MainScreen extends ConsumerStatefulWidget {
  const MainScreen({super.key});

  @override
  ConsumerState<MainScreen> createState() => _MainScreenState();
}

class _MainScreenState extends ConsumerState<MainScreen> {
  int _currentIndex = 0;

  final _screens = const [
    ActivityScreen(),
    ConnectScreen(),
    DecryptScreen(),
    ComposeScreen(),
    VoteScreen(),
    VaultScreen(),
    SecurityScreen(),
    ProfileScreen(),
  ];

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final networkState = ref.read(networkProvider);
      if (networkState.selectedNetwork == NetworkId.mainnet &&
          networkState.liveness.isEmpty) {
        ref.read(networkProvider.notifier).checkLiveness();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(walletConnectProvider, (previous, next) {
      if (next.pendingProposal != null || next.pendingRequest != null) {
        WCRequestDialog.show(context);
      }
    });

    return Scaffold(
      body: _screens[_currentIndex],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _currentIndex,
        onDestinationSelected: (index) => setState(() => _currentIndex = index),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.receipt_long_outlined),
            selectedIcon: Icon(Icons.receipt_long),
            label: 'Activity',
          ),
          NavigationDestination(
            icon: Icon(Icons.link_outlined),
            selectedIcon: Icon(Icons.link),
            label: 'Connect',
          ),
          NavigationDestination(
            icon: Icon(Icons.lock_open_outlined),
            selectedIcon: Icon(Icons.lock_open),
            label: 'Decrypt',
          ),
          NavigationDestination(
            icon: Icon(Icons.edit_note_outlined),
            selectedIcon: Icon(Icons.edit_note),
            label: 'Compose',
          ),
          NavigationDestination(
            icon: Icon(Icons.how_to_vote_outlined),
            selectedIcon: Icon(Icons.how_to_vote),
            label: 'Vote',
          ),
          NavigationDestination(
            icon: Icon(Icons.account_balance_wallet_outlined),
            selectedIcon: Icon(Icons.account_balance_wallet),
            label: 'Vault',
          ),
          NavigationDestination(
            icon: Icon(Icons.security_outlined),
            selectedIcon: Icon(Icons.security),
            label: 'Security',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: 'Profile',
          ),
        ],
      ),
    );
  }
}
