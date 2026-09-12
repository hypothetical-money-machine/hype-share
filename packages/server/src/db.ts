import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Visibility } from "@shareplan/core";

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  created_at: number;
  revoked_at: number | null;
}

export interface SiteRow {
  id: string;
  owner_key_id: string;
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

  addColumn(db, "site_versions", "pruned_at", "INTEGER");

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sites_expires ON sites(expires_at)
       WHERE expires_at IS NOT NULL;`,
  );
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

export function createApiKeyRecord(
  db: DatabaseSync,
  opts: { name: string; token: string; now?: number },
): ApiKeyRow {
  const id = randomBytes(8).toString("hex");
  const created_at = opts.now ?? Date.now();
  const key_hash = hashApiKey(opts.token);
  db.prepare(
    `INSERT INTO api_keys (id, name, key_hash, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).run(id, opts.name, key_hash, created_at);
  return { id, name: opts.name, key_hash, created_at, revoked_at: null };
}

export function findApiKeyByToken(db: DatabaseSync, token: string): ApiKeyRow | null {
  const key_hash = hashApiKey(token);
  const row = db
    .prepare(
      `SELECT id, name, key_hash, created_at, revoked_at
       FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    )
    .get(key_hash) as ApiKeyRow | undefined;
  if (!row) return null;
  // Defense in depth: constant-time compare on hash strings
  const a = Buffer.from(row.key_hash, "utf8");
  const b = Buffer.from(key_hash, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row;
}

export function listApiKeys(db: DatabaseSync): ApiKeyRow[] {
  return db
    .prepare(
      `SELECT id, name, key_hash, created_at, revoked_at
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
      (id, owner_key_id, slug, title, visibility, current_version_id,
       created_at, updated_at, expires_at, byte_size, file_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    site.id,
    site.owner_key_id,
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
    .prepare(
      `SELECT id, owner_key_id, slug, title, visibility, current_version_id,
              created_at, updated_at, expires_at, byte_size, file_count
       FROM sites WHERE id = ?`,
    )
    .get(id) as SiteRow | undefined;
  return row ?? null;
}

/**
 * Case-insensitive: a slug is a hostname label under hostname serving, and a
 * mixed-case slug stored before slugs were forced lowercase must still resolve
 * from its lowercase hostname. Uniqueness checks go through here too.
 */
export function getSiteBySlug(db: DatabaseSync, slug: string): SiteRow | null {
  const row = db
    .prepare(
      `SELECT id, owner_key_id, slug, title, visibility, current_version_id,
              created_at, updated_at, expires_at, byte_size, file_count
       FROM sites WHERE slug = ? COLLATE NOCASE`,
    )
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
      `SELECT id, owner_key_id, slug, title, visibility, current_version_id,
              created_at, updated_at, expires_at, byte_size, file_count
       FROM sites WHERE expires_at IS NOT NULL AND expires_at <= ?`,
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

export function listSitesForKey(db: DatabaseSync, ownerKeyId: string): SiteRow[] {
  return db
    .prepare(
      `SELECT id, owner_key_id, slug, title, visibility, current_version_id,
              created_at, updated_at, expires_at, byte_size, file_count
       FROM sites WHERE owner_key_id = ? ORDER BY updated_at DESC`,
    )
    .all(ownerKeyId) as unknown as SiteRow[];
}

export function deleteSite(db: DatabaseSync, id: string): boolean {
  const result = db.prepare(`DELETE FROM sites WHERE id = ?`).run(id);
  return (result.changes ?? 0) > 0;
}

export function isExpired(site: SiteRow, now = Date.now()): boolean {
  return site.expires_at !== null && site.expires_at <= now;
}
