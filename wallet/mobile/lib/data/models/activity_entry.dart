class ActivityEntry {
  final String requestedAt;
  final String origin;
  final String method;
  final dynamic params;
  final String account;

  const ActivityEntry({
    required this.requestedAt,
    required this.origin,
    required this.method,
    required this.params,
    required this.account,
  });

  Map<String, dynamic> toJson() => {
        'requestedAt': requestedAt,
        'origin': origin,
        'method': method,
        'params': params,
        'account': account,
      };

  factory ActivityEntry.fromJson(Map<String, dynamic> json) {
    return ActivityEntry(
      requestedAt: json['requestedAt'] as String,
      origin: json['origin'] as String,
      method: json['method'] as String,
      params: json['params'],
      account: json['account'] as String,
    );
  }
}
