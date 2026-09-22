import { describe, expect, it } from "vitest";
import {
  clampSitesToPolicy,
  countOrgMembers,
  countOrgSites,
  createApiKeyRecord,
  createOpsKey,
  createOrg,
  createOrgMember,
  createUser,
  deleteOrg,
  findApiKeyByToken,
  findOrgByJoinToken,
  getOrg,
  getSite,
  getSiteBySlug,
  getUser,
  insertSite,
  listApiKeys,
  listOrgMembers,
  listOrgs,
  listSitesForOrg,
  listSitesForUser,
  openDb,
  reconcilePermanentSites,
  removeOrgMember,
  revokeOrgMemberKey,
  setOrgJoinToken,
  setOrgMemberRole,
  setUserOrg,
  setUserTier,
  updateOrg,
  upgrade,
  type ApiKeyRow,
  type OrgRow,
  type SiteRow,
  type UserRow,
} from "./db.js";
import { HttpError } from "./errors.js";
import { policyFor, type OrgRole, type Tier } from "./tiers.js";

type Db = ReturnType<typeof openDb>;

const now = 1_000_000_000_000;
const DAY = 86_400_000;
let seq = 0;

function org(db: Db, opts: Partial<Parameters<typeof createOrg>[1]> = {}): OrgRow {
  seq += 1;
  return createOrg(db, {
    name: "SkySlope",
    compTier: "paid",
    joinToken: `org_${seq}`,
    now,
    ...opts,
  });
}

function member(
  db: Db,
  o: OrgRow,
  role: OrgRole = "member",
  at = now,
): { user: UserRow; key: ApiKeyRow } {
  seq += 1;
  return createOrgMember(db, {
    org: o,
    name: `m${seq}`,
    token: `sp_m${seq}`,
    role,
    claimToken: `claim${seq}`,
    now: at,
  });
}

function plainUser(db: Db, tier: Tier): { user: UserRow; key: ApiKeyRow; token: string } {
  seq += 1;
  const token = `sp_p${seq}`;
  const user = createUser(db, { tier, now });
  const key = createApiKeyRecord(db, { name: `p${seq}`, token, userId: user.id, now });
  return { user, key, token };
}

/** A site created a day ago; expires_at NULL unless given. */
function siteRow(
  db: Db,
  id: string,
  owner: { user: UserRow; key: ApiKeyRow },
  fields: Partial<Pick<SiteRow, "slug" | "visibility" | "expires_at">> = {},
): void {
  insertSite(db, {
    id,
    owner_key_id: owner.key.id,
    owner_user_id: owner.user.id,
    slug: null,
    title: null,
    visibility: "unlisted",
    current_version_id: null,
    created_at: now - DAY,
    updated_at: now - DAY,
    expires_at: null,
    ...fields,
  });
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectHttpError(err: unknown, statusCode: number, code: string): void {
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ statusCode, code });
}

/** Throws if a transaction was left open by the call under test. */
function expectNoOpenTransaction(db: Db): void {
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
}

function site(
  db: Db,
  id: string,
  slug: string,
  created_at: number,
  ownerKeyId: string,
  ownerUserId: string,
) {
  insertSite(db, {
    id,
    owner_key_id: ownerKeyId,
    owner_user_id: ownerUserId,
    slug,
    title: null,
    visibility: "unlisted",
    current_version_id: null,
    created_at,
    updated_at: created_at,
    expires_at: null,
    byte_size: 0,
    file_count: 0,
  });
}

/** A database as the pre-hostname schema left it: no case-insensitive index. */
function legacyDb(): Db {
  const db = openDb(":memory:");
  db.exec("DROP INDEX idx_sites_slug_nocase; PRAGMA user_version = 0;");
  return db;
}

