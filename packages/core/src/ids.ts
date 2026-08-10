import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** URL-safe short id (default 10 chars ≈ 51 bits). */
export function createSiteId(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** Monotonic-ish version id (time prefix + random). */
export function createVersionId(): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(6).toString("hex");
  return `${time}${rand}`;
}

/** Generate a high-entropy API key with `sp_` prefix. */
export function createApiKey(): string {
  return `sp_${randomBytes(24).toString("base64url")}`;
}
