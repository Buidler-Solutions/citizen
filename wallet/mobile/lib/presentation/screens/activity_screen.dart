import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/network_config.dart';
import '../../providers/activity_provider.dart';
import '../../providers/wallet_provider.dart';
import '../../providers/network_provider.dart';

class ActivityScreen extends ConsumerWidget {
  const ActivityScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final activity = ref.watch(activityProvider);
    final walletState = ref.watch(walletProvider);
    final networkState = ref.watch(networkProvider);

    final signer = walletState.signer;
    final selectedNetwork = networkState.selectedNetwork;
    final networkInfo = NetworkInfo.fromId(selectedNetwork);

    return Scaffold(
      appBar: AppBar(title: const Text('Activity')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        networkState.isSelectedAlive ? Icons.check_circle : Icons.error_outline,
                        color: networkState.isSelectedAlive ? Colors.green : Colors.orange,
                        size: 20,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        networkInfo.label,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  if (signer != null)
                    Text(
                      signer.did,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6),
                          ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            'Recent Activity',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          if (activity.entries.isEmpty)
            Card(
              child: ListTile(
                leading: const Icon(Icons.history, color: Colors.grey),
                title: const Text('No activity yet'),
                subtitle: const Text('Signing and submission events will appear here.'),
              ),
            )
          else
            ...activity.entries.map((entry) => Card(
                  child: ListTile(
                    leading: const Icon(Icons.flash_on, color: Colors.blue),
                    title: Text(entry.method, style: const TextStyle(fontSize: 14)),
                    subtitle: Text(
                      '${entry.origin} - ${entry.requestedAt.substring(0, 19)}',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                )),
        ],
      ),
    );
  }
}
