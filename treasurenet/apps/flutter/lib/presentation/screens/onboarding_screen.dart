import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../providers/session_provider.dart';

/// Onboarding: generate the device Ed25519 keypair, register the wallet DID.
/// The private key is created and stored on device; it is never displayed
/// in full or transmitted.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  bool _busy = false;

  Future<void> _create() async {
    setState(() => _busy = true);
    await ref.read(sessionProvider.notifier).createIdentity();
    if (!mounted) return;
    setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(sessionProvider);
    final did = auth.did;
    return Scaffold(
      appBar: AppBar(title: const Text('Create your player identity')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Icon(Icons.map_outlined, size: 56),
          const SizedBox(height: 8),
          Text(
            'TreasureNet Citizen Edition',
            style: Theme.of(context).textTheme.headlineSmall,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          const Text(
            'Your identity is an Ed25519 keypair generated on this device. '
            'The private key stays in secure platform storage (Keychain or '
            'Keystore); the network only ever sees your DID and signatures. '
            'Playing is sponsored by builder credits: you never need tokens.',
          ),
          const SizedBox(height: 24),
          if (did != null) ...[
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Your DID', style: Theme.of(context).textTheme.labelMedium),
                    const SizedBox(height: 4),
                    SelectableText(
                      did,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                    ),
                    const SizedBox(height: 8),
                    Align(
                      alignment: Alignment.centerRight,
                      child: IconButton(
                        tooltip: 'Copy DID',
                        icon: const Icon(Icons.copy),
                        onPressed: () {
                          Clipboard.setData(ClipboardData(text: did));
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('DID copied')),
                          );
                        },
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),
          ],
          if (auth.error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                auth.error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          FilledButton(
            onPressed: _busy ? null : _create,
            child: _busy
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(did == null ? 'Generate keypair + register' : 'Regenerate'),
          ),
          if (did != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                'Wallet registered. Continue to sign in.',
                style: Theme.of(context).textTheme.bodySmall,
                textAlign: TextAlign.center,
              ),
            ),
        ],
      ),
    );
  }
}
