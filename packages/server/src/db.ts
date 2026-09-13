import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Visibility } from "@shareplan/core";
import type { Tier } from "./tiers.js";

export interface UserRow {
  id: string;
  tier: Tier;
  email: string | null;
  workos_user_id: string | null;
  stripe_customer_id: string | null;
  claim_token_hash: string | null;
  created_at: number;
  claimed_at: number | null;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  created_at: number;
  revoked_at: number | null;
}

export interface SiteRow {
  id: string;
  owner_key_id: string;
  owner_user_id: string;
  slug: string | null;
  title: string | null;
  visibility: Visibility;
  current_version_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  byte_size: number;
  file_count: number;
}

export interface VersionRow {
  id: string;
  site_id: string;
  created_at: number;
  byte_size: number;
  file_count: number;
  note: string | null;
  /** Set once this version's objects have been removed from S3. */
  pruned_at?: number | null;
}

const SITE_COLS = `id, owner_key_id, owner_user_id, slug, title, visibility, current_version_id,
       created_at, updated_at, expires_at, byte_size, file_count`;

const USER_COLS = `id, tier, email, workos_user_id, stripe_customer_id, claim_token_hash,
       created_at, claimed_at`;

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/**
 * Slugs are matched case-insensitively, but the original UNIQUE column is
 * case-sensitive, so a database from before that rule may hold both "MyPlan"
 * and "myplan" on different sites. The oldest site keeps its slug; the rest
 * lose theirs (the site itself, and its id URL, are untouched). Runs once,
 * before the case-insensitive unique index is created. Returns what it
 * cleared so the caller can log it.
 */
export function resolveCaseFoldedSlugs(db: DatabaseSync): { id: string; slug: string }[] {
  const losers = db
    .prepare(
      `SELECT s.id, s.slug
       FROM sites s
       WHERE s.slug IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM sites o
           WHERE o.slug = s.slug COLLATE NOCASE
             AND o.id <> s.id
             AND (o.created_at < s.created_at OR (o.created_at = s.created_at AND o.id < s.id))
         )
       ORDER BY s.created_at, s.id`,
    )
    .all() as { id: string; slug: string }[];
  const clear = db.prepare(`UPDATE sites SET slug = NULL WHERE id = ?`);
  for (const row of losers) clear.run(row.id);
  return losers;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      owner_key_id TEXT NOT NULL REFERENCES api_keys(id),
      slug TEXT UNIQUE,
      title TEXT,
      visibility TEXT NOT NULL DEFAULT 'unlisted',
      current_version_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      byte_size INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS site_versions (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites(owner_key_id);
    CREATE INDEX IF NOT EXISTS idx_versions_site ON site_versions(site_id);
  `);
  upgrade(db);
}

/**
 * Versioned steps for databases created by an earlier schema. PRAGMA
 * user_version records the last step applied, so each runs once.
 */
export function upgrade(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (version < 1) {
    // Slugs are hostname labels now, so they are unique case-insensitively.
    // Settle any pre-existing case-folded duplicates, then let the index
    // enforce the rule (and serve the case-insensitive lookup).
    const cleared = resolveCaseFoldedSlugs(db);
    if (cleared.length > 0) {
      console.warn(
        `cleared ${cleared.length} slug(s) that differed from another only by case: ` +
          cleared.map((c) => `${c.slug} (site ${c.id})`).join(", "),
      );
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_slug_nocase ON sites(slug COLLATE NOCASE);
      PRAGMA user_version = 1;
    `);
  }

  addColumn(db, "site_versions", "pruned_at", "INTEGER");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      email TEXT,
      workos_user_id TEXT UNIQUE,
      stripe_customer_id TEXT,
      claim_token_hash TEXT,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
      ON users(email) WHERE email IS NOT NULL;

    CREATE TABLE IF NOT EXISTS rate_limits (
      bucket TEXT NOT NULL,
      action TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (bucket, action, window_start)
    );
  `);

  addColumn(db, "api_keys", "user_id", "TEXT REFERENCES users(id)");
  addColumn(db, "sites", "owner_user_id", "TEXT REFERENCES users(id)");
  backfillOpsUsers(db);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sites_expires ON sites(expires_at)
       WHERE expires_at IS NOT NULL;
     CREATE INDEX IF NOT EXISTS idx_sites_owner_user ON sites(owner_user_id);
     CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);`,
  );
}