describe("upgrade", () => {
  it("keeps the oldest site's slug, clears the rest, then enforces uniqueness", () => {
    const db = legacyDb();
    const a = createOpsKey(db, { name: "a", token: "sp_a" });
    const b = createOpsKey(db, { name: "b", token: "sp_b" });
    site(db, "s1", "MyPlan", 10, a.key.id, a.user.id);
    site(db, "s2", "myplan", 20, b.key.id, b.user.id);
    site(db, "s3", "MYPLAN", 20, b.key.id, b.user.id);
    site(db, "s4", "other", 5, a.key.id, a.user.id);

    upgrade(db);

    expect(getSiteBySlug(db, "myplan")?.id).toBe("s1");
    expect(getSiteBySlug(db, "other")?.id).toBe("s4");
    expect(db.prepare("SELECT id FROM sites WHERE slug IS NULL ORDER BY id").all()).toEqual([
      { id: "s2" },
      { id: "s3" },
    ]);
    expect(() => site(db, "s5", "MYPLAN", 30, a.key.id, a.user.id)).toThrow(/UNIQUE/);
    db.close();
  });

  it("runs once", () => {
    const db = openDb(":memory:");
    const version = () =>
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(version()).toBe(3);
    expect(schemaNames(db, "table")).toContain("orgs");
    expect(columnNames(db, "users")).toEqual(expect.arrayContaining(["org_id", "org_role"]));
    expect(schemaNames(db, "index")).toEqual(
      expect.arrayContaining([
        "idx_users_org",
        "idx_orgs_join_token",
        "idx_orgs_stripe_customer",
        "idx_sites_permanent",
      ]),
    );
    upgrade(db); // no-op, index already exists
    expect(version()).toBe(3);
    db.close();
  });

  it("adds organizations to a pre-org database without touching existing rows", () => {
    const db = openDb(":memory:");
    const a = createOpsKey(db, { name: "a", token: "sp_a" });
    site(db, "s1", "plan", 10, a.key.id, a.user.id);
    const before = getSite(db, "s1");
    db.exec(`
      DROP INDEX idx_users_org;
      ALTER TABLE users DROP COLUMN org_id;
      ALTER TABLE users DROP COLUMN org_role;
      DROP INDEX idx_sites_permanent;
      DROP TABLE orgs;
    `);
    expect(schemaNames(db, "table")).not.toContain("orgs");
    expect(columnNames(db, "users")).not.toContain("org_id");

    upgrade(db);

    expect(schemaNames(db, "table")).toContain("orgs");
    expect(columnNames(db, "users")).toEqual(expect.arrayContaining(["org_id", "org_role"]));
    expect(schemaNames(db, "index")).toEqual(
      expect.arrayContaining(["idx_users_org", "idx_sites_permanent"]),
    );
    expect(getUser(db, a.user.id)).toMatchObject({ tier: "ops", org_id: null, org_role: null });
    expect(findApiKeyByToken(db, "sp_a")?.id).toBe(a.key.id);
    expect(getSite(db, "s1")).toEqual(before);
    db.close();
  });

  it("clears reserved slugs", () => {
    const db = openDb(":memory:");
    const a = createOpsKey(db, { name: "a", token: "sp_a" });
    site(db, "s1", "www", 10, a.key.id, a.user.id);
    db.exec("PRAGMA user_version = 1;");
    upgrade(db);
    expect(getSiteBySlug(db, "www")).toBeNull();
    expect(getSite(db, "s1")?.slug).toBeNull();
    db.close();
  });

  it("replaces the old email index with case-insensitive uniqueness", () => {
    const db = openDb(":memory:");
    db.exec(`
      DROP INDEX idx_users_email;
      CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
      PRAGMA user_version = 2;
    `);
    const first = createUser(db, { tier: "free" });
    const second = createUser(db, { tier: "free" });
    db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run("Human@Example.com", first.id);

    upgrade(db);

    const index = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_email'`)
      .get() as { sql: string };
    expect(index.sql).toContain("email COLLATE NOCASE");
    expect(() =>
      db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run("human@example.com", second.id),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});

function schemaNames(db: Db, type: "table" | "index"): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as { name: string }[]
  ).map((r) => r.name);
}

function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
    (r) => r.name,
  );
}

