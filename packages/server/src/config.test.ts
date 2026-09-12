import { describe, expect, it } from "vitest";
import { normalizeSiteHostSuffix } from "./config.js";

describe("normalizeSiteHostSuffix", () => {
  it("accepts a bare domain and tidies it", () => {
    expect(normalizeSiteHostSuffix("hype-share.com")).toBe("hype-share.com");
    expect(normalizeSiteHostSuffix(" .Hype-Share.COM. ")).toBe("hype-share.com");
    expect(normalizeSiteHostSuffix("sites.example.org/")).toBe("sites.example.org");
  });

  it("treats unset and blank as disabled", () => {
    expect(normalizeSiteHostSuffix(undefined)).toBeNull();
    expect(normalizeSiteHostSuffix("")).toBeNull();
    expect(normalizeSiteHostSuffix("  ")).toBeNull();
  });

  it("rejects schemes, wildcards, and single labels", () => {
    for (const bad of ["https://hype-share.com", "*.hype-share.com", "localhost", "a b.com"]) {
      expect(() => normalizeSiteHostSuffix(bad), bad).toThrow(/bare domain/);
    }
  });
});
