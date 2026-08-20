/// Hex helpers matching the TreasureNet chain SDK byte encoding
/// (lowercase hex, raw 32-byte keys, raw 64-byte signatures).
library;

import 'dart:convert';

String bytesToHex(List<int> bytes) {
  final buffer = StringBuffer();
  for (final byte in bytes) {
    buffer.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return buffer.toString();
}

List<int> utf8Bytes(String value) => utf8.encode(value);

List<int> base64DecodeBytes(String value) => base64.decode(value);

List<int> hexToBytes(String hexValue) {
  final normalized = hexValue.trim();
  if (normalized.length.isOdd || normalized.isEmpty) {
    throw ArgumentError('hex string must have an even, non-zero length');
  }
  final bytes = <int>[];
  for (var i = 0; i < normalized.length; i += 2) {
    bytes.add(int.parse(normalized.substring(i, i + 2), radix: 16));
  }
  return bytes;
}