/** Existing keys become operator users so self-host and Zima keep working. */
function backfillOpsUsers(db: DatabaseSync): void {
  const orphanKeys = db
    .prepare(
      `SELECT id, name, key_hash, created_at, revoked_at
       FROM api_keys WHERE user_id IS NULL`,
    )
    .all() as {
    id: string;
    name: string;
    key_hash: string;
    created_at: number;
    revoked_at: number | null;
  }[];
  const insertUser = db.prepare(
    `INSERT INTO users (id, tier, email, workos_user_id, stripe_customer_id,
       claim_token_hash, created_at, claimed_at)
     VALUES (?, 'ops', NULL, NULL, NULL, NULL, ?, NULL)`,
  );
  const setKeyUser = db.prepare(`UPDATE api_keys SET user_id = ? WHERE id = ?`);
  for (const key of orphanKeys) {
    const userId = randomBytes(8).toString("hex");
    insertUser.run(userId, key.created_at);
    setKeyUser.run(userId, key.id);
  }

  db.prepare(
    `UPDATE sites SET owner_user_id = (
       SELECT user_id FROM api_keys WHERE api_keys.id = sites.owner_key_id
     )
     WHERE owner_user_id IS NULL`,
  ).run();
}

/** ALTER TABLE ADD COLUMN is not idempotent in SQLite, so check first. */
function addColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
    name: string;
  }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

export function createUser(
  db: DatabaseSync,
  opts: { tier: Tier; claimToken?: string; now?: number },
): UserRow {
  const id = newId();
  const created_at = opts.now ?? Date.now();
  const claim_token_hash = opts.claimToken ? hashApiKey(opts.claimToken) : null;
  db.prepare(
    `INSERT INTO users (id, tier, email, workos_user_id, stripe_customer_id,
       claim_token_hash, created_at, claimed_at)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(id, opts.tier, claim_token_hash, created_at);
  return {
    id,
    tier: opts.tier,
    email: null,
    workos_user_id: null,
    stripe_customer_id: null,
    claim_token_hash,
    created_at,
    claimed_at: null,
  };
}

export function getUser(db: DatabaseSync, id: string): UserRow | null {
  const row = db
    .prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`)
    .get(id) as UserRow | undefined;
  return row ?? null;
}

export function setUserTier(db: DatabaseSync, id: string, tier: Tier): void {
  db.prepare(`UPDATE users SET tier = ? WHERE id = ?`).run(tier, id);
}

export function createApiKeyRecord(
  db: DatabaseSync,
  opts: { name: string; token: string; userId: string; now?: number },
): ApiKeyRow {
  const id = newId();
  const created_at = opts.now ?? Date.now();
  const key_hash = hashApiKey(opts.token);
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_hash, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, opts.userId, opts.name, key_hash, created_at);
  return {
    id,
    user_id: opts.userId,
    name: opts.name,
    key_hash,
    created_at,
    revoked_at: null,
  };
}

/** Test and admin helper: one operator user plus a key. */
export function createOpsKey(
  db: DatabaseSync,
  opts: { name: string; token: string; now?: number },
): { user: UserRow; key: ApiKeyRow } {
  const user = createUser(db, { tier: "ops", now: opts.now });
  const key = createApiKeyRecord(db, { ...opts, userId: user.id });
  return { user, key };
}

