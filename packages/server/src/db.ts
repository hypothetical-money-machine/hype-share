import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { RESERVED_HOST_LABELS, type Visibility } from "@shareplan/core";
import { RATE_LIMIT_WINDOWS, type RateLimitAction } from "./rate-limit.js";
import { HttpError } from "./errors.js";
import {
  clampStoredExpiry,
  effectiveTier,
  expiresAtFromTierTtl,
  higherTier,
  orgTier,
  policyFor,
  TIER_POLICIES,
  type OrgRole,
  type OrgTier,
  type Tier,
  type TierPolicy,
  UnknownTierError,
} from "./tiers.js";

export interface UserRow {
  id: string;
  tier: Tier;
  email: string | null;
  workos_user_id: string | null;
  stripe_customer_id: string | null;
  claim_token_hash: string | null;
  created_at: number;
  claimed_at: number | null;
  org_id: string | null;
  org_role: OrgRole | null;
}

export interface OrgRow {
  id: string;
  name: string;
  comp_tier: string | null;
  billing_tier: string | null;
  stripe_customer_id: string | null;
  join_token_hash: string | null;
  max_members: number;
  publish_per_hour: number | null;
  created_at: number;
  updated_at: number;
}

export interface OrgMemberRow {
  id: string;
  tier: Tier;
  org_role: OrgRole;
  email: string | null;
  created_at: number;
  claimed_at: number | null;
  sites: number;
  keys: { id: string; name: string; created_at: number }[];
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  created_at: number;
  revoked_at: number | null;
}

export interface ClaimAuthFlowRow {
  state_hash: string;
  browser_nonce_hash: string;
  user_id: string;
  code_verifier: string;
  created_at: number;
  expires_at: number;
}

export class ClaimStateError extends Error {
  override readonly name = "ClaimStateError";
}

export class ClaimIdentityConflictError extends Error {
  override readonly name = "ClaimIdentityConflictError";
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
       created_at, claimed_at, org_id, org_role`;

const ORG_COLS = `id, name, comp_tier, billing_tier, stripe_customer_id, join_token_hash,
       max_members, publish_per_hour, created_at, updated_at`;

/** SITE_COLS qualified for queries that join sites with users. */
const ORG_SITE_COLS = SITE_COLS.split(",")
  .map((col) => `s.${col.trim()}`)
  .join(", ");

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

function clearReservedSlugs(db: DatabaseSync): void {
  const clear = db.prepare(`UPDATE sites SET slug = NULL WHERE slug = ? COLLATE NOCASE`);
  for (const label of RESERVED_HOST_LABELS) clear.run(label);
}

export function pruneRateLimits(db: DatabaseSync, now = Date.now()): number {
  const remove = db.prepare(
    `DELETE FROM rate_limits WHERE action = ? AND window_start < ?`,
  );
  let removed = 0;
  for (const [action, windowMs] of Object.entries(RATE_LIMIT_WINDOWS) as [
    RateLimitAction,
    number,
  ][]) {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const result = remove.run(action, windowStart);
    removed += Number(result.changes ?? 0);
  }
  return removed;
}

export function pruneClaimAuthFlows(db: DatabaseSync, now = Date.now()): number {
  const result = db
    .prepare(`DELETE FROM claim_auth_flows WHERE expires_at <= ?`)
    .run(now);
  return Number(result.changes ?? 0);
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
  let version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
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
    version = 1;
  }
  if (version < 2) {
    clearReservedSlugs(db);
    db.exec("PRAGMA user_version = 2;");
    version = 2;
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
    CREATE TABLE IF NOT EXISTS rate_limits (
      bucket TEXT NOT NULL,
      action TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (bucket, action, window_start)
    );

    CREATE TABLE IF NOT EXISTS claim_auth_flows (
      state_hash TEXT PRIMARY KEY,
      browser_nonce_hash TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_verifier TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claim_auth_flows_expires
      ON claim_auth_flows(expires_at);

    CREATE TABLE IF NOT EXISTS owner_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  addColumn(db, "claim_auth_flows", "browser_nonce_hash", "TEXT");

  addColumn(db, "api_keys", "user_id", "TEXT REFERENCES users(id)");
  addColumn(db, "sites", "owner_user_id", "TEXT REFERENCES users(id)");
  backfillOpsUsers(db);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sites_expires ON sites(expires_at)
       WHERE expires_at IS NOT NULL;
     CREATE INDEX IF NOT EXISTS idx_sites_owner_user ON sites(owner_user_id);
     CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);`,
  );
  if (version < 3) {
    db.exec(`
      DROP INDEX IF EXISTS idx_users_email;
      CREATE UNIQUE INDEX idx_users_email
        ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
      PRAGMA user_version = 3;
    `);
  }

  // orgs must exist before users.org_id references it: with foreign_keys ON the
  // ALTER succeeds either way, but every later UPDATE users would fail.
  db.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      comp_tier TEXT CHECK (comp_tier IS NULL OR comp_tier <> 'ops'),
      billing_tier TEXT CHECK (billing_tier IS NULL OR billing_tier <> 'ops'),
      stripe_customer_id TEXT,
      join_token_hash TEXT,
      max_members INTEGER NOT NULL DEFAULT 100,
      publish_per_hour INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_join_token
      ON orgs(join_token_hash) WHERE join_token_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_stripe_customer
      ON orgs(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
  `);
  addColumn(db, "users", "org_id", "TEXT REFERENCES orgs(id)");
  addColumn(db, "users", "org_role", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id) WHERE org_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sites_permanent ON sites(owner_user_id) WHERE expires_at IS NULL;
  `);
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
  opts: {
    tier: Tier;
    claimToken?: string;
    now?: number;
    orgId?: string | null;
    orgRole?: OrgRole | null;
  },
): UserRow {
  const id = newId();
  const created_at = opts.now ?? Date.now();
  const claim_token_hash = opts.claimToken ? hashApiKey(opts.claimToken) : null;
  const org_id = opts.orgId ?? null;
  const org_role = org_id === null ? null : (opts.orgRole ?? "member");
  db.prepare(
    `INSERT INTO users (id, tier, email, workos_user_id, stripe_customer_id,
       claim_token_hash, created_at, claimed_at, org_id, org_role)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?)`,
  ).run(id, opts.tier, claim_token_hash, created_at, org_id, org_role);
  return {
    id,
    tier: opts.tier,
    email: null,
    workos_user_id: null,
    stripe_customer_id: null,
    claim_token_hash,
    created_at,
    claimed_at: null,
    org_id,
    org_role,
  };
}

