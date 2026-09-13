import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { consumeRate, HOUR_MS } from "./rate-limit.js";

describe("consumeRate", () => {
  it("allows up to the limit then refuses", () => {
    const db = openDb(":memory:");
    const now = 1_700_000_000_000;
    expect(consumeRate(db, "b", "publish", HOUR_MS, 2, now)).toBe(true);
    expect(consumeRate(db, "b", "publish", HOUR_MS, 2, now)).toBe(true);
    expect(consumeRate(db, "b", "publish", HOUR_MS, 2, now)).toBe(false);
    db.close();
  });

  it("resets in the next window", () => {
    const db = openDb(":memory:");
    const now = 1_700_000_000_000;
    expect(consumeRate(db, "b", "publish", HOUR_MS, 1, now)).toBe(true);
    const later = now + HOUR_MS;
    expect(consumeRate(db, "b", "publish", HOUR_MS, 1, later)).toBe(true);
    const leftover = db
      .prepare(`SELECT window_start FROM rate_limits WHERE action = 'publish'`)
      .all() as { window_start: number }[];
    expect(leftover.map((r) => Number(r.window_start))).toEqual([
      Math.floor(later / HOUR_MS) * HOUR_MS,
    ]);
    db.close();
  });
});
