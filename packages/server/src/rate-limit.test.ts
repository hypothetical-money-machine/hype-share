import { describe, expect, it } from "vitest";
import { openDb, pruneRateLimits } from "./db.js";
import {
  consumeRate,
  DAY_MS,
  HOUR_MS,
  RATE_LIMIT_WINDOWS,
} from "./rate-limit.js";

describe("consumeRate", () => {
  it("allows up to the limit then refuses", () => {
    const db = openDb(":memory:");
    const now = 1_700_000_000_000;
    expect(consumeRate(db, "b", "publish", 2, now)).toBe(true);
    expect(consumeRate(db, "b", "publish", 2, now)).toBe(true);
    expect(consumeRate(db, "b", "publish", 2, now)).toBe(false);
    db.close();
  });

  it("resets in the next window", () => {
    const db = openDb(":memory:");
    const now = 1_700_000_000_000;
    expect(consumeRate(db, "b", "publish", 1, now)).toBe(true);
    const later = now + HOUR_MS;
    expect(consumeRate(db, "b", "publish", 1, later)).toBe(true);
    const leftover = db
      .prepare(`SELECT window_start FROM rate_limits WHERE action = 'publish'`)
      .all() as { window_start: number }[];
    expect(leftover.map((r) => Number(r.window_start))).toEqual([
      Math.floor(later / HOUR_MS) * HOUR_MS,
    ]);
    db.close();
  });

  it("uses the shared action windows when pruning", () => {
    const db = openDb(":memory:");
    const now = 1_700_000_000_000;
    expect(RATE_LIMIT_WINDOWS).toEqual({
      publish: HOUR_MS,
      register: DAY_MS,
      claim: HOUR_MS,
      owner_login: HOUR_MS,
      org_join: HOUR_MS,
    });
    const insert = db.prepare(
      `INSERT INTO rate_limits (bucket, action, window_start, count)
       VALUES (?, ?, ?, 1)`,
    );
    for (const [action, windowMs] of Object.entries(RATE_LIMIT_WINDOWS)) {
      const current = Math.floor(now / windowMs) * windowMs;
      insert.run(`old-${action}`, action, current - windowMs);
      insert.run(`current-${action}`, action, current);
    }

    expect(pruneRateLimits(db, now)).toBe(5);
    expect(
      db.prepare(`SELECT action FROM rate_limits ORDER BY action`).all(),
    ).toEqual([
      { action: "claim" },
      { action: "org_join" },
      { action: "owner_login" },
      { action: "publish" },
      { action: "register" },
    ]);
    db.close();
  });
});
