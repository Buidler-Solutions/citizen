function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function quarterRound(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] ^= state[a];
  state[d] = rotl(state[d], 16);

  state[c] = (state[c] + state[d]) >>> 0;
  state[b] ^= state[c];
  state[b] = rotl(state[b], 12);

  state[a] = (state[a] + state[b]) >>> 0;
  state[d] ^= state[a];
  state[d] = rotl(state[d], 8);

  state[c] = (state[c] + state[d]) >>> 0;
  state[b] ^= state[c];
  state[b] = rotl(state[b], 7);
}

function chacha20Block(key: Uint8Array, counter: number, nonce12: Uint8Array): Uint8Array {
  const state = new Uint32Array(16);
  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;

  for (let i = 0; i < 8; i += 1) {
    state[4 + i] = readU32LE(key, i * 4);
  }
  state[12] = counter >>> 0;
  state[13] = readU32LE(nonce12, 0);
  state[14] = readU32LE(nonce12, 4);
  state[15] = readU32LE(nonce12, 8);

  const working = new Uint32Array(state);
  for (let i = 0; i < 10; i += 1) {
    quarterRound(working, 0, 4, 8, 12);
    quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14);
    quarterRound(working, 3, 7, 11, 15);
    quarterRound(working, 0, 5, 10, 15);
    quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13);
    quarterRound(working, 3, 4, 9, 14);
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i += 1) {
    writeU32LE(out, i * 4, (working[i] + state[i]) >>> 0);
  }
  return out;
}

function chacha20Xor(key: Uint8Array, nonce12: Uint8Array, counter: number, input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length);
  let blockCounter = counter >>> 0;
  for (let offset = 0; offset < input.length; offset += 64) {
    const block = chacha20Block(key, blockCounter, nonce12);
    const len = Math.min(64, input.length - offset);
    for (let i = 0; i < len; i += 1) {
      output[offset + i] = input[offset + i] ^ block[i];
    }
    blockCounter = (blockCounter + 1) >>> 0;
  }
  return output;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    result = (result << 8n) + BigInt(bytes[i]);
  }
  return result;
}

function bigIntToBytesLE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let current = value;
  for (let i = 0; i < length; i += 1) {
    out[i] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out;
}

function poly1305Mac(message: Uint8Array, oneTimeKey: Uint8Array): Uint8Array {
  const clamp = oneTimeKey.slice(0, 16);
  clamp[3] &= 15;
  clamp[7] &= 15;
  clamp[11] &= 15;
  clamp[15] &= 15;
  clamp[4] &= 252;
  clamp[8] &= 252;
  clamp[12] &= 252;

  const r = bytesToBigIntLE(clamp);
  const s = bytesToBigIntLE(oneTimeKey.slice(16, 32));
  const p = (1n << 130n) - 5n;
  let acc = 0n;

  for (let offset = 0; offset < message.length; offset += 16) {
    const block = message.slice(offset, Math.min(offset + 16, message.length));
    const n = bytesToBigIntLE(block) + (1n << BigInt(8 * block.length));
    acc = (acc + n) % p;
    acc = (acc * r) % p;
  }

  const tag = (acc + s) & ((1n << 128n) - 1n);
  return bigIntToBytesLE(tag, 16);
}

function pad16Length(length: number): number {
  const mod = length % 16;
  return mod === 0 ? 0 : 16 - mod;
}

function buildAeadMacData(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const aadPad = pad16Length(aad.length);
  const cipherPad = pad16Length(ciphertext.length);
  const total = aad.length + aadPad + ciphertext.length + cipherPad + 16;
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(aad, offset);
  offset += aad.length + aadPad;
  out.set(ciphertext, offset);
  offset += ciphertext.length + cipherPad;

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigUint64(offset, BigInt(aad.length), true);
  view.setBigUint64(offset + 8, BigInt(ciphertext.length), true);
  return out;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left[i] ^ right[i];
  }
  return mismatch === 0;
}

export function chacha20Poly1305Encrypt(
  key: Uint8Array,
  nonce12: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (key.length !== 32 || nonce12.length !== 12) {
    throw new Error('chacha20Poly1305Encrypt: key must be 32 bytes and nonce must be 12 bytes');
  }
  const oneTimeKey = chacha20Block(key, 0, nonce12).slice(0, 32);
  const ciphertext = chacha20Xor(key, nonce12, 1, plaintext);
  const macData = buildAeadMacData(aad, ciphertext);
  const tag = poly1305Mac(macData, oneTimeKey);
  const result = new Uint8Array(ciphertext.length + 16);
  result.set(ciphertext, 0);
  result.set(tag, ciphertext.length);
  return result;
}

export function chacha20Poly1305Decrypt(
  key: Uint8Array,
  nonce12: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad = new Uint8Array(0),
): Uint8Array | null {
  if (key.length !== 32 || nonce12.length !== 12 || ciphertextAndTag.length < 16) {
    return null;
  }
  const ciphertext = ciphertextAndTag.slice(0, ciphertextAndTag.length - 16);
  const tag = ciphertextAndTag.slice(ciphertextAndTag.length - 16);
  const oneTimeKey = chacha20Block(key, 0, nonce12).slice(0, 32);
  const macData = buildAeadMacData(aad, ciphertext);
  const expectedTag = poly1305Mac(macData, oneTimeKey);
  if (!timingSafeEqual(expectedTag, tag)) {
    return null;
  }
  return chacha20Xor(key, nonce12, 1, ciphertext);
}
