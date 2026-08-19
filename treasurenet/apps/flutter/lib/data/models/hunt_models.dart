import 'package:flutter/foundation.dart';

/// Domain models mirroring packages/shared/src/index.ts on the backend.

@immutable
class HuntClue {
  const HuntClue({
    required this.index,
    required this.manifestId,
    required this.latitude,
    required this.longitude,
    required this.radiusMeters,
  });

  factory HuntClue.fromJson(Map<String, dynamic> json) => HuntClue(
        index: (json['index'] as num).toInt(),
        manifestId: json['manifest_id'] as String,
        latitude: (json['latitude'] as num).toDouble(),
        longitude: (json['longitude'] as num).toDouble(),
        radiusMeters: (json['radius_meters'] as num).toDouble(),
      );

  final int index;
  final String manifestId;
  final double latitude;
  final double longitude;
  final double radiusMeters;
}

@immutable
class Hunt {
  const Hunt({
    required this.huntId,
    required this.gmDid,
    required this.title,
    required this.status,
    required this.rewardAmount,
    required this.rewardToken,
    required this.escrowId,
    required this.expiresAt,
    required this.expiresBlock,
    required this.clues,
    required this.createdAt,
    this.winnerDid,
    this.receiptId,
  });

  factory Hunt.fromJson(Map<String, dynamic> json) => Hunt(
        huntId: json['hunt_id'] as String,
        gmDid: json['gm_did'] as String,
        title: json['title'] as String,
        status: json['status'] as String,
        rewardAmount: (json['reward_amount'] as num).toInt(),
        rewardToken: json['reward_token'] as String? ?? 'CTZN',
        escrowId: json['escrow_id'] as String,
        expiresAt: DateTime.parse(json['expires_at'] as String),
        expiresBlock: (json['expires_block'] as num).toInt(),
        clues: (json['clues'] as List<dynamic>? ?? const [])
            .map((c) => HuntClue.fromJson(c as Map<String, dynamic>))
            .toList(),
        createdAt: DateTime.parse(json['created_at'] as String),
        winnerDid: json['winner_did'] as String?,
        receiptId: json['receipt_id'] as String?,
      );

  final String huntId;
  final String gmDid;
  final String title;
  final String status;
  final int rewardAmount;
  final String rewardToken;
  final String escrowId;
  final DateTime expiresAt;
  final int expiresBlock;
  final List<HuntClue> clues;
  final DateTime createdAt;
  final String? winnerDid;
  final String? receiptId;

  bool get isActive => status == 'active';
  bool get isCompleted => status == 'completed';
}

@immutable
class HuntProgress {
  const HuntProgress({
    required this.huntId,
    required this.playerDid,
    required this.status,
    required this.unlockedClues,
    required this.nextClueIndex,
    required this.finalClueIndex,
  });

  factory HuntProgress.fromJson(Map<String, dynamic> json) => HuntProgress(
        huntId: json['hunt_id'] as String,
        playerDid: json['player_did'] as String,
        status: json['status'] as String,
        unlockedClues: (json['unlocked_clues'] as List<dynamic>? ?? const [])
            .map((i) => (i as num).toInt())
            .toList(),
        nextClueIndex: json['next_clue_index'] == null
            ? null
            : (json['next_clue_index'] as num).toInt(),
        finalClueIndex: (json['final_clue_index'] as num).toInt(),
      );

  final String huntId;
  final String playerDid;
  final String status;
  final List<int> unlockedClues;
  final int? nextClueIndex;
  final int finalClueIndex;

  bool get allCluesUnlocked => nextClueIndex == null;
}

@immutable
class CheckInResult {
  const CheckInResult({
    required this.huntId,
    required this.clueIndex,
    required this.unlocked,
    required this.manifestId,
    required this.isFinalClue,
    required this.distanceMeters,
  });

  factory CheckInResult.fromJson(Map<String, dynamic> json) => CheckInResult(
        huntId: json['hunt_id'] as String,
        clueIndex: (json['clue_index'] as num).toInt(),
        unlocked: json['unlocked'] as bool? ?? false,
        manifestId: json['manifest_id'] as String? ?? '',
        isFinalClue: json['is_final_clue'] as bool? ?? false,
        distanceMeters: (json['distance_meters'] as num?)?.toDouble() ?? 0,
      );

  final String huntId;
  final int clueIndex;
  final bool unlocked;
  final String manifestId;
  final bool isFinalClue;
  final double distanceMeters;
}

@immutable
class ClaimRequestResult {
  const ClaimRequestResult({
    required this.requestId,
    required this.huntId,
    required this.escrowId,
    required this.playerDid,
    required this.status,
  });

