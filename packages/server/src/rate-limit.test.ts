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
    expect(consumeRate(db, "b", "publish", HOUR_MS, 1, now + HOUR_MS)).toBe(true);
    db.close();
  });
});
