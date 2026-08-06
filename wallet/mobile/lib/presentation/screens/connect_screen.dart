import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../providers/walletconnect_provider.dart';

class ConnectScreen extends ConsumerStatefulWidget {
  const ConnectScreen({super.key});

  @override
  ConsumerState<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends ConsumerState<ConnectScreen> {
  final _uriController = TextEditingController();
  bool _showScanner = false;
  bool _processing = false;

  @override
  void dispose() {
    _uriController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Connect to dApp')),
      body: _showScanner ? _buildScanner() : _buildManualInput(),
    );
  }

  Widget _buildManualInput() {
    final wcState = ref.watch(walletConnectProvider);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(
            Icons.link,
            size: 64,
            color: Theme.of(context).colorScheme.primary,
          ),
          const SizedBox(height: 16),
          Text(
            'Connect to a dApp',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          Text(
            'Paste a WalletConnect URI or scan a QR code from a dApp that supports Citizen Protocol.',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5),
              fontSize: 14,
            ),
          ),
          const SizedBox(height: 32),
          if (wcState.error != null)
            Card(
              color: Colors.red.withValues(alpha: 0.15),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(wcState.error!, style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
              ),
            ),
          if (wcState.error != null) const SizedBox(height: 16),
          TextField(
            controller: _uriController,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'WalletConnect URI',
              hintText: 'wc:...',
              prefixIcon: Icon(Icons.paste),
            ),
          ),
          const SizedBox(height: 16),
          if (_processing)
            const Center(child: CircularProgressIndicator())
          else ...[
            FilledButton.icon(
              onPressed: _connectWithUri,
              icon: const Icon(Icons.link),
              label: const Text('Connect'),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () => setState(() => _showScanner = true),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan QR Code'),
            ),
          ],
          const SizedBox(height: 24),
          if (wcState.sessions.isNotEmpty) ...[
            Text('Active Sessions', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            ...wcState.sessions.map((session) => Card(
                  child: ListTile(
                    leading: session.dappIcon.isNotEmpty
                        ? CircleAvatar(backgroundImage: NetworkImage(session.dappIcon))
                        : const CircleAvatar(child: Icon(Icons.apps)),
                    title: Text(session.dappName),
                    subtitle: Text(session.dappUrl, style: const TextStyle(fontSize: 12)),
                    trailing: IconButton(
                      icon: const Icon(Icons.close, color: Colors.red),
                      onPressed: () => ref.read(walletConnectProvider.notifier).disconnectSession(session.topic),
                    ),
                  ),
                )),
          ],
        ],
      ),
    );
  }

  Widget _buildScanner() {
    return Stack(
      children: [
        MobileScanner(
          onDetect: (capture) {
            final barcodes = capture.barcodes;
            for (final barcode in barcodes) {
              final value = barcode.rawValue;
              if (value != null && value.startsWith('wc:')) {
                _handleScanResult(value);
                return;
              }
            }
          },
        ),
        Positioned(
          top: 16,
          left: 16,
          child: SafeArea(
            child: FloatingActionButton.small(
              heroTag: 'close_scanner',
              onPressed: () => setState(() => _showScanner = false),
              child: const Icon(Icons.close),
            ),
          ),
        ),
        Positioned(
          bottom: 0,
          left: 0,
          right: 0,
          child: Container(
            padding: const EdgeInsets.all(24),
            color: Colors.black54,
            child: const Text(
              'Point your camera at the QR code shown by the dApp',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.white70, fontSize: 14),
            ),
          ),
        ),
      ],
    );
  }

  void _connectWithUri() async {
    final uri = _uriController.text.trim();
    if (uri.isEmpty) return;
    setState(() => _processing = true);
    await ref.read(walletConnectProvider.notifier).pairWithUri(uri);
    if (mounted) setState(() => _processing = false);
    _uriController.clear();
  }

  void _handleScanResult(String value) {
    setState(() => _showScanner = false);
    ref.read(walletConnectProvider.notifier).pairWithUri(value);
  }
}
