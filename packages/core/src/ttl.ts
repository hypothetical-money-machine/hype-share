/** ECMAScript time value limit. Beyond this, `Date#toISOString` throws. */
export const MAX_TIME_MS = 8.64e15;

/**
 * Parse a human TTL like "7d", "12h", "30m", "3600s", or a bare number of seconds.
 * Returns milliseconds from now, or null for no expiry.
 */
export function parseTtl(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) {
      throw new Error("ttl must be a positive number of seconds");
    }
    const ms = Math.floor(input * 1000);
    if (!Number.isFinite(ms) || ms > MAX_TIME_MS) {
      throw new Error("ttl must be a positive number of seconds");
    }
    return ms;
  }

  const s = input.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)?$/.exec(s);
  if (!m) {
    throw new Error(`invalid ttl: ${input}`);
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid ttl: ${input}`);
  }
  const unit = m[2] ?? "s";
  const mult =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : unit === "d"
              ? 86_400_000
              : unit === "w"
                ? 7 * 86_400_000
                : 365 * 86_400_000;
  const ms = Math.floor(n * mult);
  if (!Number.isFinite(ms) || ms > MAX_TIME_MS) {
    throw new Error(`invalid ttl: ${input}`);
  }
  return ms;
}

export function expiresAtFromTtl(
  ttl: string | number | null | undefined,
  now = Date.now(),
): number | null {
  const ms = parseTtl(ttl);
  if (ms === null) return null;
  const expires = now + ms;
  if (!Number.isFinite(expires) || Math.abs(expires) > MAX_TIME_MS) {
    throw new Error(`invalid ttl: ${String(ttl)}`);
  }
  return expires;
}
