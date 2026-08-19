import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../providers/hunt_provider.dart';
import '../../providers/wallet_provider.dart';

/// Consent: the Citizen consent receipt gating location + photo processing.
/// A valid receipt (90-day expiry) is required before check-ins and claims.
class ConsentScreen extends ConsumerStatefulWidget {
  const ConsentScreen({super.key});

  @override
  ConsumerState<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends ConsumerState<ConsentScreen> {
  bool _busy = false;

  Future<void> _grant() async {
    setState(() => _busy = true);
    try {
      await ref.read(apiProvider).grantConsent(['location', 'photo']);
      ref.invalidate(consentProvider);
    } on Exception {
      // surfaced via provider state below
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final consentAsync = ref.watch(consentProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Data consent')),
      body: consentAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(child: Text(error.toString())),
        data: (status) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              'TreasureNet processes your location (clue check-ins) and photos '
              '(oracle verification of your presence at the beacon). Citizen '
              'consent receipts cover this with a 90-day validity and can be '
              're-granted at any time.',
            ),
            const SizedBox(height: 16),
            if (status == null)
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('No consent receipt on file yet.'),
                ),
              )
            else
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(
                            status.isValid
                                ? Icons.verified_user
                                : Icons.warning_amber,
                            color: status.isValid ? Colors.green : Colors.orange,
                          ),
                          const SizedBox(width: 8),
                          Text(status.isValid ? 'Valid' : 'Expired'),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text('purposes ${status.purposes.join(', ')}'),
                      Text(
                        'granted ${status.grantedAt.toLocal()}',
                        style: const TextStyle(fontSize: 12),
                      ),
                      Text(
                        'expires ${status.expiresAt.toLocal()}',
                        style: const TextStyle(fontSize: 12),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        status.receiptId,
                        style:
                            const TextStyle(fontFamily: 'monospace', fontSize: 11),
                      ),
                    ],
                  ),
                ),
              ),
            const SizedBox(height: 16),
            FilledButton.icon(
              icon: _busy
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.how_to_reg_outlined),
              label: const Text('Grant location + photo consent'),
              onPressed: _busy ? null : _grant,
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () => context.go('/hunts'),
              child: const Text('Back to hunts'),
            ),
          ],
        ),
      ),
    );
  }
}