export function getUser(db: DatabaseSync, id: string): UserRow | null {
  const row = db
    .prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`)
    .get(id) as UserRow | undefined;
  return row ?? null;
}

export function findUserByClaimToken(db: DatabaseSync, token: string): UserRow | null {
  const claimTokenHash = hashApiKey(token);
  const row = db
    .prepare(
      `SELECT ${USER_COLS} FROM users
       WHERE claim_token_hash = ? AND claimed_at IS NULL`,
    )
    .get(claimTokenHash) as UserRow | undefined;
  return row ?? null;
}

export function createClaimAuthFlow(
  db: DatabaseSync,
  opts: {
    state: string;
    browserNonce: string;
    userId: string;
    codeVerifier: string;
    now?: number;
    ttlMs?: number;
  },
): void {
  const createdAt = opts.now ?? Date.now();
  const expiresAt = createdAt + (opts.ttlMs ?? 10 * 60_000);
  db.exec("BEGIN IMMEDIATE");
  try {
    pruneClaimAuthFlows(db, createdAt);
    db.prepare(`DELETE FROM claim_auth_flows WHERE user_id = ?`).run(opts.userId);
    db.prepare(
      `INSERT INTO claim_auth_flows
         (state_hash, browser_nonce_hash, user_id, code_verifier, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      hashApiKey(opts.state),
      hashApiKey(opts.browserNonce),
      opts.userId,
      opts.codeVerifier,
      createdAt,
      expiresAt,
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed / no transaction
    }
    throw err;
  }
}

export function getClaimAuthFlow(
  db: DatabaseSync,
  state: string,
  browserNonce: string,
  now = Date.now(),
): ClaimAuthFlowRow | null {
  const row = db
    .prepare(
      `SELECT state_hash, browser_nonce_hash, user_id, code_verifier, created_at, expires_at
       FROM claim_auth_flows
       WHERE state_hash = ? AND browser_nonce_hash = ? AND expires_at > ?`,
    )
    .get(hashApiKey(state), hashApiKey(browserNonce), now) as ClaimAuthFlowRow | undefined;
  return row ?? null;
}

