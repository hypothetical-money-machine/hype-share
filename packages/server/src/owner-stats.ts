import type { DatabaseSync } from "node:sqlite";
import { TIER_POLICIES, effectiveTier, orgTier, type Tier } from "./tiers.js";

const DAY = 86_400_000;

/** Counts reflect surviving metadata, not a lifetime event ledger or an S3 inventory. */
export function getOwnerStats(db: DatabaseSync, now = Date.now()) {
  const since = Math.floor(now / DAY) * DAY - 29 * DAY;
  const accounts = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(tier != 'ops'), 0) AS customers,
    COALESCE(SUM(tier != 'ops' AND claimed_at IS NOT NULL), 0) AS claimed,
    COALESCE(SUM(created_at >= ?), 0) AS newLast30Days
    FROM users`).get(since) as { total: number; customers: number; claimed: number; newLast30Days: number };
  const sites = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(expires_at IS NULL OR expires_at > ?), 0) AS active,
    COALESCE(SUM(expires_at <= ?), 0) AS expired,
    COALESCE(SUM(expires_at > ? AND expires_at <= ?), 0) AS expiringNext7Days,
    COALESCE(SUM(expires_at IS NULL), 0) AS permanent,
    COALESCE(SUM(byte_size), 0) AS currentBytes,
    COALESCE(SUM(file_count), 0) AS currentFiles
    FROM sites`).get(now, now, now, now + 7 * DAY) as {
      total: number; active: number; expired: number; expiringNext7Days: number;
      permanent: number; currentBytes: number; currentFiles: number;
    };
  const versions = db.prepare(`SELECT COUNT(*) AS publishes,
    COALESCE(SUM(pruned_at IS NULL), 0) AS retained,
    COALESCE(SUM(CASE WHEN pruned_at IS NULL THEN byte_size ELSE 0 END), 0) AS retainedBytes
    FROM site_versions`).get() as { publishes: number; retained: number; retainedBytes: number };
  const keys = db.prepare(`SELECT COUNT(*) AS active FROM api_keys WHERE revoked_at IS NULL`).get() as { active: number };
  const tierRows = db.prepare(`SELECT tier, COUNT(*) AS count FROM users GROUP BY tier`).all() as { tier: string; count: number }[];
  const tiers = Object.keys(TIER_POLICIES).map(tier => ({ tier, count: tierRows.find(row => row.tier === tier)?.count ?? 0 }));
  const visibility = db.prepare(`SELECT visibility, COUNT(*) AS count FROM sites GROUP BY visibility`).all() as { visibility: string; count: number }[];
  const activityRows = db.prepare(`SELECT CAST(created_at / ? AS INTEGER) * ? AS day, COUNT(*) AS publishes
    FROM site_versions WHERE created_at >= ? GROUP BY day`).all(DAY, DAY, since) as { day: number; publishes: number }[];
  const activity = Array.from({ length: 30 }, (_, i) => {
    const day = since + i * DAY;
    return { date: new Date(day).toISOString().slice(0, 10), publishes: activityRows.find(row => row.day === day)?.publishes ?? 0 };
  });
  const recentSites = db.prepare(`SELECT id, title, visibility, byte_size AS byteSize,
    updated_at AS updatedAt, expires_at AS expiresAt FROM sites ORDER BY updated_at DESC, id LIMIT 20`).all() as {
      id: string; title: string | null; visibility: string; byteSize: number; updatedAt: number; expiresAt: number | null;
    }[];
  // Org output never carries join_token_hash or member emails; the tier chart above stays own tiers only.
  const orgTotals = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(join_token_hash IS NOT NULL), 0) AS joinEnabled FROM orgs`).get() as { total: number; joinEnabled: number };
  const orgMembers = db.prepare(`SELECT u.tier, o.comp_tier, o.billing_tier FROM users u
    JOIN orgs o ON o.id = u.org_id WHERE u.tier <> 'ops'`).all() as { tier: Tier; comp_tier: string | null; billing_tier: string | null }[];
  // Resolved in JS so an unknown own tier counts as not elevated rather than failing the whole page.
  const elevated = orgMembers.filter(m => effectiveTier(m.tier, orgTier(m)) !== m.tier).length;
  const orgRows = db.prepare(`SELECT o.id, o.name, o.comp_tier AS compTier, o.billing_tier AS billingTier,
    o.max_members AS maxMembers, o.publish_per_hour AS publishPerHour, o.join_token_hash IS NOT NULL AS joinEnabled,
    o.created_at AS createdAt,
    (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS members,
    (SELECT COUNT(*) FROM sites s JOIN users u ON u.id = s.owner_user_id WHERE u.org_id = o.id) AS sites,
    (SELECT COUNT(*) FROM sites s JOIN users u ON u.id = s.owner_user_id WHERE u.org_id = o.id AND s.expires_at IS NULL) AS permanent
    FROM orgs o ORDER BY members DESC, o.created_at, o.id LIMIT 20`).all() as {
      id: string; name: string; compTier: string | null; billingTier: string | null; maxMembers: number;
      publishPerHour: number | null; joinEnabled: number; createdAt: number; members: number; sites: number; permanent: number;
    }[];
  const orgList = orgRows.map(o => ({ ...o, tier: orgTier({ comp_tier: o.compTier, billing_tier: o.billingTier }) }));
  return {
    generatedAt: new Date(now).toISOString(),
    accounts: { ...accounts, inOrg: orgMembers.length },
    sites, versions, keys, tiers, visibility, activity, recentSites,
    orgs: { ...orgTotals, members: orgMembers.length, elevated },
    orgList,
  };
}

export type OwnerStats = ReturnType<typeof getOwnerStats>;
