import { describe, expect, it } from "vitest";
import {
  clampStoredExpiry,
  higherTier,
  policyFor,
  resolveTierExpiry,
  tierForAuthenticationMethod,
  TtlPolicyError,
} from "./tiers.js";

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

describe("policyFor", () => {
  it("rejects unknown tiers", () => {
    expect(() => policyFor("gold")).toThrow(/unknown tier/);
  });
});

describe("higherTier", () => {
  it("raises email accounts after social login", () => {
    expect(higherTier("free-", "free")).toBe("free");
  });

  it("does not lower paid or operator accounts", () => {
    expect(higherTier("paid", "free")).toBe("paid");
    expect(higherTier("ops", "free")).toBe("ops");
  });
});

describe("tierForAuthenticationMethod", () => {
  it("maps email codes below approved social logins", () => {
    expect(tierForAuthenticationMethod("MagicAuth")).toBe("free-");
    expect(tierForAuthenticationMethod("GitHubOAuth")).toBe("free");
    expect(tierForAuthenticationMethod("GoogleOAuth")).toBe("free");
  });

  it("rejects login methods outside the account policy", () => {
    expect(tierForAuthenticationMethod("Password")).toBeNull();
    expect(tierForAuthenticationMethod(undefined)).toBeNull();
  });
});

describe("clampStoredExpiry", () => {
  const now = 1_000_000_000_000;

  it("assigns a max ttl when a permanent site is downgraded", () => {
    const exp = clampStoredExpiry(policyFor("free--"), null, now);
    expect(exp).toBe(now + 30 * 86_400_000);
  });

  it("keeps a paid site's explicit expiry", () => {
    const existing = now + 86_400_000;
    expect(clampStoredExpiry(policyFor("paid"), existing, now)).toBe(existing);
  });
});
