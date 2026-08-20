import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../data/models/hunt_models.dart';
import '../../data/services/api_service.dart';
import '../../providers/hunt_provider.dart';
import '../../providers/session_provider.dart';
import '../widgets/finality_receipt_card.dart';

/// Claim flow: capture photo proof at the final clue, submit the claim
/// request, then poll for the Game Master's web-console approval. The
/// payout lands with a finality receipt (id + block height + reward).
class ClaimScreen extends ConsumerStatefulWidget {
  const ClaimScreen({super.key, required this.huntId});

  final String huntId;

  @override
  ConsumerState<ClaimScreen> createState() => _ClaimScreenState();
}

enum _ClaimStage { capture, awaitingApproval, confirmed, denied, error }

class _ClaimScreenState extends ConsumerState<ClaimScreen> {
  _ClaimStage _stage = _ClaimStage.capture;
  Uint8List? _photoBytes;
  String? _requestId;
  ClaimRecord? _claim;
  String? _error;
  Timer? _pollTimer;
  int _pollAttempts = 0;

  static const _maxPollAttempts = 60;

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _capture() async {
    try {
      final picked = await ImagePicker().pickImage(
        source: ImageSource.camera,
        maxWidth: 1280,
        imageQuality: 70,
      );
      if (picked == null) return;
      final bytes = await File(picked.path).readAsBytes();
      setState(() => _photoBytes = bytes);
    } catch (error) {
      setState(() {
        _stage = _ClaimStage.error;
        _error = 'camera unavailable: $error';
      });
    }
  }

  Future<void> _submit() async {
    if (_photoBytes == null) return;
    setState(() => _stage = _ClaimStage.awaitingApproval);
    try {
      final trusted = await trustedFix();
      final fix = trusted.fix;
      final request = await ref.read(apiProvider).requestClaim(
            huntId: widget.huntId,
            photoBase64: base64Encode(_photoBytes!),
            latitude: fix.latitude,
            longitude: fix.longitude,
          );
      setState(() => _requestId = request.requestId);
      _startPolling();
    } catch (error) {
      final apiError = toApiException(error);
      setState(() {
        _stage = apiError.isConsentRequired
            ? _ClaimStage.capture
            : _ClaimStage.error;
        _error = apiError.isConsentRequired
            ? 'Photo consent required before claiming.'
            : apiError.toString();
      });
    }
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) async {
      _pollAttempts += 1;
      if (_pollAttempts > _maxPollAttempts) {
        _pollTimer?.cancel();
        if (mounted) {
          setState(() => _error =
              'Still awaiting Game Master approval. Check notifications later.');
        }
        return;
      }
      try {
        final api = ref.read(apiProvider);
        final did = ref.read(sessionProvider).did;
        final claim = await api.confirmedClaimFor(widget.huntId, did ?? '');
        if (claim != null) {
          _pollTimer?.cancel();
          if (mounted) {
            setState(() {
              _claim = claim;
              _stage = _ClaimStage.confirmed;
            });
          }
          return;
        }
        final hunt = await api.getHunt(widget.huntId);
        if (hunt.status == 'completed') {
          _pollTimer?.cancel();
          if (mounted) {
            setState(() => _error = 'hunt completed by another player');
          }
        }
      } on Exception {
        // transient network errors: keep polling
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final huntAsync = ref.watch(huntProvider(widget.huntId));
    final hunt = huntAsync.valueOrNull;
    return Scaffold(
      appBar: AppBar(title: Text('Claim ${hunt?.title ?? widget.huntId}')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (hunt != null)
            Text(
              'Reward ${hunt.rewardAmount} ${hunt.rewardToken} held in escrow '
              '${hunt.escrowId}',
            ),
          const SizedBox(height: 16),
          switch (_stage) {
            _ClaimStage.capture => _captureSection(context),
            _ClaimStage.awaitingApproval => _awaitingSection(context),
            _ClaimStage.confirmed => _confirmedSection(),
            _ClaimStage.denied => const Text(
                'Your claim request was denied by the Game Master.'),
            _ClaimStage.error => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    _error ?? 'claim failed',
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: () => setState(() {
                      _error = null;
                      _stage = _ClaimStage.capture;
                    }),
                    child: const Text('Try again'),
                  ),
                ],
              ),
          },
        ],
      ),
    );
  }

  Widget _captureSection(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_photoBytes != null)
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Image.memory(_photoBytes!, height: 240, fit: BoxFit.cover),
          )
        else
          Container(
            height: 240,
            decoration: BoxDecoration(
              border: Border.all(color: Theme.of(context).dividerColor),
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Center(child: Text('Photo proof of the location')),
          ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          icon: const Icon(Icons.photo_camera_outlined),
          label: Text(_photoBytes == null
              ? 'Capture photo proof'
              : 'Retake photo'),
          onPressed: _capture,
        ),
        const SizedBox(height: 8),
        FilledButton.icon(
          icon: const Icon(Icons.send_outlined),
          label: const Text('Submit claim for GM approval'),
          onPressed: _photoBytes == null ? null : _submit,
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              _error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
      ],
    );
  }

  Widget _awaitingSection(BuildContext context) {
    return Column(
      children: [
        const CircularProgressIndicator(),
        const SizedBox(height: 16),
        const Text('Awaiting Game Master approval from the web console…'),
        const SizedBox(height: 8),
        Text(
          'The GM co-signs your claim (2-of-2 with the photo oracle); the '
          'escrow then pays out with an on-chain finality receipt.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (_requestId != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'request $_requestId',
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
            ),
          ),
      ],
    );
  }

  Widget _confirmedSection() {
    final claim = _claim;
    if (claim == null) return const SizedBox.shrink();
    return Column(
      children: [
        const Icon(Icons.emoji_events, size: 56, color: Colors.amber),
        const SizedBox(height: 8),
        const Text('Reward claimed!'),
        const SizedBox(height: 12),
        FinalityReceiptCard(
          receiptId: claim.receiptId,
          blockHeight: claim.blockHeight,
          reward: '${claim.rewardAmount} ${claim.rewardToken}',
        ),
      ],
    );
  }
}
