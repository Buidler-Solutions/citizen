import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../data/models/hunt_models.dart';
import '../../data/services/api_service.dart';
import '../../providers/hunt_provider.dart';
import '../../providers/session_provider.dart';

/// Hunt detail: sequential clue chain. Each check-in submits the live GPS
/// fix; the backend gates the unlock on the clue radius, and the final clue
/// unlocks the claim flow.
class HuntDetailScreen extends ConsumerStatefulWidget {
  const HuntDetailScreen({super.key, required this.huntId});

  final String huntId;

  @override
  ConsumerState<HuntDetailScreen> createState() => _HuntDetailScreenState();
}

class _HuntDetailScreenState extends ConsumerState<HuntDetailScreen> {
  bool _checkingIn = false;
  String? _message;
  CheckInResult? _lastResult;

  Future<void> _checkIn(HuntProgress? progress) async {
    final nextIndex = progress?.nextClueIndex;
    if (nextIndex == null) return;
    setState(() {
      _checkingIn = true;
      _message = null;
    });
    try {
      final fix = await currentFix();
      final result = await ref.read(apiProvider).checkIn(
            huntId: widget.huntId,
            clueIndex: nextIndex,
            latitude: fix.latitude,
            longitude: fix.longitude,
            accuracyMeters: fix.accuracyMeters,
          );
      setState(() {
        _checkingIn = false;
        _lastResult = result;
        _message = result.isFinalClue
            ? 'Final clue unlocked! You can claim the reward.'
            : 'Clue ${result.clueIndex} unlocked '
                '(${result.distanceMeters.round()}m from the beacon).';
      });
      ref.invalidate(huntProgressProvider(widget.huntId));
      ref.invalidate(huntProvider(widget.huntId));
    } catch (error) {
      final apiError = toApiException(error);
      setState(() {
        _checkingIn = false;
        if (apiError.isConsentRequired) {
          _message = 'Location consent required before checking in.';
        } else {
          _message = apiError.toString();
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final huntAsync = ref.watch(huntProvider(widget.huntId));
    final progressAsync = ref.watch(huntProgressProvider(widget.huntId));
    final auth = ref.watch(sessionProvider);

    return Scaffold(
      appBar: AppBar(title: Text(huntAsync.valueOrNull?.title ?? widget.huntId)),
      body: huntAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(child: Text(error.toString())),
        data: (hunt) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(huntProvider(widget.huntId));
            ref.invalidate(huntProgressProvider(widget.huntId));
          },
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _Summary(hunt: hunt),
              const SizedBox(height: 16),
              if (hunt.status != 'active' && hunt.status != 'completed')
                Card(
                  color: Theme.of(context).colorScheme.errorContainer,
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Text(
                        'Hunt is ${hunt.status}; check-ins are open only while active.'),
                  ),
                ),
              if (hunt.status == 'completed' && hunt.winnerDid == auth.did)
                Card(
                  color: Theme.of(context).colorScheme.primaryContainer,
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('You won this hunt.'),
                        if (hunt.receiptId != null)
                          Text(
                            'receipt ${hunt.receiptId}',
                            style: const TextStyle(
                                fontFamily: 'monospace', fontSize: 11),
                          ),
                      ],
                    ),
                  ),
                ),
              progressAsync.when(
                loading: () =>
                    const Center(child: CircularProgressIndicator()),
                error: (error, _) => Text(error.toString()),
                data: (progress) => Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final clue in hunt.clues)
                      _ClueTile(
                        clue: clue,
                        unlocked:
                            progress?.unlockedClues.contains(clue.index) ??
                                false,
                        isNext: progress?.nextClueIndex == clue.index,
                        isFinal: progress?.finalClueIndex == clue.index,
                      ),
                    const SizedBox(height: 12),
                    if (progress != null && progress.allCluesUnlocked)
                      FilledButton.icon(
                        icon: const Icon(Icons.emoji_events_outlined),
                        label: const Text('Claim reward'),
                        onPressed: () =>
                            context.go('/hunts/${widget.huntId}/claim'),
                      )
                    else
                      FilledButton.icon(
                        icon: _checkingIn
                            ? const SizedBox(
                                height: 18,
                                width: 18,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2),
                              )
                            : const Icon(Icons.location_searching),
                        label: Text(
                          _checkingIn
                              ? 'Getting GPS fix…'
                              : 'Check in at clue ${progress?.nextClueIndex ?? '?'}',
                        ),
                        onPressed: hunt.status == 'active' && !_checkingIn
                            ? () => _checkIn(progress)
                            : null,
                      ),
                  ],
                ),
              ),
              if (_message != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(_message!),
                ),
              if (_lastResult != null && _lastResult!.manifestId.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    'unlocked manifest ${_lastResult!.manifestId}',
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.hunt});

  final Hunt hunt;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(hunt.title,
                    style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                Text('${hunt.rewardAmount} ${hunt.rewardToken}',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: 4),
            Text('status ${hunt.status} · block deadline ${hunt.expiresBlock}'),
            Text(
              'escrow ${hunt.escrowId}',
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }
}

class _ClueTile extends StatelessWidget {
  const _ClueTile({
    required this.clue,
    required this.unlocked,
    required this.isNext,
    required this.isFinal,
  });

  final HuntClue clue;
  final bool unlocked;
  final bool isNext;
  final bool isFinal;

  @override
  Widget build(BuildContext context) {
    final color = unlocked
        ? Colors.green
        : isNext
            ? Theme.of(context).colorScheme.primary
            : Colors.grey;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: Icon(
          unlocked ? Icons.lock_open : Icons.lock_outline,
          color: color,
        ),
        title: Text('Clue ${clue.index}${isFinal ? ' (final)' : ''}'),
        subtitle: Text(
          unlocked
              ? 'manifest ${clue.manifestId}'
              : 'locked · radius ${clue.radiusMeters.round()}m around '
                  '${clue.latitude.toStringAsFixed(4)}, '
                  '${clue.longitude.toStringAsFixed(4)}',
          style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
        ),
      ),
    );
  }
}
