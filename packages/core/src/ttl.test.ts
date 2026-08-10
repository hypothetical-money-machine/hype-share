import { describe, expect, it } from "vitest";
import { parseTtl } from "./ttl.js";

describe("parseTtl", () => {
  it("parses units", () => {
    expect(parseTtl("7d")).toBe(7 * 86_400_000);
    expect(parseTtl("12h")).toBe(12 * 3_600_000);
    expect(parseTtl("30m")).toBe(30 * 60_000);
    expect(parseTtl("60s")).toBe(60_000);
    expect(parseTtl(120)).toBe(120_000);
  });

  it("returns null for empty", () => {
    expect(parseTtl(null)).toBeNull();
    expect(parseTtl(undefined)).toBeNull();
    expect(parseTtl("")).toBeNull();
  });
});
