import type { DatabaseSync } from "node:sqlite";
import { TIER_POLICIES } from "./tiers.js";

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
  return { generatedAt: new Date(now).toISOString(), accounts, sites, versions, keys, tiers, visibility, activity, recentSites };
}

export type OwnerStats = ReturnType<typeof getOwnerStats>;