export function deleteClaimAuthFlow(
  db: DatabaseSync,
  state: string,
  browserNonce: string,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM claim_auth_flows
       WHERE state_hash = ? AND browser_nonce_hash = ?`,
    )
    .run(hashApiKey(state), hashApiKey(browserNonce));
  return Number(result.changes ?? 0) > 0;
}

export function completeClaim(
  db: DatabaseSync,
  opts: {
    state: string;
    browserNonce: string;
    workosUserId: string;
    email: string;
    authenticatedTier: "free-" | "free";
    now?: number;
  },
): UserRow {
  const now = opts.now ?? Date.now();
  const stateHash = hashApiKey(opts.state);
  const browserNonceHash = hashApiKey(opts.browserNonce);
  const email = opts.email.trim().toLowerCase();
  let updated: UserRow;
  db.exec("BEGIN IMMEDIATE");
  try {
    const flow = db
      .prepare(
        `SELECT state_hash, browser_nonce_hash, user_id, code_verifier, created_at, expires_at
         FROM claim_auth_flows
         WHERE state_hash = ? AND browser_nonce_hash = ? AND expires_at > ?`,
      )
      .get(stateHash, browserNonceHash, now) as ClaimAuthFlowRow | undefined;
    if (!flow) throw new ClaimStateError("claim flow is missing or expired");

    const target = getUser(db, flow.user_id);
    if (!target || target.claimed_at !== null || target.claim_token_hash === null) {
      throw new ClaimStateError("claim link has already been used");
    }

    const conflict = db
      .prepare(
        `SELECT id FROM users
         WHERE id <> ?
           AND (workos_user_id = ? OR email = ? COLLATE NOCASE)
         LIMIT 1`,
      )
      .get(target.id, opts.workosUserId, email) as { id: string } | undefined;
    if (conflict) {
      throw new ClaimIdentityConflictError("this login belongs to another account");
    }

    const tier = higherTier(target.tier, opts.authenticatedTier);
    const changed = db
      .prepare(
        `UPDATE users
         SET tier = ?, email = ?, workos_user_id = ?,
             claim_token_hash = NULL, claimed_at = ?
         WHERE id = ? AND claim_token_hash IS NOT NULL AND claimed_at IS NULL`,
      )
      .run(tier, email, opts.workosUserId, now, target.id);
    if ((changed.changes ?? 0) !== 1) {
      throw new ClaimStateError("claim link has already been used");
    }
    updated = {
      ...target,
      tier,
      email,
      workos_user_id: opts.workosUserId,
      claim_token_hash: null,
      claimed_at: now,
    };
    db.prepare(`DELETE FROM claim_auth_flows WHERE user_id = ?`).run(target.id);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed / no transaction
    }
    if (
      err instanceof ClaimStateError ||
      err instanceof ClaimIdentityConflictError
    ) {
      throw err;
    }
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new ClaimIdentityConflictError("this login belongs to another account");
    }
    throw err;
  }
  return updated;
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
  return row ?? null;
}

export function listApiKeys(db: DatabaseSync): (ApiKeyRow & { org_id: string | null })[] {
  return db
    .prepare(
      `SELECT k.id, k.user_id, k.name, k.key_hash, k.created_at, k.revoked_at, u.org_id
       FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
       ORDER BY k.created_at DESC`,
    )
    .all() as unknown as (ApiKeyRow & { org_id: string | null })[];
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

/**
 * BEGIN IMMEDIATE / COMMIT / ROLLBACK around fn. Never nest: consumeRate opens
 * its own, so routes spend their buckets before calling anything that uses this.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already closed / no transaction
    }
    throw err;
  }
}

export function createOrg(
  db: DatabaseSync,
  opts: {
    name: string;
    compTier: OrgTier | null;
    maxMembers?: number;
    publishPerHour?: number | null;
    joinToken: string;
    now?: number;
  },
): OrgRow {
  const now = opts.now ?? Date.now();
  const row: OrgRow = {
    id: newId(),
    name: opts.name,
    comp_tier: opts.compTier,
    billing_tier: null,
    stripe_customer_id: null,
    join_token_hash: hashApiKey(opts.joinToken),
    max_members: opts.maxMembers ?? 100,
    publish_per_hour: opts.publishPerHour ?? null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO orgs (${ORG_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.comp_tier,
    row.billing_tier,
    row.stripe_customer_id,
    row.join_token_hash,
    row.max_members,
    row.publish_per_hour,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function getOrg(db: DatabaseSync, id: string): OrgRow | null {
  const row = db
    .prepare(`SELECT ${ORG_COLS} FROM orgs WHERE id = ?`)
    .get(id) as OrgRow | undefined;
  return row ?? null;
}

/** A disabled org has a NULL hash, which never equals the presented one. */
export function findOrgByJoinToken(db: DatabaseSync, token: string): OrgRow | null {
  const row = db
    .prepare(`SELECT ${ORG_COLS} FROM orgs WHERE join_token_hash = ?`)
    .get(hashApiKey(token)) as OrgRow | undefined;
  return row ?? null;
}

export function listOrgs(db: DatabaseSync): OrgRow[] {
  return db
    .prepare(`SELECT ${ORG_COLS} FROM orgs ORDER BY created_at, id`)
    .all() as unknown as OrgRow[];
}

export function countOrgMembers(db: DatabaseSync, orgId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE org_id = ?`)
    .get(orgId) as { n: number };
  return Number(row.n);
}

