import type { DatabaseSync } from "node:sqlite";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** True if the caller is still inside the limit after consuming one. */
export function consumeRate(
  db: DatabaseSync,
  bucket: string,
  action: string,
  windowMs: number,
  limit: number,
  now = Date.now(),
): boolean {
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
    db.exec("COMMIT");
    db.prepare(
      `DELETE FROM rate_limits WHERE action = ? AND window_start < ?`,
    ).run(action, windowStart);
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
