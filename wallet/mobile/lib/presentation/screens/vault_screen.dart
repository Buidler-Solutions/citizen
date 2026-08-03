import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
                    onPressed: _showCreateDialog,
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
              ...walletState.vault.map((wallet) => _VaultWalletCard(
                    wallet: wallet,
                    isActive: wallet.id == walletState.activeWallet?.id,
                    ref: ref,
                  )),
          ],
        ),
      ),
    );
  }

  void _showCreateDialog() {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Create New Wallet', style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 8),
              Text(
                'Choose your recovery phrase length. A 24-word phrase provides stronger security.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6),
                    ),
              ),
              const SizedBox(height: 20),
              _WordCountOption(
                icon: Icons.shield_outlined,
                title: '12 Words',
                subtitle: 'Standard security · Faster to write down',
                onTap: () {
                  Navigator.pop(ctx);
                  _createWallet(12);
                },
              ),
              const SizedBox(height: 8),
              _WordCountOption(
                icon: Icons.security,
                title: '24 Words',
                subtitle: 'Enhanced security · Recommended for large holdings',
                onTap: () {
                  Navigator.pop(ctx);
                  _createWallet(24);
                },
              ),
              const SizedBox(height: 12),
              TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Cancel'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _createWallet(int wordCount) async {
    try {
      final wallet = await ref.read(walletProvider.notifier).generateWallet(wordCount: wordCount);
      if (mounted) _showBackupScreen(wallet);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to create wallet: $e')),
        );
      }
    }
  }

  void _showBackupScreen(StoredWallet wallet) {
    Navigator.of(context).push(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (ctx) => _BackupScreen(wallet: wallet),
      ),
    );
  }
}

