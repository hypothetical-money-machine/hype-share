import { describe, expect, it } from "vitest";
import { policyFor, resolveTierExpiry, TtlPolicyError } from "./tiers.js";

describe("resolveTierExpiry", () => {
  const now = 1_000_000_000_000;
  const week = 7 * 86_400_000;

  it("uses the free-- default of 7d", () => {
    const exp = resolveTierExpiry(policyFor("free--"), undefined, now, "create");
    expect(exp).toBe(now + week);
  });

  it("clamps a long ttl to the tier max", () => {
    const exp = resolveTierExpiry(policyFor("free--"), "90d", now, "create");
    expect(exp).toBe(now + 30 * 86_400_000);
  });

  it("rejects null ttl on free--", () => {
    expect(() => resolveTierExpiry(policyFor("free--"), null, now, "create")).toThrow(
      TtlPolicyError,
    );
  });

  it("allows null ttl on paid", () => {
    expect(resolveTierExpiry(policyFor("paid"), null, now, "create")).toBeNull();
    expect(resolveTierExpiry(policyFor("paid"), undefined, now, "create")).toBeNull();
  });
});
