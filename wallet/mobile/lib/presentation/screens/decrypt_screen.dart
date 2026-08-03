import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../providers/decrypt_provider.dart';
import '../../providers/wallet_provider.dart';

class DecryptScreen extends ConsumerStatefulWidget {
  const DecryptScreen({super.key});

  @override
  ConsumerState<DecryptScreen> createState() => _DecryptScreenState();
}

class _DecryptScreenState extends ConsumerState<DecryptScreen> {
  final _authorKeyController = TextEditingController();
  final _ciphertextController = TextEditingController();
  final _nonceController = TextEditingController();
  final _wrappedDekController = TextEditingController();

  @override
  void dispose() {
    _authorKeyController.dispose();
    _ciphertextController.dispose();
    _nonceController.dispose();
    _wrappedDekController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(decryptProvider);
    final walletState = ref.watch(walletProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Decrypt')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (walletState.activeWallet == null)
              Card(
                color: Colors.orange.withValues(alpha: 0.2),
                child: const Padding(
                  padding: EdgeInsets.all(12),
                  child: Text('Create or import a wallet first to decrypt transactions.'),
                ),
              )
            else ...[
              _buildField(_authorKeyController, 'Author Public Key (hex)'),
              const SizedBox(height: 12),
              _buildField(_wrappedDekController, 'Wrapped DEK (hex)'),
              const SizedBox(height: 12),
              _buildField(_nonceController, 'Nonce (hex)'),
              const SizedBox(height: 12),
              _buildField(_ciphertextController, 'Ciphertext (hex)', maxLines: 4),
              const SizedBox(height: 20),
              if (state.decrypting)
                const Center(child: CircularProgressIndicator())
              else
                FilledButton.icon(
                  onPressed: _decrypt,
                  icon: const Icon(Icons.lock_open),
                  label: const Text('Decrypt'),
                ),
              if (state.error != null) ...[
                const SizedBox(height: 16),
                Card(
                  color: Colors.red.withValues(alpha: 0.2),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Text(state.error!, style: const TextStyle(color: Colors.redAccent)),
                  ),
                ),
              ],
              if (state.plaintext != null) ...[
                const SizedBox(height: 16),
                Text('Decrypted Plaintext', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Theme.of(context).cardColor,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: SelectableText(
                    state.plaintext!,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildField(TextEditingController controller, String label, {int maxLines = 1}) {
    return TextField(
      controller: controller,
      maxLines: maxLines,
      decoration: InputDecoration(labelText: label),
    );
  }

  void _decrypt() {
    ref.read(decryptProvider.notifier).decrypt(
          authorPublicKeyHex: _authorKeyController.text,
          ciphertextHex: _ciphertextController.text,
          nonceHex: _nonceController.text,
          wrappedDekHex: _wrappedDekController.text,
        );
  }
}
