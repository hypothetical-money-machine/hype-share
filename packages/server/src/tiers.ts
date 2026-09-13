import { expiresAtFromTtl } from "@shareplan/core";

export type Tier = "ops" | "free--" | "free-" | "free" | "unlock" | "paid";

export interface TierPolicy {
  /** Applied when create omits ttl. Null means no expiry. */
  defaultTtl: string | null;
  /** Longest allowed lifetime. Null means no cap. */
  maxTtl: string | null;
  publishPerHour: number;
  slugs: boolean;
  publicVisibility: boolean;
  allowNullTtl: boolean;
  ipPublishLimit: boolean;
}

export const TIER_POLICIES: Record<Tier, TierPolicy> = {
  ops: {
    defaultTtl: null,
    maxTtl: null,
    publishPerHour: 1_000_000,
    slugs: true,
    publicVisibility: true,
    allowNullTtl: true,
    ipPublishLimit: false,
  },
  "free--": {
    defaultTtl: "7d",
    maxTtl: "30d",
    publishPerHour: 120,
    slugs: false,
    publicVisibility: false,
    allowNullTtl: false,
    ipPublishLimit: true,
  },
  "free-": {
    defaultTtl: "30d",
    maxTtl: "90d",
    publishPerHour: 300,
    slugs: true,
    publicVisibility: false,
    allowNullTtl: false,
    ipPublishLimit: false,
  },
  free: {
    defaultTtl: "90d",
    maxTtl: "1y",
    publishPerHour: 600,
    slugs: true,
    publicVisibility: true,
    allowNullTtl: false,
    ipPublishLimit: false,
  },
  unlock: {
    defaultTtl: "1y",
    maxTtl: "1y",
    publishPerHour: 1_200,
    slugs: true,
    publicVisibility: true,
    allowNullTtl: false,
    ipPublishLimit: false,
  },
  paid: {
    defaultTtl: null,
    maxTtl: null,
    publishPerHour: 3_600,
    slugs: true,
    publicVisibility: true,
    allowNullTtl: true,
    ipPublishLimit: false,
  },
};

export function isTier(value: string): value is Tier {
  return Object.hasOwn(TIER_POLICIES, value);
}

export class UnknownTierError extends Error {
  override readonly name = "UnknownTierError";
  constructor(readonly tier: string) {
    super(`unknown tier: ${tier}`);
  }
}

export function policyFor(tier: string): TierPolicy {
  if (!isTier(tier)) throw new UnknownTierError(tier);
  return TIER_POLICIES[tier];
}

export function expiresAtFromTierTtl(
  input: string | number | null | undefined,
  now: number,
): number | null {
  return expiresAtFromTtl(input, now);
}

/**
 * On update with no ttl field: keep the stored expiry if this tier still
 * allows it, otherwise clamp to max (or assign max when null is no longer
 * allowed).
 */
export function clampStoredExpiry(
  policy: TierPolicy,
  existing: number | null,
  now: number,
): number | null {
  if (existing === null) {
    if (policy.allowNullTtl) return null;
    return clampToMax(policy, expiresAtFromTierTtl(policy.maxTtl ?? policy.defaultTtl, now), now);
  }
  return clampToMax(policy, existing, now);
}

/**
 * Create: omitted ttl → default. Explicit value → clamp to max. Null → only
 * if the tier allows it.
 * Update: omitted ttl is handled by the caller (keep current).
 */
export function resolveTierExpiry(
  policy: TierPolicy,
  ttl: string | number | null | undefined,
  now: number,
  mode: "create" | "explicit",
): number | null {
  if (ttl === null) {
    if (!policy.allowNullTtl) {
      throw new TtlPolicyError("ttl_not_allowed", "this tier cannot disable expiry");
    }
    return null;
  }
  if (ttl === undefined) {
    if (mode === "explicit") {
      throw new TtlPolicyError("invalid_ttl", "ttl is required");
    }
    return clampToMax(policy, expiresAtFromTierTtl(policy.defaultTtl, now), now);
  }
  let expires: number | null;
  try {
    expires = expiresAtFromTierTtl(ttl, now);
  } catch (e) {
    throw new TtlPolicyError(
      "invalid_ttl",
      e instanceof Error ? e.message : "invalid ttl",
    );
  }
  if (expires === null) {
    if (!policy.allowNullTtl) {
      throw new TtlPolicyError("ttl_not_allowed", "this tier cannot disable expiry");
    }
    return null;
  }
  return clampToMax(policy, expires, now);
}

function clampToMax(
  policy: TierPolicy,
  expires: number | null,
  now: number,
): number | null {
  if (policy.maxTtl === null) return expires;
  const max = expiresAtFromTierTtl(policy.maxTtl, now);
  if (max === null) return expires;
  if (expires === null) return max;
  return Math.min(expires, max);
}

export class TtlPolicyError extends Error {
  override readonly name = "TtlPolicyError";
  constructor(
    readonly code: "ttl_not_allowed" | "invalid_ttl",
    message: string,
  ) {
    super(message);
  }
}
