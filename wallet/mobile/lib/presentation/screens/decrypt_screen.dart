import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/wallet_models.dart';
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

  ProtocolKeyMaterial? _keyMaterial;
  bool _loadingKeys = false;

  @override
  void dispose() {
    _authorKeyController.dispose();
    _ciphertextController.dispose();
    _nonceController.dispose();
    _wrappedDekController.dispose();
    super.dispose();
  }

  Future<void> _loadKeyMaterial() async {
    final walletState = ref.read(walletProvider);
    if (walletState.activeWallet == null) return;
    setState(() => _loadingKeys = true);
    final material = await ref.read(walletProvider.notifier).getKeyMaterial();
    if (mounted) setState(() { _keyMaterial = material; _loadingKeys = false; });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadKeyMaterial());
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
              _buildCredentialsCard(),
              const SizedBox(height: 16),
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

  Widget _buildCredentialsCard() {
    if (_loadingKeys) {
      return const Card(child: ListTile(title: Text('Loading credentials...')));
    }
    final km = _keyMaterial;
    if (km == null) {
      return Card(
        child: ListTile(
          leading: const Icon(Icons.error_outline, color: Colors.orange),
          title: const Text('Unable to derive credentials'),
        ),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.vpn_key, size: 18, color: Colors.blue),
                const SizedBox(width: 8),
                Text('Reader Key (X25519)', style: Theme.of(context).textTheme.titleSmall),
              ],
            ),
            const SizedBox(height: 4),
            _copyableText(context, km.reader.did),
            const SizedBox(height: 4),
            _copyableText(context, 'Public: ${km.reader.publicKeyHex}', muted: true),
            const SizedBox(height: 12),
            Row(
              children: [
                const Icon(Icons.draw, size: 18, color: Colors.teal),
                const SizedBox(width: 8),
                Text('Signer Key (Ed25519)', style: Theme.of(context).textTheme.titleSmall),
              ],
            ),
            const SizedBox(height: 4),
            _copyableText(context, km.signer.did),
            const SizedBox(height: 4),
            _copyableText(context, 'Public: ${km.signer.verifyingKeyHex}', muted: true),
          ],
        ),
      ),
    );
  }

  Widget _copyableText(BuildContext context, String text, {bool muted = false}) {
    return Row(
      children: [
        Expanded(
          child: SelectableText(
            text,
            style: TextStyle(
              fontFamily: 'monospace',
              fontSize: 12,
              color: muted ? Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5) : null,
            ),
          ),
        ),
        IconButton(
          icon: const Icon(Icons.copy, size: 16),
          visualDensity: VisualDensity.compact,
          onPressed: () {
            // copy to clipboard via SelectionRegister is handled by SelectableText
          },
        ),
      ],
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