describe("orgs schema", () => {
  it("refuses ops in either tier column", () => {
    const db = openDb(":memory:");
    const o = org(db);
    expect(() => db.prepare(`UPDATE orgs SET comp_tier = 'ops' WHERE id = ?`).run(o.id)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      db.prepare(`UPDATE orgs SET billing_tier = 'ops' WHERE id = ?`).run(o.id),
    ).toThrow(/CHECK constraint failed/);
    expect(getOrg(db, o.id)).toMatchObject({ comp_tier: "paid", billing_tier: null });
    db.close();
  });

  it("refuses a raw delete with members; deleteOrg detaches them first", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const m = member(db, o);
    expect(() => db.prepare(`DELETE FROM orgs WHERE id = ?`).run(o.id)).toThrow(/FOREIGN KEY/);
    expect(getOrg(db, o.id)).not.toBeNull();

    expect(deleteOrg(db, o.id, now)).toEqual({ users: 1, sites: 0, skipped: 0 });
    expect(getOrg(db, o.id)).toBeNull();
    expect(getUser(db, m.user.id)).toMatchObject({ org_id: null, org_role: null });
    expect(findApiKeyByToken(db, `sp_m${seq}`)?.id).toBe(m.key.id);
    expect(deleteOrg(db, o.id, now)).toBeNull();
    db.close();
  });

  it("lists orgs, members, keys, and sites", () => {
    const db = openDb(":memory:");
    const first = org(db, { name: "First", now: now - 10 });
    const second = org(db, { name: "Second", compTier: null, maxMembers: 5, publishPerHour: 7 });
    const admin = member(db, first, "admin", now - 1);
    const m = member(db, first);
    const revoked = createApiKeyRecord(db, {
      name: "old",
      token: "sp_old",
      userId: m.user.id,
      now,
    });
    db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).run(now, revoked.id);
    const outsider = plainUser(db, "free");
    siteRow(db, "a1", admin, { expires_at: now + DAY });
    siteRow(db, "m1", m);
    siteRow(db, "m2", m, { expires_at: now + DAY });
    siteRow(db, "o1", outsider);
    db.prepare(`UPDATE sites SET updated_at = ? WHERE id = 'm1'`).run(now);

    expect(listOrgs(db).map((o) => o.name)).toEqual(["First", "Second"]);
    expect(getOrg(db, second.id)).toMatchObject({
      comp_tier: null,
      max_members: 5,
      publish_per_hour: 7,
    });
    expect(countOrgMembers(db, first.id)).toBe(2);
    expect(countOrgMembers(db, second.id)).toBe(0);
    expect(listOrgMembers(db, second.id)).toEqual([]);
    expect(listOrgMembers(db, first.id)).toEqual([
      {
        id: admin.user.id,
        tier: "free--",
        org_role: "admin",
        email: null,
        created_at: now - 1,
        claimed_at: null,
        sites: 1,
        keys: [{ id: admin.key.id, name: admin.key.name, created_at: now - 1 }],
      },
      {
        id: m.user.id,
        tier: "free--",
        org_role: "member",
        email: null,
        created_at: now,
        claimed_at: null,
        sites: 2,
        keys: [{ id: m.key.id, name: m.key.name, created_at: now }],
      },
    ]);
    expect(countOrgSites(db, first.id)).toEqual({ total: 3, permanent: 1 });
    expect(countOrgSites(db, second.id)).toEqual({ total: 0, permanent: 0 });
    // a1 and m2 share an updated_at; the id tiebreak fixes their order.
    expect(listSitesForOrg(db, first.id).map((s) => s.id)).toEqual(["m1", "a1", "m2"]);
    expect(listSitesForOrg(db, first.id)[0]).toEqual(getSite(db, "m1"));
    const keys = listApiKeys(db);
    expect(keys.find((k) => k.id === admin.key.id)?.org_id).toBe(first.id);
    expect(keys.find((k) => k.id === outsider.key.id)?.org_id).toBeNull();
    db.close();
  });
});

