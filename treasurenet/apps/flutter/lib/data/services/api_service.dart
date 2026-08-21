import 'package:dio/dio.dart';

import '../../core/config/app_config.dart';
import '../models/hunt_models.dart';

/// API client for the TreasureNet backend on port 7755.
///
/// All player chain writes are service-sponsored (builder credits): the app
/// signs only the login challenge; check-ins and claim requests ride the
/// bearer session. Finality comes back as receipt id + block height.
class TreasurenetApi {
  TreasurenetApi({String? baseUrl, String? sessionToken})
      : _dio = Dio(
          BaseOptions(
            baseUrl: baseUrl ?? AppConfig.effectiveApiBaseUrl,
            connectTimeout: const Duration(seconds: 8),
            receiveTimeout: const Duration(seconds: 15),
            headers: {'Content-Type': 'application/json'},
          ),
        ) {
    if (sessionToken != null) {
      _dio.options.headers['Authorization'] = 'Bearer $sessionToken';
    }
  }

  final Dio _dio;

  void updateSession(String? sessionToken) {
    if (sessionToken == null) {
      _dio.options.headers.remove('Authorization');
    } else {
      _dio.options.headers['Authorization'] = 'Bearer $sessionToken';
    }
  }

  Future<Map<String, dynamic>> _get(String path) async =>
      (await _dio.get<Map<String, dynamic>>(path)).data ?? const {};

  Future<List<Map<String, dynamic>>> _getList(String path) async {
    final response = await _dio.get<List<dynamic>>(path);
    return (response.data ?? const [])
        .map((item) => item as Map<String, dynamic>)
        .toList();
  }

  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body,
  ) async =>
      (await _dio.post<Map<String, dynamic>>(path, data: body)).data ??
      const {};

  // ── identity + auth ──

  Future<void> registerWallet(String did) =>
      _post('/wallet/register', {'did': did});

  Future<AuthChallenge> requestChallenge(String did) async {
    final json = await _post('/auth/challenge', {'did': did});
    return AuthChallenge.fromJson(json);
  }

  Future<String> verifyChallenge({
    required String did,
    required String signatureHex,
  }) async {
    final json = await _post('/auth/verify', {
      'did': did,
      'signature': signatureHex,
    });
    return json['token'] as String;
  }

  // ── consent ──

  Future<ConsentStatus?> consentStatus() async {
    final json = await _get('/consent/status');
    if (json.isEmpty) return null;
    return ConsentStatus.fromJson(json);
  }

  Future<ConsentStatus> grantConsent(List<String> purposes) async {
    final json = await _post('/consent/grant', {'purposes': purposes});
    return ConsentStatus.fromJson(json);
  }

  // ── hunts + clue flow ──

  Future<List<Hunt>> listHunts() async {
    final items = await _getList('/games');
    return items.map(Hunt.fromJson).toList();
  }

  Future<Hunt> getHunt(String huntId) async =>
      Hunt.fromJson(await _get('/games/$huntId'));

  Future<HuntProgress> huntProgress(String huntId) async =>
      HuntProgress.fromJson(await _get('/games/$huntId/progress'));

  /// Admission: free hunts enroll immediately; paid hunts transfer the fee
  /// to the GM with [paymentSignature] over the canonical transfer message.
  Future<JoinResult> joinHunt({
    required String huntId,
    String? paymentSignature,
  }) async {
    final json = await _post('/games/$huntId/join', {
      if (paymentSignature != null) 'payment_signature': paymentSignature,
    });
    return JoinResult.fromJson(json);
  }

  Future<CheckInResult> checkIn({
    required String huntId,
    required int clueIndex,
    required double latitude,
    required double longitude,
    double? accuracyMeters,
  }) async {
    final json = await _post('/games/$huntId/checkin', {
      'clue_index': clueIndex,
      'latitude': latitude,
      'longitude': longitude,
      if (accuracyMeters != null) 'accuracy_meters': accuracyMeters,
    });
    return CheckInResult.fromJson(json);
  }

  /// Fetches the encrypted clue payload for an unlocked clue (consent-gated,
  /// revocation-checked on the backend). Decryption happens on-device.
  Future<EncryptedClue> readEncryptedClue({
    required String huntId,
    required int clueIndex,
  }) async {
    final json = await _post('/files/clue/read', {
      'hunt_id': huntId,
      'clue_index': clueIndex,
    });
    return EncryptedClue.fromJson(json);
  }

  // ── claim (mobile flow: request, GM approves from the web console) ──

  Future<ClaimRequestResult> requestClaim({
    required String huntId,
    required String photoBase64,
    required double latitude,
    required double longitude,
  }) async {
    final json = await _post('/games/$huntId/claim/request', {
      'photo_b64': photoBase64,
      'latitude': latitude,
      'longitude': longitude,
    });
    return ClaimRequestResult.fromJson(json);
  }

  Future<List<ClaimRecord>> listClaims() async {
    final items = await _getList('/claims');
    return items.map(ClaimRecord.fromJson).toList();
  }

  Future<ClaimRecord?> confirmedClaimFor(String huntId, String playerDid) async {
    final claims = await listClaims();
    for (final claim in claims) {
      if (claim.huntId == huntId &&
          claim.winnerDid == playerDid &&
          claim.confirmed) {
        return claim;
      }
    }
    return null;
  }

  // ── wallet ──

  Future<WalletBalance> balance(String did) async {
    final encoded = Uri.encodeComponent(did);
    return WalletBalance.fromJson(await _get('/wallet/$encoded/balance'));
  }

  Future<List<FinalityReceipt>> receipts(String did) async {
    final encoded = Uri.encodeComponent(did);
    final json = await _get('/wallet/$encoded/receipts');
    final items = (json['receipts'] as List<dynamic>? ?? const []);
    return items
        .map((item) => FinalityReceipt.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  Future<List<WalletNotification>> notifications(String did) async {
    final encoded = Uri.encodeComponent(did);
    final items = await _getList('/wallet/$encoded/notifications');
    return items.map(WalletNotification.fromJson).toList();
  }
}

/// Normalizes Dio failures into a user-facing message with the backend
/// error code attached (ConsentRequired, NotAtLocation, HuntNotActive, ...).
class ApiException implements Exception {
  ApiException(this.code, this.message);

  final String? code;
  final String message;

  bool get isConsentRequired =>
      code == 'ConsentRequired' || code == 'ConsentScope' || code == 'ConsentExpired';

  @override
  String toString() => message;
}

ApiException toApiException(Object error) {
  if (error is DioException) {
    final data = error.response?.data;
    if (data is Map<String, dynamic>) {
      return ApiException(
        data['code'] as String?,
        data['error'] as String? ?? 'request failed',
      );
    }
    return ApiException(null, error.message ?? 'network error');
  }
  return ApiException(null, error.toString());
}
