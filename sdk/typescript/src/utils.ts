import type { JsonValue, MultisigPolicy } from "./types.js";

function hasWebCrypto(): boolean {
  return typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function";
}

export function createUuid(): string {
  if (hasWebCrypto()) {
    return globalThis.crypto.randomUUID();
  }

  throw new Error("crypto.randomUUID is required (Node.js 18+ or modern browser)");
}

function canonicalizeValue(value: JsonValue | unknown): JsonValue | unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }

  if (value && typeof value === "object") {
    const orderedEntries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalizeValue(entryValue)]);

    return Object.fromEntries(orderedEntries);
  }

  return value;
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export async function sha256DigestHex(input: string | Uint8Array): Promise<string> {
  const source = typeof input === "string" ? new TextEncoder().encode(input) : input;

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", source as BufferSource);
    return `sha256:${Buffer.from(digest).toString("hex")}`;
  }

  const { createHash } = await import("node:crypto");
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export const DEFAULT_RECEIPT_TERMINAL_STATUSES = new Set(["Accepted", "Rejected"]);

export const OFFCHAIN_ATTACHMENT_ALLOWED_MIME_TYPES: readonly string[] = Object.freeze([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/ogg",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.ms-word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/msexcel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

export function assertSha256Digest(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{6,}$/i.test(value)) {
    throw new Error(`${field} must be a sha256:<hex> digest string`);
  }
}

export function assertHttpUrl(value: unknown, field: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid http(s) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must be a valid http(s) URL`);
  }
}

export function assertPositiveAmount(payload: Record<string, unknown>): void {
  if (
    typeof payload.amount !== "number" ||
    !Number.isFinite(payload.amount) ||
    payload.amount <= 0
  ) {
    throw new Error("builder.credits payload.amount must be a positive number");
  }
}

export function assertMultisigPolicy(multisigPolicy: MultisigPolicy | undefined): asserts multisigPolicy is MultisigPolicy {
  if (!multisigPolicy || typeof multisigPolicy !== "object") {
    throw new Error("multisigPolicy is required for multisig envelopes");
  }

  if (!Number.isInteger(multisigPolicy.threshold) || multisigPolicy.threshold < 1) {
    throw new Error("multisigPolicy.threshold must be an integer >= 1");
  }
}