describe("clampSitesToPolicy", () => {
  it("brings free-- sites to 30d, drops slugs and public, leaves the rest", () => {
    const db = openDb(":memory:");
    const a = plainUser(db, "paid");
    const b = plainUser(db, "paid");
    siteRow(db, "a1", a);
    siteRow(db, "a2", a, { expires_at: now + 10 * 365 * DAY });
    siteRow(db, "a3", a, { slug: "kept", visibility: "public", expires_at: now + DAY });
    siteRow(db, "a4", a, { expires_at: now + DAY });
    siteRow(db, "b1", b);
    siteRow(db, "b2", b, { expires_at: now + 10 * 365 * DAY });
    siteRow(db, "b3", b, { slug: "kept-b", visibility: "public", expires_at: now + DAY });
    siteRow(db, "b4", b, { expires_at: now + DAY });
    const bBefore = listSitesForUser(db, b.user.id);

    // a3 is hit by two rules (slug and visibility) but counts once.
    expect(clampSitesToPolicy(db, a.user.id, policyFor("free--"), now)).toBe(3);

    expect(getSite(db, "a1")).toMatchObject({ expires_at: now + 30 * DAY, updated_at: now - DAY });
    expect(getSite(db, "a2")).toMatchObject({ expires_at: now + 30 * DAY, updated_at: now - DAY });
    expect(getSite(db, "a3")).toMatchObject({
      slug: null,
      visibility: "unlisted",
      expires_at: now + DAY,
      updated_at: now - DAY,
    });
    expect(getSite(db, "a4")).toMatchObject({
      slug: null,
      visibility: "unlisted",
      expires_at: now + DAY,
      updated_at: now - DAY,
    });
    expect(listSitesForUser(db, b.user.id)).toEqual(bBefore);
    db.close();
  });

  it("changes nothing at paid; free assigns 1y and keeps slug and public", () => {
    const db = openDb(":memory:");
    const a = plainUser(db, "paid");
    siteRow(db, "a1", a, { slug: "kept", visibility: "public" });
    siteRow(db, "a2", a, { expires_at: now + 10 * 365 * DAY });
    const before = listSitesForUser(db, a.user.id);

    expect(clampSitesToPolicy(db, a.user.id, policyFor("paid"), now)).toBe(0);
    expect(listSitesForUser(db, a.user.id)).toEqual(before);

    expect(clampSitesToPolicy(db, a.user.id, policyFor("free"), now)).toBe(2);
    expect(getSite(db, "a1")).toMatchObject({
      slug: "kept",
      visibility: "public",
      expires_at: now + 365 * DAY,
    });
    expect(getSite(db, "a2")?.expires_at).toBe(now + 365 * DAY);
    db.close();
  });
});

