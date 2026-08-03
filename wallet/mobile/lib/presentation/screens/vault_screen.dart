import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/wallet_models.dart';
import '../../providers/wallet_provider.dart';

class VaultScreen extends ConsumerStatefulWidget {
  const VaultScreen({super.key});

  @override
  ConsumerState<VaultScreen> createState() => _VaultScreenState();
}

class _VaultScreenState extends ConsumerState<VaultScreen> {
  final _importController = TextEditingController();
  bool _showImport = false;
  bool _showMnemonicFor = false;

  @override
  void dispose() {
    _importController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final walletState = ref.watch(walletProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Vault')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: FilledButton.tonalIcon(
                    onPressed: () => ref.read(walletProvider.notifier).generateWallet(wordCount: 12),
                    icon: const Icon(Icons.add_circle_outline),
                    label: const Text('New Wallet'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.tonalIcon(
                    onPressed: () => setState(() => _showImport = !_showImport),
                    icon: const Icon(Icons.download),
                    label: const Text('Import'),
                  ),
                ),
              ],
            ),
            if (_showImport) ...[
              const SizedBox(height: 12),
              TextField(
                controller: _importController,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Mnemonic phrase',
                  hintText: 'Enter 12 or 24 words',
                ),
              ),
              const SizedBox(height: 8),
              FilledButton(
                onPressed: () {
                  ref.read(walletProvider.notifier).importWallet(_importController.text);
                  _importController.clear();
                  setState(() => _showImport = false);
                },
                child: const Text('Import Wallet'),
              ),
            ],
            const SizedBox(height: 24),
            if (walletState.vault.isEmpty)
              Card(
                child: ListTile(
                  leading: const Icon(Icons.account_balance_wallet_outlined, color: Colors.grey),
                  title: const Text('No wallets'),
                  subtitle: const Text('Create or import a wallet to get started.'),
                ),
              )
            else
              ...walletState.vault.map((wallet) {
                final isActive = wallet.id == walletState.activeWallet?.id;
                return Card(
                  color: isActive ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.1) : null,
                  child: ExpansionTile(
                    leading: Icon(
                      isActive ? Icons.star : Icons.account_balance_wallet_outlined,
                      color: isActive ? Theme.of(context).colorScheme.primary : Colors.grey,
                    ),
                    title: Text(wallet.name, style: const TextStyle(fontSize: 14)),
                    subtitle: Text(
                      'did:key:ed25519:${wallet.id.substring(0, 12)}...',
                      style: const TextStyle(fontSize: 12),
                    ),
                    children: [
                      FutureBuilder<ProtocolKeyMaterial?>(
                        future: ref.read(walletProvider.notifier).getKeyMaterialForWallet(wallet),
                        builder: (context, snapshot) {
                          if (snapshot.connectionState == ConnectionState.waiting) {
                            return const Padding(
                              padding: EdgeInsets.all(16),
                              child: Center(child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))),
                            );
                          }
                          final km = snapshot.data;
                          return Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                if (km != null) ...[
                                  _detailRow('Signer DID', km.signer.did),
                                  _detailRow('Signer Key', km.signer.verifyingKeyHex),
                                  _detailRow('Reader DID', km.reader.did),
                                  _detailRow('Reader Key', km.reader.publicKeyHex),
                                  const SizedBox(height: 8),
                                ],
                                _detailRow('ID', wallet.id),
                                _detailRow('Created', wallet.createdAt.substring(0, 19)),
                                _detailRow('Has Mnemonic', wallet.hasMnemonic ? 'Yes (${wallet.mnemonicWordCount} words)' : 'No'),
                                if (wallet.hasMnemonic) ...[
                                  const SizedBox(height: 8),
                                  if (_showMnemonicFor)
                                    Container(
                                      padding: const EdgeInsets.all(8),
                                      decoration: BoxDecoration(
                                        color: Colors.orange.withValues(alpha: 0.1),
                                        borderRadius: BorderRadius.circular(8),
                                      ),
                                      child: SelectableText(
                                        wallet.mnemonicPhrase!,
                                        style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                                      ),
                                    )
                                  else
                                    FilledButton.tonal(
                                      onPressed: () => setState(() => _showMnemonicFor = !_showMnemonicFor),
                                      child: const Text('Reveal Mnemonic'),
                                    ),
                                ],
                                const SizedBox(height: 8),
                                if (!isActive)
                                  FilledButton.tonal(
                                    onPressed: () => ref.read(walletProvider.notifier).setActiveWallet(wallet.id),
                                    child: const Text('Set Active'),
                                  ),
                                const SizedBox(height: 8),
                                TextButton(
                                  onPressed: () => _confirmDelete(wallet.id),
                                  child: const Text('Delete', style: TextStyle(color: Colors.red)),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
                    ],
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 110,
            child: Text(label, style: const TextStyle(color: Colors.grey, fontSize: 13)),
          ),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }

  void _confirmDelete(String walletId) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Wallet'),
        content: const Text('Are you sure? This cannot be undone. Make sure you have a backup.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(
            onPressed: () {
              ref.read(walletProvider.notifier).deleteWallet(walletId);
              Navigator.pop(ctx);
            },
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }
}
