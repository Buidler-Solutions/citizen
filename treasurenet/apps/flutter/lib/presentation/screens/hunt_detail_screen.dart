import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/utils/clue_crypto.dart';
import '../../data/models/hunt_models.dart';
import '../../data/services/api_service.dart';
import '../../data/services/crypto_service.dart';
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
  bool _joining = false;
  bool _joined = false;
  String? _message;
  CheckInResult? _lastResult;
  final Map<int, String> _revealedClues = {};

  /// Canonical admission payment message: the player authorizes the fee
  /// transfer to the GM (mirrors assetMessages.transfer on the backend).
  String _admissionPaymentMessage(Hunt hunt, String playerDid) =>
      'transfer:${hunt.rewardToken}:$playerDid:${hunt.gmDid}:'
      '${hunt.admissionFee}:join-${hunt.huntId}';

  Future<void> _join(Hunt hunt) async {
    final auth = ref.read(sessionProvider);
    if (auth.did == null || auth.seedHex == null) return;
    setState(() {
      _joining = true;
      _message = null;
    });
    try {
      String? paymentSignature;
      if (hunt.isPaidAdmission) {
        paymentSignature = await DeviceCryptoService.instance.signMessage(
          _admissionPaymentMessage(hunt, auth.did!),
          auth.seedHex!,
        );
      }
      final result = await ref.read(apiProvider).joinHunt(
        huntId: hunt.huntId,
        paymentSignature: paymentSignature,
      );
      setState(() {
        _joining = false;
        _joined = true;
        _message = hunt.isPaidAdmission
            ? 'Joined — admission fee ${result.feePaid} ${hunt.rewardToken} transferred to the Game Master.'
            : 'Joined the hunt. Head to the first checkpoint!';
      });
    } catch (error) {
      final apiError = toApiException(error);
      setState(() {
        _joining = false;
        if (apiError.code == 'AlreadyJoined') {
          _joined = true;
          _message = null;
        } else {
          _message = 'Join failed: ${apiError.toString()}';
        }
      });
    }
  }

  Future<void> _revealClue(int clueIndex) async {
    if (_revealedClues.containsKey(clueIndex)) return;
    try {
      final encrypted = await ref.read(apiProvider).readEncryptedClue(
            huntId: widget.huntId,
            clueIndex: clueIndex,
          );
      if (!encrypted.hasKey) {
        setState(() => _message =
            'No encrypted clue content uploaded for clue $clueIndex.');
        return;
      }
      final plaintext = await decryptClue(
        manifestId: encrypted.manifestId,
        keyWrappedB64: encrypted.keyWrappedB64!,
        ivB64: encrypted.ivB64,
        ciphertextB64: encrypted.ciphertextB64,
      );
      setState(() => _revealedClues[clueIndex] = plaintext);
    } catch (error) {
      final apiError = toApiException(error);
      setState(() =>
          _message = 'Clue reveal failed: ${apiError.toString()}');
    }
  }

  Future<void> _checkIn(HuntProgress? progress) async {
    final nextIndex = progress?.nextClueIndex;
    if (nextIndex == null) return;
    setState(() {
      _checkingIn = true;
      _message = null;
    });
    try {
      setState(() => _message = 'Verifying location proof…');
      final trusted = await trustedFix();
      final fix = trusted.fix;
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
        _message = result.instantClaim != null && result.instantClaim!.confirmed
            ? 'Treasure found! Reward of ${result.instantClaim!.rewardAmount} '
              'paid instantly.'
            : result.isFinalClue
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
        } else if (apiError.code == 'NotParticipant') {
          _joined = false;
          _message = 'Join the hunt before checking in.';
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
                        revealedText: _revealedClues[clue.index],
                        onReveal: () => _revealClue(clue.index),
                      ),
                    const SizedBox(height: 12),
                    if (hunt.isActive && !_joined)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: FilledButton.tonalIcon(
                          icon: _joining
                              ? const SizedBox(
                                  height: 18,
                                  width: 18,
                                  child: CircularProgressIndicator(
                                      strokeWidth: 2),
                                )
                              : const Icon(Icons.group_add_outlined),
                          label: Text(
                            hunt.isPaidAdmission
                                ? 'Join — pay ${hunt.admissionFee} ${hunt.rewardToken} admission'
                                : 'Join hunt (free admission)',
                          ),
                          onPressed: !_joining ? () => _join(hunt) : null,
                        ),
                      ),
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
    this.revealedText,
    this.onReveal,
  });

  final HuntClue clue;
  final bool unlocked;
  final bool isNext;
  final bool isFinal;
  final String? revealedText;
  final VoidCallback? onReveal;

  @override
  Widget build(BuildContext context) {
    final color = unlocked
        ? Colors.green
        : isNext
            ? Theme.of(context).colorScheme.primary
            : Colors.grey;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ListTile(
              contentPadding: EdgeInsets.zero,
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
                style:
                    const TextStyle(fontFamily: 'monospace', fontSize: 11),
              ),
            ),
            if (unlocked && revealedText == null)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  icon: const Icon(Icons.enhanced_encryption_outlined),
                  label: const Text('Reveal encrypted clue'),
                  onPressed: onReveal,
                ),
              ),
            if (revealedText != null)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(revealedText!),
              ),
          ],
        ),
      ),
    );
  }
}