describe("updateOrg", () => {
  it("recomputes per member: a personally paid member keeps permanent sites", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const m1 = member(db, o);
    const m2 = member(db, o);
    setUserTier(db, m2.user.id, "paid");
    siteRow(db, "s1", m1);
    siteRow(db, "s2", m2);

    const result = updateOrg(db, o.id, { comp_tier: "free" }, now + 1);

    expect(result?.clamped).toEqual({ users: 2, sites: 1, skipped: 0 });
    expect(result?.org).toMatchObject({ comp_tier: "free", updated_at: now + 1 });
    expect(getSite(db, "s1")?.expires_at).toBe(now + 1 + 365 * DAY);
    expect(getSite(db, "s2")?.expires_at).toBeNull();
    db.close();
  });

  it("clamps only on a tier change, and never on a raise", () => {
    const db = openDb(":memory:");
    const o = org(db, { compTier: "free" });
    const m = member(db, o);
    siteRow(db, "s1", m, { slug: "plan", expires_at: now + 7 * DAY });
    const before = db.prepare(`SELECT * FROM sites ORDER BY id`).all();

    expect(updateOrg(db, o.id, { comp_tier: "paid" }, now)?.clamped).toEqual({
      users: 1,
      sites: 0,
      skipped: 0,
    });
    expect(db.prepare(`SELECT * FROM sites ORDER BY id`).all()).toEqual(before);

    db.prepare(`UPDATE sites SET expires_at = NULL WHERE id = 's1'`).run();
    const renamed = updateOrg(db, o.id, { name: "SkySlope Eng" }, now);
    expect(renamed?.org.name).toBe("SkySlope Eng");
    expect(renamed?.clamped).toEqual({ users: 0, sites: 0, skipped: 0 });
    expect(getSite(db, "s1")?.expires_at).toBeNull();

    siteRow(db, "s2", m, { visibility: "public", expires_at: now + DAY });
    expect(updateOrg(db, o.id, { comp_tier: "free-" }, now)?.clamped).toEqual({
      users: 1,
      sites: 2,
      skipped: 0,
    });
    expect(getSite(db, "s1")).toMatchObject({ slug: "plan", expires_at: now + 90 * DAY });
    expect(getSite(db, "s2")).toMatchObject({ visibility: "unlisted", expires_at: now + DAY });
    expect(updateOrg(db, "nope", { name: "x" }, now)).toBeNull();
    db.close();
  });

  it("skips a member whose own tier is unknown and clamps the rest", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const a = member(db, o, "admin");
    const b = member(db, o, "admin");
    db.prepare(`UPDATE users SET tier = 'gold' WHERE id = ?`).run(b.user.id);
    siteRow(db, "a1", a);
    siteRow(db, "b1", b);

    expect(updateOrg(db, o.id, { comp_tier: null }, now)?.clamped).toEqual({
      users: 1,
      sites: 1,
      skipped: 1,
    });
    expect(getOrg(db, o.id)?.comp_tier).toBeNull();
    expect(getSite(db, "a1")?.expires_at).toBe(now + 30 * DAY);
    expect(getSite(db, "b1")?.expires_at).toBeNull();

    // A single-user operation on the edited row skips the clamp and goes through.
    expect(removeOrgMember(db, o.id, b.user.id, now)).toEqual({ clampedSites: 0, revokedKeys: 0 });
    expect(getUser(db, b.user.id)).toMatchObject({ org_id: null, org_role: null });
    expect(getSite(db, "b1")?.expires_at).toBeNull();
    expect(setUserOrg(db, getUser(db, b.user.id)!, o, "admin", now).clampedSites).toBe(0);
    expect(getUser(db, b.user.id)).toMatchObject({ org_id: o.id, org_role: "admin" });
    expect(getSite(db, "b1")?.expires_at).toBeNull();

    expect(deleteOrg(db, o.id, now)).toEqual({ users: 1, sites: 0, skipped: 1 });
    expect(getUser(db, b.user.id)).toMatchObject({ org_id: null, org_role: null });
    expectNoOpenTransaction(db);
    db.close();
  });
});

