import 'dart:convert';
import 'dart:typed_data';

Uint8List hexToBytes(String hex) {
  final normalized = hex.startsWith('0x') ? hex.substring(2) : hex;
  if (normalized.length % 2 != 0) {
    throw FormatException('Hex string must have even length');
  }
  final out = Uint8List(normalized.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(normalized.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String bytesToHex(List<int> bytes) {
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

String base64ToBase64Url(String b64) {
  return b64.replaceAll('+', '-').replaceAll('/', '_').replaceAll(RegExp(r'=+$'), '');
}

Uint8List _decodeBase64(String input) {
  final normalized = input.replaceAll('-', '+').replaceAll('_', '/');
  final padded = normalized + '=' * ((4 - normalized.length % 4) % 4);
  return base64.decode(padded);
}

Uint8List base64ToBytes(String b64) {
  return _decodeBase64(b64);
}

String bytesToBase64(List<int> bytes) {
  return base64.encode(bytes);
}

String bytesToBase64Url(List<int> bytes) {
  return base64ToBase64Url(base64.encode(bytes));
}

Uint8List concatBytes(List<int> a, List<int> b) {
  final out = Uint8List(a.length + b.length);
  out.setRange(0, a.length, a);
  out.setRange(a.length, out.length, b);
  return out;
}