class _WordCountOption extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _WordCountOption({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        leading: Icon(icon, color: Theme.of(context).colorScheme.primary),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text(subtitle, style: const TextStyle(fontSize: 13)),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}

class _BackupScreen extends StatefulWidget {
  final StoredWallet wallet;

  const _BackupScreen({required this.wallet});

  @override
  State<_BackupScreen> createState() => _BackupScreenState();
}

class _BackupScreenState extends State<_BackupScreen> {
  bool _hasAcknowledged = false;

  @override
  Widget build(BuildContext context) {
    final words = widget.wallet.mnemonicPhrase?.split(RegExp(r'\s+')) ?? [];

    return Scaffold(
      appBar: AppBar(
        title: const Text('Back Up Your Wallet'),
        automaticallyImplyLeading: false,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.orange.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Colors.orange.withValues(alpha: 0.3)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber_rounded, color: Colors.orange, size: 28),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Write down your recovery phrase and secret key. '
                      'Anyone with these can access your wallet. '
                      'We cannot recover them for you.',
                      style: TextStyle(
                        fontSize: 13,
                        color: Colors.orange.shade300,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            Text('Recovery Phrase (${words.length} words)', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              'Use these words to restore your wallet on any device.',
              style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5)),
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Theme.of(context).cardColor,
                borderRadius: BorderRadius.circular(12),
              ),
              child: GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: words.length == 12 ? 3 : 4,
                  childAspectRatio: 2.5,
                  crossAxisSpacing: 8,
                  mainAxisSpacing: 8,
                ),
                itemCount: words.length,
                itemBuilder: (ctx, i) => Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.surface,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    children: [
                      Text('${i + 1}', style: TextStyle(fontSize: 10, color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.4))),
                      const SizedBox(width: 6),
                      Expanded(
                        child: SelectableText(
                          words[i],
                          style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: () => Clipboard.setData(ClipboardData(text: widget.wallet.mnemonicPhrase ?? '')),
                icon: const Icon(Icons.copy, size: 16),
                label: const Text('Copy phrase'),
              ),
            ),

            const SizedBox(height: 24),
            Text('Secret Key (Ed25519)', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              'Your derived private key. Store this securely — it controls signing and decryption.',
              style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5)),
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Theme.of(context).cardColor,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SelectableText(
                    widget.wallet.privateKeyHex,
                    style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
                  ),
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton.icon(
                      onPressed: () => Clipboard.setData(ClipboardData(text: widget.wallet.privateKeyHex)),
                      icon: const Icon(Icons.copy, size: 16),
                      label: const Text('Copy key'),
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 24),
            CheckboxListTile(
              value: _hasAcknowledged,
              onChanged: (v) => setState(() => _hasAcknowledged = v ?? false),
              title: const Text('I have safely stored my recovery phrase and secret key'),
              contentPadding: EdgeInsets.zero,
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _hasAcknowledged
                  ? () => Navigator.of(context).pop()
                  : null,
              child: const Text('Done'),
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}

class _VaultWalletCard extends ConsumerStatefulWidget {
  final StoredWallet wallet;
  final bool isActive;
  final WidgetRef ref;

  const _VaultWalletCard({
    required this.wallet,
    required this.isActive,
    required this.ref,
  });

  @override
  ConsumerState<_VaultWalletCard> createState() => _VaultWalletCardState();
}

class _VaultWalletCardState extends ConsumerState<_VaultWalletCard> {
  bool _showMnemonic = false;
  bool _showSecretKey = false;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: widget.isActive ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.1) : null,
      child: ExpansionTile(
        leading: Icon(
          widget.isActive ? Icons.star : Icons.account_balance_wallet_outlined,
          color: widget.isActive ? Theme.of(context).colorScheme.primary : Colors.grey,
        ),
        title: Text(widget.wallet.name, style: const TextStyle(fontSize: 14)),
        subtitle: Text(
          'did:key:ed25519:${widget.wallet.id.substring(0, 12)}...',
          style: const TextStyle(fontSize: 12),
        ),
        children: [
          FutureBuilder<ProtocolKeyMaterial?>(
            future: widget.ref.read(walletProvider.notifier).getKeyMaterialForWallet(widget.wallet),
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
                      _detailRow('Signer PubKey', km.signer.verifyingKeyHex),
                      _detailRow('Reader DID', km.reader.did),
                      _detailRow('Reader PubKey', km.reader.publicKeyHex),
                      const Divider(height: 24),
                    ],
                    _detailRow('Wallet ID', widget.wallet.id),
                    _detailRow('Created', widget.wallet.createdAt.substring(0, 19)),
                    _detailRow('Mnemonic', widget.wallet.hasMnemonic
                        ? 'Yes (${widget.wallet.mnemonicWordCount} words)'
                        : 'No'),

                    // Secret Key reveal
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        const Icon(Icons.key, size: 16, color: Colors.orange),
                        const SizedBox(width: 8),
                        Text('Secret Key', style: Theme.of(context).textTheme.titleSmall),
                      ],
                    ),
                    const SizedBox(height: 8),
                    if (_showSecretKey)
                      _SecureBox(
                        text: widget.wallet.privateKeyHex,
                        color: Colors.orange,
                        onCopy: () => Clipboard.setData(ClipboardData(text: widget.wallet.privateKeyHex)),
                      )
                    else
                      FilledButton.tonal(
                        onPressed: () => setState(() => _showSecretKey = true),
                        style: FilledButton.styleFrom(
                          foregroundColor: Colors.orange,
                        ),
                        child: const Text('Reveal Secret Key'),
                      ),

                    // Mnemonic reveal
                    if (widget.wallet.hasMnemonic) ...[
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          const Icon(Icons.refresh, size: 16, color: Colors.blue),
                          const SizedBox(width: 8),
                          Text('Recovery Phrase', style: Theme.of(context).textTheme.titleSmall),
                        ],
                      ),
                      const SizedBox(height: 8),
                      if (_showMnemonic)
                        _SecureBox(
                          text: widget.wallet.mnemonicPhrase!,
                          color: Colors.blue,
                          onCopy: () => Clipboard.setData(ClipboardData(text: widget.wallet.mnemonicPhrase!)),
                        )
                      else
                        FilledButton.tonal(
                          onPressed: () => setState(() => _showMnemonic = true),
                          child: const Text('Reveal Recovery Phrase'),
                        ),
                    ],

                    const SizedBox(height: 16),
                    if (!widget.isActive)
                      FilledButton.tonal(
                        onPressed: () => widget.ref.read(walletProvider.notifier).setActiveWallet(widget.wallet.id),
                        child: const Text('Set Active'),
                      ),
                    const SizedBox(height: 8),
                    TextButton(
                      onPressed: () => _confirmDelete(widget.wallet.id),
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
          Expanded(child: SelectableText(value, style: const TextStyle(fontSize: 12))),
        ],
      ),
    );
  }

  void _confirmDelete(String walletId) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Wallet'),
        content: const Text('Are you sure? This cannot be undone. Make sure you have backed up your recovery phrase and secret key.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(
            onPressed: () {
              widget.ref.read(walletProvider.notifier).deleteWallet(walletId);
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

class _SecureBox extends StatelessWidget {
  final String text;
  final Color color;
  final VoidCallback onCopy;

  const _SecureBox({required this.text, required this.color, required this.onCopy});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText(
            text,
            style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: color.withValues(alpha: 0.9)),
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: onCopy,
              icon: const Icon(Icons.copy, size: 14),
              label: const Text('Copy', style: TextStyle(fontSize: 12)),
            ),
          ),
        ],
      ),
    );
  }
}