export function listOrgMembers(db: DatabaseSync, orgId: string): OrgMemberRow[] {
  const members = db
    .prepare(
      `SELECT u.id, u.tier, u.org_role, u.email, u.created_at, u.claimed_at,
              (SELECT COUNT(*) FROM sites s WHERE s.owner_user_id = u.id) AS sites
       FROM users u WHERE u.org_id = ? ORDER BY u.created_at, u.id`,
    )
    .all(orgId) as unknown as Omit<OrgMemberRow, "keys">[];
  if (members.length === 0) return [];
  const keys = db
    .prepare(
      `SELECT k.id, k.user_id, k.name, k.created_at
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE u.org_id = ? AND k.revoked_at IS NULL
       ORDER BY k.created_at, k.id`,
    )
    .all(orgId) as unknown as { id: string; user_id: string; name: string; created_at: number }[];
  const byUser = new Map<string, OrgMemberRow["keys"]>();
  for (const k of keys) {
    const list = byUser.get(k.user_id) ?? [];
    list.push({ id: k.id, name: k.name, created_at: k.created_at });
    byUser.set(k.user_id, list);
  }
  return members.map((m) => ({ ...m, keys: byUser.get(m.id) ?? [] }));
}

export function countOrgSites(
  db: DatabaseSync,
  orgId: string,
): { total: number; permanent: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(s.expires_at IS NULL), 0) AS permanent
       FROM sites s JOIN users u ON u.id = s.owner_user_id
       WHERE u.org_id = ?`,
    )
    .get(orgId) as { total: number; permanent: number };
  return { total: Number(row.total), permanent: Number(row.permanent) };
}

export function listSitesForOrg(db: DatabaseSync, orgId: string): SiteRow[] {
  return db
    .prepare(
      `SELECT ${ORG_SITE_COLS}
       FROM sites s JOIN users u ON u.id = s.owner_user_id
       WHERE u.org_id = ? ORDER BY s.updated_at DESC, s.id`,
    )
    .all(orgId) as unknown as SiteRow[];
}

/** Null disables joining; the previous token stops matching immediately. */
export function setOrgJoinToken(
  db: DatabaseSync,
  id: string,
  token: string | null,
  now: number,
): boolean {
  const result = db
    .prepare(`UPDATE orgs SET join_token_hash = ?, updated_at = ? WHERE id = ?`)
    .run(token === null ? null : hashApiKey(token), now, id);
  return (result.changes ?? 0) > 0;
}

export interface OrgPatch {
  name?: string;
  comp_tier?: OrgTier | null;
  billing_tier?: OrgTier | null;
  stripe_customer_id?: string | null;
  max_members?: number;
  publish_per_hour?: number | null;
}

const ORG_PATCH_COLS = [
  "name",
  "comp_tier",
  "billing_tier",
  "stripe_customer_id",
  "max_members",
  "publish_per_hour",
] as const;

export interface ClampSummary {
  users: number;
  sites: number;
  skipped: number;
}

/**
 * Write the given columns; a tier change (either column, any value) clamps
 * every member's sites in the same transaction. Slice 6 calls this with the
 * billing fields.
 */
export function updateOrg(
  db: DatabaseSync,
  id: string,
  patch: OrgPatch,
  now: number,
): { org: OrgRow; clamped: ClampSummary } | null {
  return transaction(db, () => {
    if (getOrg(db, id) === null) return null;
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const col of ORG_PATCH_COLS) {
      const value = patch[col];
      if (value === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(value);
    }
    sets.push("updated_at = ?");
    values.push(now);
    db.prepare(`UPDATE orgs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    const tierChanged = patch.comp_tier !== undefined || patch.billing_tier !== undefined;
    const clamped = tierChanged
      ? clampSitesForUsers(db, memberIds(db, id), now)
      : { users: 0, sites: 0, skipped: 0 };
    return { org: getOrg(db, id)!, clamped };
  });
}

