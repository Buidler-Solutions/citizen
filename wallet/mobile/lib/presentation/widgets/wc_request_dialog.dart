import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models/wallet_models.dart';
import '../../data/services/walletconnect_service.dart';
import '../../providers/wallet_provider.dart';
import '../../providers/walletconnect_provider.dart';

class WCRequestDialog extends ConsumerWidget {
  const WCRequestDialog({super.key});

  static void show(BuildContext context) {
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const WCRequestDialog(),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final wcState = ref.watch(walletConnectProvider);
    final walletState = ref.watch(walletProvider);

    if (wcState.pendingProposal != null) {
      return _SessionProposalDialog(
        proposal: wcState.pendingProposal!,
        wallet: walletState.activeWallet,
        onApprove: () => ref.read(walletConnectProvider.notifier).approveProposal(walletState.activeWallet!),
        onReject: () => ref.read(walletConnectProvider.notifier).rejectProposal(),
      );
    }

    if (wcState.pendingRequest != null) {
      return _RequestDialog(
        request: wcState.pendingRequest!,
        wallet: walletState.activeWallet,
        onApprove: () => ref.read(walletConnectProvider.notifier).approveRequest(walletState.activeWallet!),
        onReject: () => ref.read(walletConnectProvider.notifier).rejectRequest(),
      );
    }

    return const SizedBox.shrink();
  }
}

class _SessionProposalDialog extends StatelessWidget {
  final SessionProposalData proposal;
  final StoredWallet? wallet;
  final VoidCallback onApprove;
  final VoidCallback onReject;

  const _SessionProposalDialog({
    required this.proposal,
    required this.wallet,
    required this.onApprove,
    required this.onReject,
  });

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Connection Request'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (proposal.dappIcon.isNotEmpty)
                CircleAvatar(backgroundImage: NetworkImage(proposal.dappIcon), radius: 24)
              else
                CircleAvatar(child: const Icon(Icons.apps), radius: 24),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(proposal.dappName, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                    Text(proposal.dappUrl, style: const TextStyle(fontSize: 13, color: Colors.grey)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          const Text('This dApp wants to connect to your wallet and may request:'),
          const SizedBox(height: 8),
          _capabilityRow(Icons.draw, 'Sign transactions and messages'),
          _capabilityRow(Icons.lock_open, 'Decrypt owned data'),
          _capabilityRow(Icons.key, 'Read your signer and reader keys'),
          const SizedBox(height: 16),
          if (wallet != null)
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Theme.of(context).cardColor,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  const Icon(Icons.account_balance_wallet, size: 16, color: Colors.blue),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      wallet!.name,
                      style: const TextStyle(fontSize: 13),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            )
          else
            const Text('No active wallet. Set one in the Vault tab first.',
                style: TextStyle(color: Colors.redAccent)),
        ],
      ),
      actions: [
        TextButton(onPressed: onReject, child: const Text('Reject')),
        FilledButton(onPressed: wallet != null ? onApprove : null, child: const Text('Approve')),
      ],
    );
  }

  Widget _capabilityRow(IconData icon, String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Icon(icon, size: 16, color: Colors.blue),
          const SizedBox(width: 8),
          Text(text, style: const TextStyle(fontSize: 13)),
        ],
      ),
    );
  }
}

class _RequestDialog extends StatelessWidget {
  final WCRequest request;
  final StoredWallet? wallet;
  final VoidCallback onApprove;
  final VoidCallback onReject;

  const _RequestDialog({
    required this.request,
    required this.wallet,
    required this.onApprove,
    required this.onReject,
  });

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Row(
        children: [
          Icon(_iconForType(request.type), color: _colorForType(request.type)),
          const SizedBox(width: 8),
          Text(_titleForType(request.type)),
        ],
      ),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (request.dappName.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text('From: ${request.dappName}', style: const TextStyle(fontWeight: FontWeight.w600)),
                ),
              _buildRequestDetails(context),
              const SizedBox(height: 16),
              if (wallet == null)
                const Text('No active wallet. Set one in the Vault tab first.',
                    style: TextStyle(color: Colors.redAccent)),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: onReject, child: const Text('Reject')),
        FilledButton(onPressed: wallet != null ? onApprove : null, child: const Text('Approve')),
      ],
    );
  }

  Widget _buildRequestDetails(BuildContext context) {
    switch (request.type) {
      case WCRequestType.signAuth:
        final message = request.params is List && request.params.isNotEmpty
            ? request.params.first.toString()
            : request.params.toString();
        return _detailCard(context, 'Message to sign', message);

      case WCRequestType.signTx:
        final payload = request.params is List && request.params.isNotEmpty
            ? request.params.first
            : request.params;
        final formatted = payload is String
            ? payload
            : const JsonEncoder.withIndent('  ').convert(payload);
        return _detailCard(context, 'Transaction payload', formatted);

      case WCRequestType.decrypt:
        final params = (request.params is List && request.params.isNotEmpty
            ? request.params.first
            : request.params) as Map;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _detailCard(context, 'Author Public Key', params['authorPublicKeyHex']?.toString() ?? 'N/A'),
            const SizedBox(height: 8),
            _detailCard(context, 'Ciphertext (truncated)', _truncate(params['ciphertextHex']?.toString() ?? 'N/A', 100)),
          ],
        );

      case WCRequestType.getKeyMaterial:
      case WCRequestType.getEncryptionPubKey:
        return const Text('dApp is requesting your public key material.');

      case WCRequestType.unknown:
        return Text('Unknown method: ${request.method}');
    }
  }

  Widget _detailCard(BuildContext context, String label, String value) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Theme.of(context).cardColor,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: Colors.grey, fontSize: 12)),
          const SizedBox(height: 4),
          SelectableText(value, style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
        ],
      ),
    );
  }

  String _truncate(String input, int max) {
    if (input.length <= max) return input;
    return '${input.substring(0, max)}... (${input.length} chars)';
  }

  String _titleForType(WCRequestType type) {
    switch (type) {
      case WCRequestType.signAuth:
        return 'Sign In Request';
      case WCRequestType.signTx:
        return 'Sign Transaction';
      case WCRequestType.decrypt:
        return 'Decrypt Request';
      case WCRequestType.getKeyMaterial:
        return 'Share Key Material';
      case WCRequestType.getEncryptionPubKey:
        return 'Share Public Key';
      default:
        return 'Request';
    }
  }

  IconData _iconForType(WCRequestType type) {
    switch (type) {
      case WCRequestType.signAuth:
        return Icons.login;
      case WCRequestType.signTx:
        return Icons.draw;
      case WCRequestType.decrypt:
        return Icons.lock_open;
      default:
        return Icons.help_outline;
    }
  }

  Color _colorForType(WCRequestType type) {
    switch (type) {
      case WCRequestType.signAuth:
        return Colors.blue;
      case WCRequestType.signTx:
        return Colors.teal;
      case WCRequestType.decrypt:
        return Colors.orange;
      default:
        return Colors.grey;
    }
  }
}
