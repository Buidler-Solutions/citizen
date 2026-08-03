import 'dart:convert';

dynamic _canonicalizeValue(dynamic value) {
  if (value is List) {
    return value.map(_canonicalizeValue).toList();
  }
  if (value is Map) {
    final entries = value.entries
        .where((e) => e.value != null)
        .toList()
      ..sort((a, b) => (a.key as String).compareTo(b.key as String));
    final sorted = <String, dynamic>{};
    for (final entry in entries) {
      sorted[entry.key as String] = _canonicalizeValue(entry.value);
    }
    return sorted;
  }
  return value;
}

String canonicalJson(dynamic value) {
  return jsonEncode(_canonicalizeValue(value));
}
