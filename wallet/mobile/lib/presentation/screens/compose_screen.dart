import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../providers/direct_submit_provider.dart';
import '../../providers/wallet_provider.dart';

class ComposeScreen extends ConsumerStatefulWidget {
  const ComposeScreen({super.key});

  @override
  ConsumerState<ComposeScreen> createState() => _ComposeScreenState();
}

class _ComposeScreenState extends ConsumerState<ComposeScreen> {
  final _namespaceController = TextEditingController();
  final _actionController = TextEditingController();
  final _objectIdController = TextEditingController();
  final _payloadController = TextEditingController();
  final _messageController = TextEditingController();

  String _mode = 'signPayload';

  @override
  void dispose() {
    _namespaceController.dispose();
    _actionController.dispose();
    _objectIdController.dispose();
    _payloadController.dispose();
    _messageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final walletState = ref.watch(walletProvider);
    final submitState = ref.watch(directSubmitProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Compose')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'signPayload', label: Text('Sign & Submit')),
                ButtonSegment(value: 'signMessage', label: Text('Sign Message')),
              ],
              selected: {_mode},
              onSelectionChanged: (s) => setState(() => _mode = s.first),
            ),
            const SizedBox(height: 20),
            if (_mode == 'signPayload') ...[
              _buildField(_namespaceController, 'Namespace (e.g. builder.credits)'),
              const SizedBox(height: 12),
              _buildField(_actionController, 'Action (e.g. SPONSOR_USAGE)'),
              const SizedBox(height: 12),
              _buildField(_objectIdController, 'Object ID / Builder DID'),
              const SizedBox(height: 12),
              TextField(
                controller: _payloadController,
                maxLines: 6,
                decoration: const InputDecoration(
                  labelText: 'Payload (JSON)',
                  hintText: '{"key": "value"}',
                ),
              ),
              const SizedBox(height: 20),
              if (submitState.submitting)
                const Center(child: CircularProgressIndicator())
              else
                FilledButton.icon(
                  onPressed: walletState.activeWallet == null ? null : _submitPayload,
                  icon: const Icon(Icons.send),
                  label: const Text('Sign & Submit'),
                ),
            ] else ...[
              TextField(
                controller: _messageController,
                maxLines: 4,
                decoration: const InputDecoration(labelText: 'Message to sign'),
              ),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: walletState.activeWallet == null ? null : _signMessage,
                icon: const Icon(Icons.draw),
                label: const Text('Sign Message'),
              ),
            ],
            if (submitState.lastError != null) ...[
              const SizedBox(height: 16),
              Card(
                color: Colors.red.withValues(alpha: 0.2),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(submitState.lastError!, style: const TextStyle(color: Colors.redAccent)),
                ),
              ),
            ],
            if (submitState.lastResponse != null) ...[
              const SizedBox(height: 16),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Submission Result', style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 8),
                      _resultRow('Status', '${submitState.lastResponse!.status}'),
                      _resultRow('Trace ID', submitState.lastResponse!.traceId),
                      if (submitState.lastResponse!.receiptId != null)
                        _resultRow('Receipt ID', submitState.lastResponse!.receiptId!),
                      if (submitState.lastResponse!.receiptHash != null)
                        _resultRow('Receipt Hash', submitState.lastResponse!.receiptHash!),
                      if (submitState.lastResponse!.blockHeight != null)
                        _resultRow('Block Height', '${submitState.lastResponse!.blockHeight}'),
                      _resultRow('Latency', '${submitState.lastResponse!.latencyMs}ms'),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildField(TextEditingController controller, String label) {
    return TextField(controller: controller, decoration: InputDecoration(labelText: label));
  }

  Widget _resultRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 100,
            child: Text(label, style: const TextStyle(color: Colors.grey, fontSize: 13)),
          ),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }

  void _submitPayload() {
    final namespace = _namespaceController.text.trim();
    final action = _actionController.text.trim();
    final objectId = _objectIdController.text.trim();

    Map<String, dynamic> innerPayload;
    try {
      innerPayload = _payloadController.text.trim().isEmpty
          ? {}
          : jsonDecode(_payloadController.text) as Map<String, dynamic>;
    } catch (_) {
      innerPayload = {};
    }

    final payload = {
      'namespace': namespace,
      'action': action,
      'object_id': objectId,
      'payload': innerPayload,
    };

    _payloadController.text = const JsonEncoder.withIndent('  ').convert(payload);

    ref.read(directSubmitProvider.notifier).submitSignedPayload(
          payload: payload,
          consentToShareSigningPayload: true,
        );
  }

  void _signMessage() async {
    final wallet = ref.read(walletProvider).activeWallet;
    if (wallet == null) return;
    final signature = await ref.read(directSubmitProvider.notifier).signMessage(
          wallet,
          _messageController.text,
        );
    if (signature != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Signature: $signature')),
      );
    }
  }
}
