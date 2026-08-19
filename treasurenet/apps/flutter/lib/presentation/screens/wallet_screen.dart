import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../providers/wallet_provider.dart';

/// Wallet: CTZN balance, payout finality receipts, and notifications.
class WalletScreen extends ConsumerStatefulWidget {
  const WalletScreen({super.key});

  @override
  ConsumerState<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends ConsumerState<WalletScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() => ref.read(walletProvider.notifier).load());
  }

  @override
  Widget build(BuildContext context) {
    final wallet = ref.watch(walletProvider);
    const mono = TextStyle(fontFamily: 'monospace', fontSize: 11);
    return Scaffold(
      appBar: AppBar(title: const Text('Wallet')),
      body: RefreshIndicator(
        onRefresh: () => ref.read(walletProvider.notifier).load(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Balance', style: Theme.of(context).textTheme.labelMedium),
                    const SizedBox(height: 4),
                    Text(
                      '${wallet.balance?.balance ?? 0}',
                      style: Theme.of(context)
                          .textTheme
                          .headlineMedium
                          ?.copyWith(fontWeight: FontWeight.bold),
                    ),
                    Text(
                      '${wallet.balance?.token ?? 'CTZN'} · source '
                      '${wallet.balance?.source ?? '-'}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text('Finality receipts',
                style: Theme.of(context).textTheme.titleSmall),
            if (wallet.receipts.isEmpty)
              const Padding(
                padding: EdgeInsets.all(12),
                child: Text('No receipts yet. Claim a hunt to earn rewards.'),
              ),
            for (final receipt in wallet.receipts)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: const Icon(Icons.receipt_long_outlined),
                  title: Text(receipt.receiptId, style: mono),
                  subtitle: Text(
                    'block ${receipt.blockHeight}'
                    '${receipt.commitProof != null ? ' · ${receipt.commitProof}' : ''}',
                    style: mono,
                  ),
                ),
              ),
            const SizedBox(height: 16),
            Text('Notifications', style: Theme.of(context).textTheme.titleSmall),
            if (wallet.notifications.isEmpty)
              const Padding(
                padding: EdgeInsets.all(12),
                child: Text('Nothing yet.'),
              ),
            for (final notification in wallet.notifications)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: Icon(
                    notification.type.startsWith('claim.confirmed')
                        ? Icons.emoji_events_outlined
                        : Icons.notifications_outlined,
                  ),
                  title: Text(notification.message),
                  subtitle: Text(notification.type),
                ),
              ),
            if (wallet.loading) const LinearProgressIndicator(),
            if (wallet.error != null)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(
                  wallet.error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            const SizedBox(height: 24),
            OutlinedButton.icon(
              icon: const Icon(Icons.arrow_back),
              label: const Text('Back to hunts'),
              onPressed: () => context.go('/hunts'),
            ),
          ],
        ),
      ),
    );
  }
}
