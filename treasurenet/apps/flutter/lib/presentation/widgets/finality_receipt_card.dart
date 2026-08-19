import 'package:flutter/material.dart';

/// On-chain finality proof: receipt id, block height, reward. Mirrors the
/// Citizen receipt (commit proof) surfaces on the wallet and explorer.
class FinalityReceiptCard extends StatelessWidget {
  const FinalityReceiptCard({
    super.key,
    this.receiptId,
    this.blockHeight,
    this.reward,
    this.commitProof,
  });

  final String? receiptId;
  final int? blockHeight;
  final String? reward;
  final String? commitProof;

  @override
  Widget build(BuildContext context) {
    const mono = TextStyle(fontFamily: 'monospace', fontSize: 11);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.receipt_long, size: 18),
                const SizedBox(width: 8),
                Text('Finality receipt',
                    style: Theme.of(context).textTheme.titleSmall),
              ],
            ),
            const SizedBox(height: 8),
            if (reward != null) Text('reward $reward'),
            Text('receipt ${receiptId ?? 'pending'}', style: mono),
            Text('block height ${blockHeight ?? '?'}', style: mono),
            if (commitProof != null) Text('proof $commitProof', style: mono),
          ],
        ),
      ),
    );
  }
}
