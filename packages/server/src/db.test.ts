import { describe, expect, it } from "vitest";
import { createOpsKey, getSiteBySlug, insertSite, openDb, upgrade } from "./db.js";

type Db = ReturnType<typeof openDb>;

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
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      1,
    );
    upgrade(db); // no-op, index already exists
    db.close();
  });
});
