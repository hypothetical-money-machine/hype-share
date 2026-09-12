import { describe, expect, it } from "vitest";
import { normalizeSiteHostSuffix } from "./config.js";

describe("normalizeSiteHostSuffix", () => {
  it("accepts a bare domain and tidies it", () => {
    expect(normalizeSiteHostSuffix("share.example.com")).toBe("share.example.com");
    expect(normalizeSiteHostSuffix(" .Share.Example.COM. ")).toBe("share.example.com");
    expect(normalizeSiteHostSuffix("sites.example.org/")).toBe("sites.example.org");
  });

  it("treats unset and blank as disabled", () => {
    expect(normalizeSiteHostSuffix(undefined)).toBeNull();
    expect(normalizeSiteHostSuffix("")).toBeNull();
    expect(normalizeSiteHostSuffix("  ")).toBeNull();
  });

  it("rejects schemes, wildcards, single labels, and bad dns labels", () => {
    const bad = [
      "https://share.example.com",
      "*.share.example.com",
      "localhost",
      "a b.com",
      "-bad.example",
      "bad-.example",
      "a..b",
      `${"x".repeat(64)}.example`,
      `${"y".repeat(63)}.`.repeat(3) + "example",
    ];
    for (const b of bad) {
      expect(() => normalizeSiteHostSuffix(b), b).toThrow(/bare domain/);
    }
    expect(normalizeSiteHostSuffix(`${"x".repeat(63)}.example`)).toBe(`${"x".repeat(63)}.example`);
  });
});