describe("membership", () => {
  it("setUserOrg detach falls back to the user's own tier", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const m = member(db, o);
    siteRow(db, "s1", m);

    expect(setUserOrg(db, getUser(db, m.user.id)!, null, null, now)).toEqual({
      effectiveTier: "free--",
      clampedSites: 1,
    });
    expect(getSite(db, "s1")?.expires_at).toBe(now + 30 * DAY);
    expect(getUser(db, m.user.id)).toMatchObject({ org_id: null, org_role: null });
    db.close();
  });

  it("setUserOrg attach checks the cap and lifts the tier", () => {
    const db = openDb(":memory:");
    const o = org(db, { maxMembers: 1 });
    const a = plainUser(db, "free--");
    const b = plainUser(db, "free");
    expect(setUserOrg(db, a.user, o, "member", now)).toEqual({
      effectiveTier: "paid",
      clampedSites: 0,
    });
    expect(getUser(db, a.user.id)).toMatchObject({ org_id: o.id, org_role: "member" });
    expectHttpError(caught(() => setUserOrg(db, b.user, o, "member", now)), 403, "org_full");
    expect(getUser(db, b.user.id)?.org_id).toBeNull();
    // A role change inside the same org does not count against the cap.
    expect(setUserOrg(db, getUser(db, a.user.id)!, o, "admin", now).effectiveTier).toBe("paid");
    expect(getUser(db, a.user.id)?.org_role).toBe("admin");
    expectNoOpenTransaction(db);
    db.close();
  });

  it("setUserOrg keeps one admin on detach, demotion, and a move", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const other = org(db, { name: "Other" });
    const lead = member(db, o, "admin");
    const current = () => getUser(db, lead.user.id)!;

    for (const [target, role] of [
      [null, null],
      [o, "member"],
      [o, null],
      [other, "admin"],
    ] as const) {
      expectHttpError(caught(() => setUserOrg(db, current(), target, role, now)), 409, "last_admin");
      expect(current()).toMatchObject({ org_id: o.id, org_role: "admin" });
    }
    expect(setUserOrg(db, current(), o, "admin", now).effectiveTier).toBe("paid");
    expect(current().org_role).toBe("admin");

    member(db, o, "admin");
    expect(setUserOrg(db, current(), o, "member", now).effectiveTier).toBe("paid");
    expect(current().org_role).toBe("member");
    expect(setOrgMemberRole(db, o.id, lead.user.id, "admin")).toBe(true);
    expect(setUserOrg(db, current(), null, null, now).effectiveTier).toBe("free--");
    expect(current()).toMatchObject({ org_id: null, org_role: null });
    expectNoOpenTransaction(db);
    db.close();
  });

  it("createOrgMember stops at max_members", () => {
    const db = openDb(":memory:");
    const o = org(db, { maxMembers: 2 });
    member(db, o);
    member(db, o);
    const counts = () => ({
      users: (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n,
      keys: (db.prepare(`SELECT COUNT(*) AS n FROM api_keys`).get() as { n: number }).n,
    });
    const before = counts();

    expectHttpError(caught(() => member(db, o)), 403, "org_full");
    expect(counts()).toEqual(before);
    expectNoOpenTransaction(db);
    db.close();
  });

  it("createOrgMember rolls back the user row when the key insert fails", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const taken = plainUser(db, "free");
    createApiKeyRecord(db, { name: "dup", token: "sp_dup", userId: taken.user.id, now });
    const counts = () => ({
      users: (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n,
      keys: (db.prepare(`SELECT COUNT(*) AS n FROM api_keys`).get() as { n: number }).n,
      members: countOrgMembers(db, o.id),
    });
    const before = counts();

    const err = caught(() =>
      createOrgMember(db, {
        org: o,
        name: "x",
        token: "sp_dup",
        role: "member",
        claimToken: "claimX",
        now,
      }),
    );
    expect((err as Error).message).toMatch(/UNIQUE/);
    expect(counts()).toEqual(before);
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE id NOT IN (SELECT user_id FROM api_keys)`)
        .get(),
    ).toEqual({ n: 0 });
    expectNoOpenTransaction(db);
    db.close();
  });

  it("removeOrgMember keeps one admin and clamps the removed user", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const admin = member(db, o, "admin");
    const m = member(db, o);
    siteRow(db, "s1", m);

    expectHttpError(
      caught(() => removeOrgMember(db, o.id, admin.user.id, now)),
      409,
      "last_admin",
    );
    expect(getUser(db, admin.user.id)?.org_id).toBe(o.id);

    member(db, o, "admin");
    expect(removeOrgMember(db, o.id, admin.user.id, now)).toEqual({
      clampedSites: 0,
      revokedKeys: 0,
    });
    expect(removeOrgMember(db, o.id, m.user.id, now, { revokeKeys: true })).toEqual({
      clampedSites: 1,
      revokedKeys: 1,
    });
    expect(getSite(db, "s1")?.expires_at).toBe(now + 30 * DAY);
    expect(getUser(db, m.user.id)).toMatchObject({ org_id: null, org_role: null });
    expect(db.prepare(`SELECT revoked_at FROM api_keys WHERE id = ?`).get(m.key.id)).toEqual({
      revoked_at: now,
    });

    expect(removeOrgMember(db, o.id, "nope", now)).toBeNull();
    const outsider = plainUser(db, "free");
    expect(removeOrgMember(db, o.id, outsider.user.id, now)).toBeNull();
    const elsewhere = member(db, org(db, { name: "Other" }));
    expect(removeOrgMember(db, o.id, elsewhere.user.id, now, { revokeKeys: true })).toBeNull();
    expect(getUser(db, elsewhere.user.id)).toMatchObject({
      org_id: elsewhere.user.org_id,
      org_role: "member",
    });
    expect(findApiKeyByToken(db, `sp_m${seq}`)?.id).toBe(elsewhere.key.id);
    expectNoOpenTransaction(db);
    db.close();
  });

  it("setOrgMemberRole promotes, demotes, and protects the only admin", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const admin = member(db, o, "admin");
    const m = member(db, o);

    expectHttpError(
      caught(() => setOrgMemberRole(db, o.id, admin.user.id, "member")),
      409,
      "last_admin",
    );
    expect(getUser(db, admin.user.id)?.org_role).toBe("admin");

    expect(setOrgMemberRole(db, o.id, m.user.id, "admin")).toBe(true);
    expect(getUser(db, m.user.id)?.org_role).toBe("admin");
    expect(setOrgMemberRole(db, o.id, admin.user.id, "member")).toBe(true);
    expect(getUser(db, admin.user.id)?.org_role).toBe("member");

    const outsider = plainUser(db, "free");
    expect(setOrgMemberRole(db, o.id, outsider.user.id, "admin")).toBe(false);
    expect(getUser(db, outsider.user.id)).toMatchObject({ org_id: null, org_role: null });
    const elsewhere = member(db, org(db, { name: "Other" }));
    expect(setOrgMemberRole(db, o.id, elsewhere.user.id, "admin")).toBe(false);
    expect(getUser(db, elsewhere.user.id)).toMatchObject({
      org_id: elsewhere.user.org_id,
      org_role: "member",
    });
    expectNoOpenTransaction(db);
    db.close();
  });

  it("revokeOrgMemberKey only touches active keys of members", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const m = member(db, o);
    const outsider = plainUser(db, "free");

    expect(revokeOrgMemberKey(db, o.id, m.key.id, now)).toBe(true);
    expect(db.prepare(`SELECT revoked_at FROM api_keys WHERE id = ?`).get(m.key.id)).toEqual({
      revoked_at: now,
    });
    expect(revokeOrgMemberKey(db, o.id, m.key.id, now + 1)).toBe(false);
    expect(revokeOrgMemberKey(db, o.id, outsider.key.id, now)).toBe(false);
    expect(findApiKeyByToken(db, outsider.token)?.id).toBe(outsider.key.id);
    const elsewhere = member(db, org(db, { name: "Other" }));
    expect(revokeOrgMemberKey(db, o.id, elsewhere.key.id, now)).toBe(false);
    expect(
      db.prepare(`SELECT revoked_at FROM api_keys WHERE id = ?`).get(elsewhere.key.id),
    ).toEqual({ revoked_at: null });
    db.close();
  });

  it("deleteOrg refuses while billing state exists", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const m = member(db, o);
    siteRow(db, "s1", m);
    db.prepare(`UPDATE orgs SET stripe_customer_id = 'cus_1' WHERE id = ?`).run(o.id);

    expectHttpError(caught(() => deleteOrg(db, o.id, now)), 409, "org_billed");
    expect(getOrg(db, o.id)).not.toBeNull();
    expect(getUser(db, m.user.id)?.org_id).toBe(o.id);
    expect(getSite(db, "s1")?.expires_at).toBeNull();

    db.prepare(`UPDATE orgs SET stripe_customer_id = NULL, billing_tier = 'free' WHERE id = ?`).run(
      o.id,
    );
    expectHttpError(caught(() => deleteOrg(db, o.id, now)), 409, "org_billed");
    expectNoOpenTransaction(db);
    db.close();
  });

  it("join tokens resolve until rotated or disabled", () => {
    const db = openDb(":memory:");
    const o = org(db, { joinToken: "org_first" });
    expect(findOrgByJoinToken(db, "org_first")?.id).toBe(o.id);
    expect(findOrgByJoinToken(db, "org_never")).toBeNull();

    expect(setOrgJoinToken(db, o.id, null, now + 1)).toBe(true);
    expect(findOrgByJoinToken(db, "org_first")).toBeNull();
    expect(getOrg(db, o.id)).toMatchObject({ join_token_hash: null, updated_at: now + 1 });

    expect(setOrgJoinToken(db, o.id, "org_second", now + 2)).toBe(true);
    expect(findOrgByJoinToken(db, "org_second")?.id).toBe(o.id);
    expect(findOrgByJoinToken(db, "org_first")).toBeNull();
    expect(setOrgJoinToken(db, "nope", "org_x", now)).toBe(false);
    db.close();
  });
});

describe("reconcilePermanentSites", () => {
  it("assigns expiry only where the effective tier forbids NULL, skipping unknown tiers", () => {
    const db = openDb(":memory:");
    const o = org(db);
    const free = plainUser(db, "free--");
    const paid = plainUser(db, "paid");
    const ops = createOpsKey(db, { name: "ops", token: "sp_ops", now });
    const m = member(db, o);
    const gold = plainUser(db, "free--");
    db.prepare(`UPDATE users SET tier = 'gold' WHERE id = ?`).run(gold.user.id);
    siteRow(db, "free", free);
    siteRow(db, "paid", paid);
    siteRow(db, "ops", ops);
    siteRow(db, "member", m);
    siteRow(db, "gold", gold);
    const warnings: string[] = [];

    expect(reconcilePermanentSites(db, now, { warn: (msg) => warnings.push(msg) })).toEqual({
      clamped: 1,
      skipped: 1,
    });
    expect(getSite(db, "free")?.expires_at).toBe(now + 30 * DAY);
    for (const id of ["paid", "ops", "member", "gold"]) {
      expect(getSite(db, id)?.expires_at, id).toBeNull();
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("skipped 1 permanent site(s) owned by 1 user(s)");
    expect(warnings[0]).toContain(gold.user.id);

    expect(reconcilePermanentSites(db, now)).toEqual({ clamped: 0, skipped: 1 });
    db.prepare(`UPDATE users SET tier = 'paid' WHERE id = ?`).run(gold.user.id);
    expect(reconcilePermanentSites(db, now)).toEqual({ clamped: 0, skipped: 0 });
    expectNoOpenTransaction(db);
    db.close();
  });

  it("leaves rows that can never be clamped out of the scan and opens no transaction", () => {
    const db = openDb(":memory:");
    const comped = org(db);
    const billed = org(db, { name: "Billed", compTier: null });
    db.prepare(`UPDATE orgs SET billing_tier = 'paid' WHERE id = ?`).run(billed.id);
    siteRow(db, "ops", createOpsKey(db, { name: "ops", token: "sp_ops", now }));
    siteRow(db, "paid", plainUser(db, "paid"));
    siteRow(db, "comp", member(db, comped));
    siteRow(db, "billing", member(db, getOrg(db, billed.id)!));

    // Inside an outer transaction any BEGIN the sweep attempts would throw.
    db.exec("BEGIN");
    expect(reconcilePermanentSites(db, now)).toEqual({ clamped: 0, skipped: 0 });
    db.exec("ROLLBACK");

    siteRow(db, "free", plainUser(db, "free--"));
    db.exec("BEGIN");
    expect(() => reconcilePermanentSites(db, now)).toThrow(/within a transaction/);
    db.exec("ROLLBACK");
    expect(reconcilePermanentSites(db, now)).toEqual({ clamped: 1, skipped: 0 });
    expect(getSite(db, "free")?.expires_at).toBe(now + 30 * DAY);
    for (const id of ["ops", "paid", "comp", "billing"]) {
      expect(getSite(db, id)?.expires_at, id).toBeNull();
    }
    expectNoOpenTransaction(db);
    db.close();
  });
});
