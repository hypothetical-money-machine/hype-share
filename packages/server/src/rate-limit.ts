import type { DatabaseSync } from "node:sqlite";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const RATE_LIMIT_WINDOWS = {
  publish: HOUR_MS,
  register: DAY_MS,
  claim: HOUR_MS,
  owner_login: HOUR_MS,
  org_join: HOUR_MS,
} as const;

export type RateLimitAction = keyof typeof RATE_LIMIT_WINDOWS;

/** True if the caller is still inside the limit after consuming one. */
export function consumeRate(
  db: DatabaseSync,
  bucket: string,
  action: RateLimitAction,
  limit: number,
  now = Date.now(),
): boolean {
  const windowMs = RATE_LIMIT_WINDOWS[action];
  const windowStart = Math.floor(now / windowMs) * windowMs;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        `SELECT count FROM rate_limits
         WHERE bucket = ? AND action = ? AND window_start = ?`,
      )
      .get(bucket, action, windowStart) as { count: number } | undefined;
    if ((row?.count ?? 0) >= limit) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare(
      `INSERT INTO rate_limits (bucket, action, window_start, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(bucket, action, window_start)
       DO UPDATE SET count = count + 1`,
    ).run(bucket, action, windowStart);
    // Same transaction as the increment: a failed cleanup must not leave the
    // slot spent while the caller sees a 500 and retries.
    db.prepare(
      `DELETE FROM rate_limits WHERE action = ? AND window_start < ?`,
    ).run(action, windowStart);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed / no transaction
    }
    throw err;
  }
}
