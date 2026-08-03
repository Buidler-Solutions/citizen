import 'dart:convert';

import 'package:dio/dio.dart';

import '../../core/config/app_config.dart';
import '../models/direct_submit.dart';
import '../models/network_config.dart';

class CitizenApiService {
  static final CitizenApiService _instance = CitizenApiService._internal();
  factory CitizenApiService() => _instance;
  CitizenApiService._internal();

  final _dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 5),
    receiveTimeout: const Duration(seconds: 10),
    sendTimeout: const Duration(seconds: 10),
  ));

  // ─── Health Check ─────────────────────────────────────────

  Future<bool> isNetworkAlive(NetworkId networkId) async {
    final info = NetworkInfo.fromId(networkId);
    try {
      final response = await _dio.get<dynamic>(
        info.healthUrl,
        options: Options(
          sendTimeout: const Duration(seconds: 3),
          receiveTimeout: const Duration(seconds: 3),
          extra: {'dio_cache_disabled': true},
        ),
      );
      return response.statusCode != null && response.statusCode! >= 200 && response.statusCode! < 300;
    } catch (_) {
      return false;
    }
  }

  Future<Map<NetworkId, bool>> getNetworkLiveness() async {
    final results = <NetworkId, bool>{};
    for (final id in NetworkId.values) {
      results[id] = await isNetworkAlive(id);
    }
    return results;
  }

  // ─── Direct Submit ────────────────────────────────────────

  bool _isAllowlisted(String url) {
    return AppConfig.directSubmitAllowlist.any((entry) => entry == url);
  }

  Future<DirectSubmitResponse> submitSignedArtifact({
    required String destinationUrl,
    required SignedSubmissionArtifact signedArtifact,
    bool consentToShareSigningPayload = false,
  }) async {
    if (!_isAllowlisted(destinationUrl)) {
      throw Exception('Destination URL is not in the allowlist.');
    }

    final body = <String, dynamic>{
      'signerDid': signedArtifact.signerDid,
      'verifyingKey': signedArtifact.verifyingKey,
      'signature': signedArtifact.signature,
      'payloadHash': signedArtifact.payloadHash,
      'algorithm': signedArtifact.algorithm,
      'signatureScope': signedArtifact.signatureScope,
      if (consentToShareSigningPayload) 'signingPayload': signedArtifact.signingPayload,
      if (signedArtifact.requestId != null) 'requestId': signedArtifact.requestId,
    };

    final stopwatch = Stopwatch()..start();
    final response = await _dio.post<dynamic>(
      destinationUrl,
      data: jsonEncode(body),
      options: Options(headers: {'Content-Type': 'application/json'}),
    );
    stopwatch.stop();

    final responseData = response.data is String
        ? jsonDecode(response.data as String) as Map<String, dynamic>
        : response.data as Map<String, dynamic>;

    return _extractReceipt(responseData, stopwatch.elapsedMilliseconds);
  }

  Future<DirectSubmitResponse> submitEnvelopesBatch({
    required String apiBaseUrl,
    required List<Map<String, dynamic>> envelopes,
    bool consentToShareFullPayload = false,
  }) async {
    final normalizedBase = apiBaseUrl.replaceAll(RegExp(r'/+$'), '');
    if (!AppConfig.apiBaseAllowlist.contains(normalizedBase)) {
      throw Exception('API base URL is not in the allowlist.');
    }

    final url = '$normalizedBase/api/v1/envelopes/submit-batch';
    final stopwatch = Stopwatch()..start();
    final response = await _dio.post<dynamic>(
      url,
      data: jsonEncode({
        'envelopes': envelopes,
        'consentToShareFullPayload': consentToShareFullPayload,
      }),
      options: Options(headers: {'Content-Type': 'application/json'}),
    );
    stopwatch.stop();

    final responseData = response.data is String
        ? jsonDecode(response.data as String) as Map<String, dynamic>
        : response.data as Map<String, dynamic>;

    return _extractReceipt(responseData, stopwatch.elapsedMilliseconds);
  }

  // ─── Receipt Lookup ───────────────────────────────────────

  Future<Map<String, dynamic>?> lookupReceipt({
    required String apiBaseUrl,
    required String receiptId,
  }) async {
    final normalizedBase = apiBaseUrl.replaceAll(RegExp(r'/+$'), '');
    if (!AppConfig.apiBaseAllowlist.contains(normalizedBase)) {
      throw Exception('API base URL is not in the allowlist.');
    }

    final url = '$normalizedBase/api/v1/receipts/$receiptId';
    final response = await _dio.get<dynamic>(url);
    if (response.statusCode == 404) return null;

    return response.data is String
        ? jsonDecode(response.data as String) as Map<String, dynamic>
        : response.data as Map<String, dynamic>;
  }

  // ─── Helpers ──────────────────────────────────────────────

  DirectSubmitResponse _extractReceipt(Map<String, dynamic> payload, int latencyMs) {
    final direct = payload['receipt'] as Map<String, dynamic>?;
    if (direct != null) {
      final finality = direct['finality'] as Map<String, dynamic>?;
      return DirectSubmitResponse(
        traceId: payload['traceId'] as String? ?? '',
        idempotencyKey: payload['idempotencyKey'] as String? ?? '',
        status: payload['status'] as int? ?? 200,
        latencyMs: latencyMs,
        receiptId: direct['receipt_id'] as String?,
        receiptHash: finality?['block_hash'] as String?,
        blockHeight: finality?['block_height'] as int?,
      );
    }

    final receipts = payload['receipts'] as List?;
    if (receipts != null && receipts.isNotEmpty) {
      final first = receipts[0] as Map<String, dynamic>;
      final firstReceipt = first['receipt'] as Map<String, dynamic>?;
      final finality = firstReceipt?['finality'] as Map<String, dynamic>?;
      return DirectSubmitResponse(
        traceId: payload['traceId'] as String? ?? '',
        idempotencyKey: payload['idempotencyKey'] as String? ?? '',
        status: payload['status'] as int? ?? 200,
        latencyMs: latencyMs,
        receiptId: firstReceipt?['receipt_id'] as String?,
        receiptHash: finality?['block_hash'] as String?,
        blockHeight: finality?['block_height'] as int?,
      );
    }

    return DirectSubmitResponse(
      traceId: payload['traceId'] as String? ?? '',
      idempotencyKey: payload['idempotencyKey'] as String? ?? '',
      status: payload['status'] as int? ?? 200,
      latencyMs: latencyMs,
    );
  }
}
