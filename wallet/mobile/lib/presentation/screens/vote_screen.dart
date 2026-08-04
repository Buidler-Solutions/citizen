import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../providers/vote_provider.dart';
import '../../providers/wallet_provider.dart';

class VoteScreen extends ConsumerStatefulWidget {
  const VoteScreen({super.key});

  @override
  ConsumerState<VoteScreen> createState() => _VoteScreenState();
}

class _VoteScreenState extends ConsumerState<VoteScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(voteProvider.notifier).fetchProposals();
    });
  }

  @override
  Widget build(BuildContext context) {
    final voteState = ref.watch(voteProvider);
    final walletState = ref.watch(walletProvider);
    final hasWallet = walletState.activeWallet != null;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Civic Voting'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: voteState.loading
                ? null
                : () => ref.read(voteProvider.notifier).fetchProposals(),
          ),
        ],
      ),
      body: Column(
        children: [
          if (voteState.error != null)
            _banner(
              voteState.error!,
              Colors.red.shade50,
              Colors.red.shade800,
            ),
          if (voteState.lastResult != null)
            _banner(
              voteState.lastResult!,
              Colors.green.shade50,
              Colors.green.shade800,
            ),
          if (!hasWallet)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(16),
              color: Colors.orange.shade50,
              child: Row(
                children: [
                  Icon(Icons.warning_amber, color: Colors.orange.shade800),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Create or import a wallet in the Vault tab to cast ballots.',
                      style: TextStyle(color: Colors.orange.shade900, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
          Expanded(
            child: voteState.loading && voteState.proposals.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : voteState.proposals.isEmpty
                    ? _emptyState()
                    : _body(voteState, hasWallet),
          ),
        ],
      ),
    );
  }

  Widget _body(VoteState voteState, bool hasWallet) {
    final selected = voteState.selectedProposal;
    if (selected == null) {
      return _proposalList(voteState);
    }
    return _proposalDetail(voteState, hasWallet);
  }

  Widget _proposalList(VoteState voteState) {
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: voteState.proposals.length,
      itemBuilder: (context, index) {
        final p = voteState.proposals[index];
        return Card(
          margin: const EdgeInsets.only(bottom: 12),
          child: ListTile(
            contentPadding: const EdgeInsets.all(16),
            title: Text(
              p.title ?? p.proposalId,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            subtitle: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (p.description != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    p.description!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13),
                  ),
                ],
                const SizedBox(height: 8),
                Row(
                  children: [
                    _statusChip(p.status),
                    const SizedBox(width: 8),
                    Text(
                      p.proposalId,
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.grey.shade600,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ],
                ),
              ],
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => ref.read(voteProvider.notifier).selectProposal(p),
          ),
        );
      },
    );
  }

  Widget _proposalDetail(VoteState voteState, bool hasWallet) {
    final p = voteState.selectedProposal!;
    final tally = voteState.tally;
    final maxCount = tally != null && tally.tally.values.isNotEmpty
        ? tally.tally.values.reduce((a, b) => a > b ? a : b)
        : 1;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          p.title ?? p.proposalId,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 8),
        Text(
          p.description ?? 'No description provided.',
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Colors.grey.shade700,
              ),
        ),
        const SizedBox(height: 16),
        _metaRow('Proposal ID', p.proposalId),
        _metaRow('Opened by', '${p.openedBy.substring(0, p.openedBy.length > 24 ? 24 : p.openedBy.length)}...'),
        _metaRow('Status', p.status),
        const SizedBox(height: 24),
        if (tally != null) ...[
          Text(
            'Live Tally',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
          ),
          const SizedBox(height: 4),
          Text(
            '${tally.totalBallots} ballot${tally.totalBallots != 1 ? 's' : ''} cast',
            style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
          ),
          const SizedBox(height: 12),
          ...tally.tally.entries.toList()
              .asMap()
              .entries
              .map((entry) => _tallyBar(entry.value.key, entry.value.value, maxCount)),
          const SizedBox(height: 24),
        ],
        Text(
          'Cast Your Ballot',
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.bold,
              ),
        ),
        const SizedBox(height: 12),
        if (!hasWallet)
          Text(
            'Connect a wallet to vote.',
            style: TextStyle(color: Colors.grey.shade600),
          )
        else
          Row(
            children: [
              Expanded(child: _voteButton('Yes', 'yes', Colors.green, voteState)),
              const SizedBox(width: 8),
              Expanded(child: _voteButton('No', 'no', Colors.red, voteState)),
              const SizedBox(width: 8),
              Expanded(child: _voteButton('Abstain', 'abstain', Colors.grey, voteState)),
            ],
          ),
        const SizedBox(height: 24),
        TextButton.icon(
          onPressed: () => ref.read(voteProvider.notifier).fetchProposals(),
          icon: const Icon(Icons.arrow_back, size: 18),
          label: const Text('Back to proposals'),
        ),
      ],
    );
  }

  Widget _voteButton(String label, String choice, MaterialColor color, VoteState voteState) {
    return FilledButton.tonal(
      onPressed: voteState.submitting ? null : () => _castBallot(choice),
      style: FilledButton.styleFrom(
        backgroundColor: color.withValues(alpha: 0.12),
        foregroundColor: color.shade700,
        padding: const EdgeInsets.symmetric(vertical: 14),
      ),
      child: voteState.submitting
          ? const SizedBox(
              height: 18,
              width: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Text(label, style: const TextStyle(fontWeight: FontWeight.bold)),
    );
  }

  void _castBallot(String choice) {
    ref.read(voteProvider.notifier).castBallot(choice);
  }

  Widget _tallyBar(String label, int count, int maxCount) {
    final percentage = maxCount > 0 ? (count / maxCount) : 0.0;
    final displayColor = label == 'yes'
        ? Colors.green
        : label == 'no'
            ? Colors.red
            : Colors.grey;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          SizedBox(
            width: 72,
            child: Text(
              label[0].toUpperCase() + label.substring(1),
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Stack(
              children: [
                Container(
                  height: 28,
                  decoration: BoxDecoration(
                    color: Colors.grey.shade200,
                    borderRadius: BorderRadius.circular(6),
                  ),
                ),
                FractionallySizedBox(
                  widthFactor: percentage.clamp(0.0, 1.0),
                  child: Container(
                    height: 28,
                    decoration: BoxDecoration(
                      color: displayColor,
                      borderRadius: BorderRadius.circular(6),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 32,
            child: Text(
              '$count',
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
          ),
        ],
      ),
    );
  }

  Widget _statusChip(String status) {
    final isOpen = status == 'open';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: isOpen ? Colors.green.shade100 : Colors.red.shade100,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        status.toUpperCase(),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: isOpen ? Colors.green.shade800 : Colors.red.shade800,
        ),
      ),
    );
  }

  Widget _metaRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 100,
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                color: Colors.grey.shade600,
              ),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _banner(String message, Color bgColor, Color fgColor) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      color: bgColor,
      child: Row(
        children: [
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: fgColor, fontSize: 13),
            ),
          ),
          IconButton(
            icon: Icon(Icons.close, size: 18, color: fgColor),
            onPressed: () => setState(() {}),
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
        ],
      ),
    );
  }

  Widget _emptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.how_to_vote_outlined, size: 64, color: Colors.grey.shade400),
          const SizedBox(height: 16),
          Text(
            'No proposals are currently open.',
            style: TextStyle(color: Colors.grey.shade600),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: () => ref.read(voteProvider.notifier).fetchProposals(),
            icon: const Icon(Icons.refresh, size: 18),
            label: const Text('Refresh'),
          ),
        ],
      ),
    );
  }
}
