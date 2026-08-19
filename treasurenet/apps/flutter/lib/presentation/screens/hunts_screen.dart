import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../data/models/hunt_models.dart';
import '../../providers/hunt_provider.dart';
import '../../providers/session_provider.dart';
import '../../providers/wallet_provider.dart';

/// Home: active hunts, consent status, wallet entry point.
class HuntsScreen extends ConsumerStatefulWidget {
  const HuntsScreen({super.key});

  @override
  ConsumerState<HuntsScreen> createState() => _HuntsScreenState();
}

class _HuntsScreenState extends ConsumerState<HuntsScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() => ref.read(huntsProvider.notifier).load());
  }

  @override
  Widget build(BuildContext context) {
    final hunts = ref.watch(huntsProvider);
    final consent = ref.watch(consentProvider);
    final auth = ref.watch(sessionProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('TreasureNet'),
        actions: [
          IconButton(
            tooltip: 'Wallet + receipts',
            icon: const Icon(Icons.account_balance_wallet_outlined),
            onPressed: () => context.go('/wallet'),
          ),
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await ref.read(sessionProvider.notifier).logout();
              if (context.mounted) context.go('/login');
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(huntsProvider.notifier).load(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            consent.maybeWhen(
              data: (status) {
                if (status != null && status.isValid) {
                  return Card(
                    color: Theme.of(context).colorScheme.surfaceContainerHighest,
                    child: ListTile(
                      leading: const Icon(Icons.verified_user_outlined),
                      title: const Text('Location + photo consent active'),
                      subtitle: Text(
                        'valid until '
                        '${status.expiresAt.toLocal().toString().split(' ').first}',
                      ),
                      trailing: TextButton(
                        onPressed: () => context.go('/consent'),
                        child: const Text('Details'),
                      ),
                    ),
                  );
                }
                return Card(
                  color: Theme.of(context).colorScheme.errorContainer,
                  child: ListTile(
                    leading: const Icon(Icons.privacy_tip_outlined),
                    title: const Text('Consent required to play'),
                    subtitle: const Text(
                      'Grant location + photo processing consent to check in '
                      'and claim rewards.',
                    ),
                    trailing: FilledButton(
                      onPressed: () => context.go('/consent'),
                      child: const Text('Grant'),
                    ),
                  ),
                );
              },
              orElse: () => const SizedBox.shrink(),
            ),
            const SizedBox(height: 8),
            Text(
              'Playing as',
              style: Theme.of(context).textTheme.labelMedium,
            ),
            Text(
              auth.did ?? '',
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
            ),
            const SizedBox(height: 12),
            if (hunts.loading) const Center(child: CircularProgressIndicator()),
            if (hunts.error != null)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(
                  hunts.error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (!hunts.loading && hunts.hunts.isEmpty)
              const Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'No hunts yet. A Game Master creates hunts from the web console.',
                  textAlign: TextAlign.center,
                ),
              ),
            for (final hunt in hunts.hunts) _HuntCard(hunt: hunt),
          ],
        ),
      ),
    );
  }
}

class _HuntCard extends StatelessWidget {
  const _HuntCard({required this.hunt});

  final Hunt hunt;

  @override
  Widget build(BuildContext context) {
    final color = switch (hunt.status) {
      'active' => Colors.green,
      'completed' => Colors.blueGrey,
      'paused' => Colors.orange,
      'funded' => Colors.teal,
      _ => Colors.grey,
    };
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: ListTile(
        title: Text(hunt.title),
        subtitle: Text(
          '${hunt.clues.length} clues · expires '
          '${hunt.expiresAt.toLocal().toString().split(' ').first} · escrow '
          '${hunt.escrowId}',
        ),
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.25),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                hunt.status,
                style: const TextStyle(fontSize: 11),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              '${hunt.rewardAmount} ${hunt.rewardToken}',
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
          ],
        ),
        onTap: hunt.isActive
            ? () => context.go('/hunts/${hunt.huntId}')
            : null,
      ),
    );
  }
}