  factory ClaimRequestResult.fromJson(Map<String, dynamic> json) =>
      ClaimRequestResult(
        requestId: json['request_id'] as String,
        huntId: json['hunt_id'] as String,
        escrowId: json['escrow_id'] as String,
        playerDid: json['player_did'] as String,
        status: json['status'] as String,
      );

  final String requestId;
  final String huntId;
  final String escrowId;
  final String playerDid;
  final String status;
}

@immutable
class ClaimRecord {
  const ClaimRecord({
    required this.claimId,
    required this.huntId,
    required this.winnerDid,
    required this.rewardAmount,
    required this.rewardToken,
    required this.status,
    this.receiptId,
    this.blockHeight,
  });

  factory ClaimRecord.fromJson(Map<String, dynamic> json) => ClaimRecord(
        claimId: json['claim_id'] as String,
        huntId: json['hunt_id'] as String,
        winnerDid: json['winner_did'] as String,
        rewardAmount: (json['reward_amount'] as num).toInt(),
        rewardToken: json['reward_token'] as String? ?? 'CTZN',
        status: json['status'] as String,
        receiptId: json['receipt_id'] as String?,
        blockHeight: json['block_height'] == null
            ? null
            : (json['block_height'] as num).toInt(),
      );

  final String claimId;
  final String huntId;
  final String winnerDid;
  final int rewardAmount;
  final String rewardToken;
  final String status;
  final String? receiptId;
  final int? blockHeight;

  bool get confirmed => status == 'confirmed';
}

@immutable
class WalletBalance {
  const WalletBalance({
    required this.did,
    required this.token,
    required this.balance,
    required this.source,
  });

  factory WalletBalance.fromJson(Map<String, dynamic> json) => WalletBalance(
        did: json['did'] as String,
        token: json['token'] as String? ?? 'CTZN',
        balance: (json['balance'] as num? ?? 0).toInt(),
        source: json['source'] as String? ?? 'unknown',
      );

  final String did;
  final String token;
  final int balance;
  final String source;
}

@immutable
class FinalityReceipt {
  const FinalityReceipt({
    required this.receiptId,
    required this.blockHeight,
    this.commitProof,
  });

  factory FinalityReceipt.fromJson(Map<String, dynamic> json) => FinalityReceipt(
        receiptId: json['receipt_id'] as String,
        blockHeight: (json['block_height'] as num? ?? 0).toInt(),
        commitProof: json['commit_proof'] as String?,
      );

  final String receiptId;
  final int blockHeight;
  final String? commitProof;
}

@immutable
class WalletNotification {
  const WalletNotification({
    required this.id,
    required this.type,
    required this.message,
    required this.createdAt,
  });

  factory WalletNotification.fromJson(Map<String, dynamic> json) =>
      WalletNotification(
        id: json['id'] as String,
        type: json['type'] as String,
        message: json['message'] as String,
        createdAt: DateTime.parse(json['created_at'] as String),
      );

  final String id;
  final String type;
  final String message;
  final DateTime createdAt;
}

@immutable
class ConsentStatus {
  const ConsentStatus({
    required this.subjectDid,
    required this.purposes,
    required this.grantedAt,
    required this.expiresAt,
    required this.receiptId,
  });

  factory ConsentStatus.fromJson(Map<String, dynamic> json) => ConsentStatus(
        subjectDid: json['subject_did'] as String,
        purposes: (json['purposes'] as List<dynamic>? ?? const [])
            .map((p) => p as String)
            .toList(),
        grantedAt: DateTime.parse(json['granted_at'] as String),
        expiresAt: DateTime.parse(json['expires_at'] as String),
        receiptId: json['receipt_id'] as String,
      );

  final String subjectDid;
  final List<String> purposes;
  final DateTime grantedAt;
  final DateTime expiresAt;
  final String receiptId;

  bool covers(String purpose) => purposes.contains(purpose);
  bool get isValid => expiresAt.isAfter(DateTime.now());
}

@immutable
class AuthChallenge {
  const AuthChallenge({
    required this.nonce,
    required this.message,
    required this.expiresAt,
  });

  factory AuthChallenge.fromJson(Map<String, dynamic> json) => AuthChallenge(
        nonce: json['nonce'] as String,
        message: json['message'] as String,
        expiresAt:
            DateTime.fromMillisecondsSinceEpoch((json['expires_at'] as num).toInt()),
      );

  final String nonce;
  final String message;
  final DateTime expiresAt;
}
