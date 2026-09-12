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

  it("rejects schemes, wildcards, and single labels", () => {
    for (const bad of ["https://share.example.com", "*.share.example.com", "localhost", "a b.com"]) {
      expect(() => normalizeSiteHostSuffix(bad), bad).toThrow(/bare domain/);
    }
  });
});