export function findApiKeyByToken(db: DatabaseSync, token: string): ApiKeyRow | null {
  const key_hash = hashApiKey(token);
  const row = db
    .prepare(
      `SELECT id, user_id, name, key_hash, created_at, revoked_at
       FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    )
    .get(key_hash) as ApiKeyRow | undefined;
  if (!row) return null;
  const a = Buffer.from(row.key_hash, "utf8");
  const b = Buffer.from(key_hash, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row;
}

export function listApiKeys(db: DatabaseSync): ApiKeyRow[] {
  return db
    .prepare(
      `SELECT id, user_id, name, key_hash, created_at, revoked_at
       FROM api_keys ORDER BY created_at DESC`,
    )
    .all() as unknown as ApiKeyRow[];
}

/** Revoke a key by id. Returns false if it was unknown or already revoked. */
export function revokeApiKey(
  db: DatabaseSync,
  id: string,
  now = Date.now(),
): boolean {
  const result = db
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(now, id);
  return (result.changes ?? 0) > 0;
}

export function insertSite(
  db: DatabaseSync,
  site: Omit<SiteRow, "byte_size" | "file_count"> & { byte_size?: number; file_count?: number },
): void {
  db.prepare(
    `INSERT INTO sites
      (id, owner_key_id, owner_user_id, slug, title, visibility, current_version_id,
       created_at, updated_at, expires_at, byte_size, file_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    site.id,
    site.owner_key_id,
    site.owner_user_id,
    site.slug,
    site.title,
    site.visibility,
    site.current_version_id,
    site.created_at,
    site.updated_at,
    site.expires_at,
    site.byte_size ?? 0,
    site.file_count ?? 0,
  );
}

export function updateSiteVersion(
  db: DatabaseSync,
  siteId: string,
  fields: {
    current_version_id: string;
    updated_at: number;
    expires_at: number | null;
    byte_size: number;
    file_count: number;
    title?: string | null;
    visibility?: Visibility;
  },
): void {
  db.prepare(
    `UPDATE sites SET
      current_version_id = ?,
      updated_at = ?,
      expires_at = ?,
      byte_size = ?,
      file_count = ?,
      title = COALESCE(?, title),
      visibility = COALESCE(?, visibility)
     WHERE id = ?`,
  ).run(
    fields.current_version_id,
    fields.updated_at,
    fields.expires_at,
    fields.byte_size,
    fields.file_count,
    fields.title ?? null,
    fields.visibility ?? null,
    siteId,
  );
}

export function updateSiteExpiry(
  db: DatabaseSync,
  siteId: string,
  expiresAt: number | null,
  updatedAt: number,
): void {
  db.prepare(`UPDATE sites SET expires_at = ?, updated_at = ? WHERE id = ?`).run(
    expiresAt,
    updatedAt,
    siteId,
  );
}

export function insertVersion(db: DatabaseSync, version: VersionRow): void {
  db.prepare(
    `INSERT INTO site_versions (id, site_id, created_at, byte_size, file_count, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    version.id,
    version.site_id,
    version.created_at,
    version.byte_size,
    version.file_count,
    version.note,
  );
}

export function getSite(db: DatabaseSync, id: string): SiteRow | null {
  const row = db
    .prepare(`SELECT ${SITE_COLS} FROM sites WHERE id = ?`)
    .get(id) as SiteRow | undefined;
  return row ?? null;
}

/**
 * Case-insensitive, served by idx_sites_slug_nocase: a slug is a hostname
 * label, and a mixed-case slug stored before slugs were forced lowercase must
 * still resolve from its lowercase hostname. The index is unique, so there is
 * at most one match. Uniqueness checks go through here too.
 */
export function getSiteBySlug(db: DatabaseSync, slug: string): SiteRow | null {
  const row = db
    .prepare(`SELECT ${SITE_COLS} FROM sites WHERE slug = ? COLLATE NOCASE`)
    .get(slug) as SiteRow | undefined;
  return row ?? null;
}

/** Look up by site id first, then by vanity slug. */
export function getSiteByIdOrSlug(db: DatabaseSync, value: string): SiteRow | null {
  return getSite(db, value) ?? getSiteBySlug(db, value);
}

export function updateSiteSlug(
  db: DatabaseSync,
  siteId: string,
  slug: string | null,
): void {
  db.prepare(`UPDATE sites SET slug = ? WHERE id = ?`).run(slug, siteId);
}

export function listExpiredSites(db: DatabaseSync, now = Date.now()): SiteRow[] {
  return db
    .prepare(
      `SELECT ${SITE_COLS} FROM sites WHERE expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .all(now) as unknown as SiteRow[];
}

/**
 * Versions whose objects can be dropped: everything older than the newest
 * `keep` versions that has not been pruned already.
 *
 * Ordered by rowid rather than created_at because two publishes can land in
 * the same millisecond, and the site's live version is excluded outright so a
 * tie can never take out the version currently being served.
 */
export function listPrunableVersions(
  db: DatabaseSync,
  siteId: string,
  keep: number,
): VersionRow[] {
  return db
    .prepare(
      `SELECT id, site_id, created_at, byte_size, file_count, note, pruned_at
       FROM site_versions
       WHERE site_id = ?
         AND pruned_at IS NULL
         AND id IS NOT (SELECT current_version_id FROM sites WHERE id = ?)
         AND rowid NOT IN (
           SELECT rowid FROM site_versions
           WHERE site_id = ? AND pruned_at IS NULL
           ORDER BY rowid DESC LIMIT ?
         )
       ORDER BY rowid DESC`,
    )
    .all(siteId, siteId, siteId, keep) as unknown as VersionRow[];
}

export function markVersionPruned(
  db: DatabaseSync,
  versionId: string,
  now = Date.now(),
): void {
  db.prepare(`UPDATE site_versions SET pruned_at = ? WHERE id = ?`).run(now, versionId);
}

export function listSitesForUser(db: DatabaseSync, ownerUserId: string): SiteRow[] {
  return db
    .prepare(
      `SELECT ${SITE_COLS} FROM sites WHERE owner_user_id = ? ORDER BY updated_at DESC`,
    )
    .all(ownerUserId) as unknown as SiteRow[];
}

export function deleteSite(db: DatabaseSync, id: string): boolean {
  const result = db.prepare(`DELETE FROM sites WHERE id = ?`).run(id);
  return (result.changes ?? 0) > 0;
}

export function isExpired(site: SiteRow, now = Date.now()): boolean {
  return site.expires_at !== null && site.expires_at <= now;
}
