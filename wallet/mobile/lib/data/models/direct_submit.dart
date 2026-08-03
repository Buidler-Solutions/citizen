import 'network_config.dart';

class SignedSubmissionArtifact {
  final String signerDid;
  final String verifyingKey;
  final String signature;
  final String payloadHash;
  final String signingPayload;
  final String signatureScope;
  final String algorithm;
  final String? requestId;

  const SignedSubmissionArtifact({
    required this.signerDid,
    required this.verifyingKey,
    required this.signature,
    required this.payloadHash,
    required this.signingPayload,
    required this.signatureScope,
    required this.algorithm,
    this.requestId,
  });

  Map<String, dynamic> toJson() => {
        'signerDid': signerDid,
        'verifyingKey': verifyingKey,
        'signature': signature,
        'payloadHash': payloadHash,
        'signingPayload': signingPayload,
        'signatureScope': signatureScope,
        'algorithm': algorithm,
        if (requestId != null) 'requestId': requestId,
      };
}

class DirectSubmitReceipt {
  final String requestId;
  final String? payloadHash;
  final String walletId;
  final String signerDid;
  final NetworkId networkId;
  final String destinationUrl;
  final String traceId;
  final int status;
  final int latencyMs;
  final String? receiptId;
  final String? receiptHash;
  final int? blockHeight;
  final String submittedAt;

  const DirectSubmitReceipt({
    required this.requestId,
    this.payloadHash,
    required this.walletId,
    required this.signerDid,
    required this.networkId,
    required this.destinationUrl,
    required this.traceId,
    required this.status,
    required this.latencyMs,
    this.receiptId,
    this.receiptHash,
    this.blockHeight,
    required this.submittedAt,
  });

  Map<String, dynamic> toJson() => {
        'requestId': requestId,
        'payloadHash': payloadHash,
        'walletId': walletId,
        'signerDid': signerDid,
        'networkId': networkId.name,
        'destinationUrl': destinationUrl,
        'traceId': traceId,
        'status': status,
        'latencyMs': latencyMs,
        'receiptId': receiptId,
        'receiptHash': receiptHash,
        'blockHeight': blockHeight,
        'submittedAt': submittedAt,
      };

  factory DirectSubmitReceipt.fromJson(Map<String, dynamic> json) {
    return DirectSubmitReceipt(
      requestId: json['requestId'] as String,
      payloadHash: json['payloadHash'] as String?,
      walletId: json['walletId'] as String,
      signerDid: json['signerDid'] as String,
      networkId: networkIdFromString(json['networkId'] as String),
      destinationUrl: json['destinationUrl'] as String,
      traceId: json['traceId'] as String,
      status: json['status'] as int,
      latencyMs: json['latencyMs'] as int,
      receiptId: json['receiptId'] as String?,
      receiptHash: json['receiptHash'] as String?,
      blockHeight: json['blockHeight'] as int?,
      submittedAt: json['submittedAt'] as String,
    );
  }
}

class DirectSubmitResponse {
  final String traceId;
  final String idempotencyKey;
  final int status;
  final int latencyMs;
  final String? receiptId;
  final String? receiptHash;
  final int? blockHeight;

  const DirectSubmitResponse({
    required this.traceId,
    required this.idempotencyKey,
    required this.status,
    required this.latencyMs,
    this.receiptId,
    this.receiptHash,
    this.blockHeight,
  });
}