/** Detach every member, clamp them to their own tiers, then drop the row. */
export function deleteOrg(db: DatabaseSync, id: string, now: number): ClampSummary | null {
  return transaction(db, () => {
    const org = getOrg(db, id);
    if (org === null) return null;
    if (org.billing_tier !== null || org.stripe_customer_id !== null) {
      throw new HttpError(
        409,
        "org_billed",
        "organization has billing state; cancel it in Stripe first",
      );
    }
    const members = memberIds(db, id);
    db.prepare(`UPDATE users SET org_id = NULL, org_role = NULL WHERE org_id = ?`).run(id);
    const clamped = clampSitesForUsers(db, members, now);
    db.prepare(`DELETE FROM orgs WHERE id = ?`).run(id);
    return clamped;
  });
}

function memberIds(db: DatabaseSync, orgId: string): string[] {
  return (
    db.prepare(`SELECT id FROM users WHERE org_id = ? ORDER BY created_at, id`).all(orgId) as {
      id: string;
    }[]
  ).map((r) => r.id);
}

export function assertOrgHasRoom(db: DatabaseSync, org: OrgRow): void {
  if (countOrgMembers(db, org.id) >= org.max_members) {
    throw new HttpError(403, "org_full", "organization has reached its member limit");
  }
}

/** A new free-- user inside the org plus its first key, capped by max_members. */
export function createOrgMember(
  db: DatabaseSync,
  opts: {
    org: OrgRow;
    name: string;
    token: string;
    role: OrgRole;
    claimToken: string;
    now?: number;
  },
): { user: UserRow; key: ApiKeyRow } {
  return transaction(db, () => {
    assertOrgHasRoom(db, opts.org);
    const user = createUser(db, {
      tier: "free--",
      claimToken: opts.claimToken,
      orgId: opts.org.id,
      orgRole: opts.role,
      now: opts.now,
    });
    const key = createApiKeyRecord(db, {
      name: opts.name,
      token: opts.token,
      userId: user.id,
      now: opts.now,
    });
    return { user, key };
  });
}

/**
 * Attach, change role, or detach (org null). The user's sites are clamped
 * either way. Throws 409 when the write would leave the user's current org
 * without an admin.
 */
export function setUserOrg(
  db: DatabaseSync,
  user: UserRow,
  org: OrgRow | null,
  role: OrgRole | null,
  now: number,
): { effectiveTier: Tier; clampedSites: number } {
  return transaction(db, () => {
    if (org !== null && user.org_id !== org.id) assertOrgHasRoom(db, org);
    const nextRole = org === null ? null : (role ?? "member");
    const staysAdmin = org !== null && org.id === user.org_id && nextRole === "admin";
    if (user.org_id !== null && user.org_role === "admin" && !staysAdmin) {
      assertNotLastAdmin(db, user.org_id, user.id);
    }
    db.prepare(`UPDATE users SET org_id = ?, org_role = ? WHERE id = ?`).run(
      org === null ? null : org.id,
      nextRole,
      user.id,
    );
    const clampedSites = clampSitesForUser(db, getUser(db, user.id)!, now) ?? 0;
    return { effectiveTier: effectiveTier(user.tier, orgTier(org)), clampedSites };
  });
}

