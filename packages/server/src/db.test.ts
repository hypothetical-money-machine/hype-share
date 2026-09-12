import { describe, expect, it } from "vitest";
import { createApiKeyRecord, getSiteBySlug, insertSite, openDb, resolveCaseFoldedSlugs } from "./db.js";

function site(db: ReturnType<typeof openDb>, id: string, slug: string, created_at: number, owner: string) {
  insertSite(db, {
    id,
    owner_key_id: owner,
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

describe("resolveCaseFoldedSlugs", () => {
  it("keeps the oldest site's slug and clears the rest", () => {
    const db = openDb(":memory:");
    const a = createApiKeyRecord(db, { name: "a", token: "sp_a" }).id;
    const b = createApiKeyRecord(db, { name: "b", token: "sp_b" }).id;
    site(db, "s1", "MyPlan", 10, a);
    site(db, "s2", "myplan", 20, b);
    site(db, "s3", "MYPLAN", 20, b);
    site(db, "s4", "other", 5, a);

    const cleared = resolveCaseFoldedSlugs(db);
    expect(cleared).toEqual([
      { id: "s2", slug: "myplan" },
      { id: "s3", slug: "MYPLAN" },
    ]);
    expect(getSiteBySlug(db, "myplan")?.id).toBe("s1");
    expect(getSiteBySlug(db, "other")?.id).toBe("s4");
    expect(resolveCaseFoldedSlugs(db)).toEqual([]);
    db.close();
  });
});
