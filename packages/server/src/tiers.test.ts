import { describe, expect, it } from "vitest";
import {
  clampStoredExpiry,
  effectiveTier,
  higherTier,
  isOrgTier,
  ORG_TIERS,
  orgTier,
  policyFor,
  resolveTierExpiry,
  TIER_RANK,
  tierForAuthenticationMethod,
  TtlPolicyError,
  type Tier,
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

describe("effectiveTier", () => {
  it("is the higher of own and org, never ops, never below own", () => {
    const cases: [Tier, Tier | null, Tier][] = [
      ["free--", "paid", "paid"],
      ["paid", "free", "paid"],
      ["free", null, "free"],
      ["ops", "paid", "ops"],
      ["ops", null, "ops"],
      ["free--", "ops", "free--"],
      ["free--", "gold" as Tier, "free--"],
    ];
    for (const [user, org, want] of cases) {
      expect(effectiveTier(user, org), `${user} + ${org}`).toBe(want);
    }
  });

  it("returns an unknown own tier as-is so policyFor still rejects it", () => {
    const got = effectiveTier("gold" as Tier, "paid");
    expect(got).toBe("gold");
    expect(() => policyFor(got)).toThrow(/unknown tier/);
  });
});

describe("orgTier", () => {
  it("is null without an org or without any tier column", () => {
    expect(orgTier(null)).toBeNull();
    expect(orgTier({ comp_tier: null, billing_tier: null })).toBeNull();
  });

  it("uses whichever column is set, or the higher of both", () => {
    expect(orgTier({ comp_tier: "free", billing_tier: null })).toBe("free");
    expect(orgTier({ comp_tier: null, billing_tier: "unlock" })).toBe("unlock");
    expect(orgTier({ comp_tier: "paid", billing_tier: "free-" })).toBe("paid");
    expect(orgTier({ comp_tier: "free-", billing_tier: "paid" })).toBe("paid");
  });

  it("ignores garbage and ops in either column", () => {
    expect(orgTier({ comp_tier: "gold", billing_tier: null })).toBeNull();
    expect(orgTier({ comp_tier: "gold", billing_tier: "free" })).toBe("free");
    expect(orgTier({ comp_tier: "ops", billing_tier: null })).toBeNull();
    expect(orgTier({ comp_tier: "ops", billing_tier: "unlock" })).toBe("unlock");
    expect(orgTier({ comp_tier: "free", billing_tier: "ops" })).toBe("free");
  });
});

describe("isOrgTier and TIER_RANK", () => {
  it("rejects ops and unknown strings", () => {
    expect(isOrgTier("ops")).toBe(false);
    expect(isOrgTier("gold")).toBe(false);
    for (const t of ORG_TIERS) expect(isOrgTier(t), t).toBe(true);
  });

  it("ranks org tiers strictly increasing, all below ops", () => {
    for (let i = 1; i < ORG_TIERS.length; i += 1) {
      expect(TIER_RANK[ORG_TIERS[i]!]).toBeGreaterThan(TIER_RANK[ORG_TIERS[i - 1]!]);
    }
    expect(TIER_RANK.ops).toBeGreaterThan(TIER_RANK[ORG_TIERS[ORG_TIERS.length - 1]!]);
  });
});