function otherAdminCount(db: DatabaseSync, orgId: string, userId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE org_id = ? AND org_role = 'admin' AND id <> ?`,
    )
    .get(orgId, userId) as { n: number };
  return Number(row.n);
}

/** Throws 409 when userId is the only admin of orgId. */
function assertNotLastAdmin(db: DatabaseSync, orgId: string, userId: string): void {
  if (otherAdminCount(db, orgId, userId) === 0) {
    throw new HttpError(409, "last_admin", "an organization needs at least one admin");
  }
}

/**
 * Detach a member and clamp their sites; with revokeKeys, also revoke every
 * active key they hold, after the detach so the last-admin check runs first.
 * Null when the user is not in this org.
 */
export function removeOrgMember(
  db: DatabaseSync,
  orgId: string,
  userId: string,
  now: number,
  opts: { revokeKeys?: boolean } = {},
): { clampedSites: number; revokedKeys: number } | null {
  return transaction(db, () => {
    const target = getUser(db, userId);
    if (target === null || target.org_id !== orgId) return null;
    if (target.org_role === "admin") assertNotLastAdmin(db, orgId, userId);
    db.prepare(`UPDATE users SET org_id = NULL, org_role = NULL WHERE id = ?`).run(userId);
    const clampedSites = clampSitesForUser(db, getUser(db, userId)!, now) ?? 0;
    let revokedKeys = 0;
    if (opts.revokeKeys) {
      const result = db
        .prepare(`UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
        .run(now, userId);
      revokedKeys = Number(result.changes ?? 0);
    }
    return { clampedSites, revokedKeys };
  });
}

/** False when the user is not in this org. Demoting the only admin throws 409. */
export function setOrgMemberRole(
  db: DatabaseSync,
  orgId: string,
  userId: string,
  role: OrgRole,
): boolean {
  return transaction(db, () => {
    const target = getUser(db, userId);
    if (target === null || target.org_id !== orgId) return false;
    if (role === "member" && target.org_role === "admin") {
      assertNotLastAdmin(db, orgId, userId);
    }
    db.prepare(`UPDATE users SET org_role = ? WHERE id = ? AND org_id = ?`).run(
      role,
      userId,
      orgId,
    );
    return true;
  });
}

/** Revoke a key only if its user is in the org. False if unknown, revoked, or outside. */
export function revokeOrgMemberKey(
  db: DatabaseSync,
  orgId: string,
  keyId: string,
  now: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE api_keys SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL
         AND user_id IN (SELECT id FROM users WHERE org_id = ?)`,
    )
    .run(now, keyId, orgId);
  return (result.changes ?? 0) > 0;
}

/**
 * Bring one user's stored sites in line with a policy: rows only, never S3,
 * updated_at untouched (the user did not touch the site). Returns the number
 * of distinct sites changed. No transaction of its own.
 */
export function clampSitesToPolicy(
  db: DatabaseSync,
  ownerUserId: string,
  policy: TierPolicy,
  now: number,
): number {
  const touched = new Set<string>();
  const collect = (rows: unknown[]): void => {
    for (const row of rows as { id: string }[]) touched.add(row.id);
  };
  if (!policy.allowNullTtl) {
    const cap = clampStoredExpiry(policy, null, now);
    collect(
      db
        .prepare(
          `UPDATE sites SET expires_at = ? WHERE owner_user_id = ? AND expires_at IS NULL
           RETURNING id`,
        )
        .all(cap, ownerUserId),
    );
  }
  if (policy.maxTtl !== null) {
    const max = expiresAtFromTierTtl(policy.maxTtl, now)!;
    collect(
      db
        .prepare(
          `UPDATE sites SET expires_at = ? WHERE owner_user_id = ? AND expires_at > ?
           RETURNING id`,
        )
        .all(max, ownerUserId, max),
    );
  }
  if (!policy.slugs) {
    collect(
      db
        .prepare(
          `UPDATE sites SET slug = NULL WHERE owner_user_id = ? AND slug IS NOT NULL
           RETURNING id`,
        )
        .all(ownerUserId),
    );
  }
  if (!policy.publicVisibility) {
    collect(
      db
        .prepare(
          `UPDATE sites SET visibility = 'unlisted'
           WHERE owner_user_id = ? AND visibility = 'public'
           RETURNING id`,
        )
        .all(ownerUserId),
    );
  }
  return touched.size;
}

/**
 * Clamp one user against their current effective tier. Null when the user's
 * own tier is unknown: the clamp is skipped so a membership change on an
 * edited row still goes through.
 */
function clampSitesForUser(db: DatabaseSync, user: UserRow, now: number): number | null {
  const org = user.org_id === null ? null : getOrg(db, user.org_id);
  let policy: TierPolicy;
  try {
    policy = policyFor(effectiveTier(user.tier, orgTier(org)));
  } catch (err) {
    if (!(err instanceof UnknownTierError)) throw err;
    return null;
  }
  return clampSitesToPolicy(db, user.id, policy, now);
}

/**
 * Recompute each user's effective tier from current rows and clamp. Correct
 * whichever column moved (own tier, org tier, or membership). A user whose
 * own tier is unknown is skipped and counted, so one edited row never blocks
 * the whole org. No transaction of its own.
 */
export function clampSitesForUsers(
  db: DatabaseSync,
  userIds: string[],
  now: number,
): ClampSummary {
  let users = 0;
  let sites = 0;
  let skipped = 0;
  for (const id of userIds) {
    const user = getUser(db, id);
    if (user === null) continue;
    const clamped = clampSitesForUser(db, user, now);
    if (clamped === null) {
      skipped += 1;
      continue;
    }
    users += 1;
    sites += clamped;
  }
  return { users, sites, skipped };
}

/**
 * Backstop for tier edits made outside the API: any permanent site whose
 * owner's current effective tier forbids a NULL expiry gets now + maxTtl. An
 * unknown own tier is skipped and logged rather than aborting the sweep.
 *
 * Rows that can never be clamped (an owner, or an org tier column, on a tier
 * that allows a NULL expiry) are left out of the scan, which runs outside a
 * transaction; one is opened only when a row needs resolving.
 */
export function reconcilePermanentSites(
  db: DatabaseSync,
  now: number,
  log?: { warn(msg: string): void },
): { clamped: number; skipped: number } {
  const permanentTiers = (Object.keys(TIER_POLICIES) as Tier[]).filter(
    (tier) => TIER_POLICIES[tier].allowNullTtl,
  );
  const permanentOrgTiers = permanentTiers.filter((tier) => tier !== "ops");
  const placeholders = (list: string[]): string => list.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT s.id, s.owner_user_id, u.tier AS user_tier, o.comp_tier, o.billing_tier
       FROM sites s
       JOIN users u ON u.id = s.owner_user_id
       LEFT JOIN orgs o ON o.id = u.org_id
       WHERE s.expires_at IS NULL
         AND u.tier NOT IN (${placeholders(permanentTiers)})
         AND (o.comp_tier IS NULL OR o.comp_tier NOT IN (${placeholders(permanentOrgTiers)}))
         AND (o.billing_tier IS NULL OR o.billing_tier NOT IN (${placeholders(permanentOrgTiers)}))`,
    )
    .all(...permanentTiers, ...permanentOrgTiers, ...permanentOrgTiers) as unknown as {
    id: string;
    owner_user_id: string;
    user_tier: string;
    comp_tier: string | null;
    billing_tier: string | null;
  }[];
  if (rows.length === 0) return { clamped: 0, skipped: 0 };
  return transaction(db, () => {
    const assign = db.prepare(
      `UPDATE sites SET expires_at = ? WHERE id = ? AND expires_at IS NULL`,
    );
    let clamped = 0;
    let skipped = 0;
    const unknownOwners = new Set<string>();
    for (const row of rows) {
      let policy: TierPolicy;
      try {
        policy = policyFor(effectiveTier(row.user_tier as Tier, orgTier(row)));
      } catch (err) {
        if (!(err instanceof UnknownTierError)) throw err;
        skipped += 1;
        unknownOwners.add(row.owner_user_id);
        continue;
      }
      if (policy.allowNullTtl) continue;
      const result = assign.run(clampStoredExpiry(policy, null, now), row.id);
      clamped += Number(result.changes ?? 0);
    }
    if (skipped > 0) {
      log?.warn(
        `reap: skipped ${skipped} permanent site(s) owned by ${unknownOwners.size} user(s) with an unknown tier: ${[...unknownOwners].join(", ")}`,
      );
    }
    return { clamped, skipped };
  });
}
