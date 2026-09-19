import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { createOpsKey, hashApiKey, openDb } from "./db.js";
import { createFakeS3 } from "./testing/fake-s3.js";
import { reapExpiredSites } from "./reap.js";

const origin = "https://share.example.com";
const headers = { host: "share.example.com", origin };
const admin = "owner-test-secret";
const publishingToken = "sp_publisher";
const opened: { app: FastifyInstance; db: DatabaseSync }[] = [];
afterEach(async () => {
  for (const { app, db } of opened.splice(0)) { await app.close(); db.close(); }
});
async function setup(overrides: Partial<Config> = {}) {
  const config = { ...loadConfig({ SHAREPLAN_PUBLIC_BASE_URL: origin, SHAREPLAN_SITE_HOST_SUFFIX: "share.example.com", SHAREPLAN_ADMIN_TOKEN: admin, SHAREPLAN_DATA_DIR: "/tmp", SHAREPLAN_IP_HASH_PEPPER: "test-pepper" }), ...overrides };
  const db = openDb(":memory:");
  const s3 = createFakeS3();
  const app = await buildApp({ config, db, s3: s3.client, logger: false });
  opened.push({ app, db });
  return { app, db, s3, config };
}
async function login(app: FastifyInstance) {
  const response = await app.inject({ method: "POST", url: "/owner/login", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ token: admin }).toString() });
  expect(response.statusCode).toBe(303);
  return String(response.headers["set-cookie"]).split(";")[0]!;
}

describe("owner portal", () => {
  it("requires owner authentication and uses a revocable, hashed session", async () => {
    const { app, db } = await setup();
    expect((await app.inject({ url: "/owner", headers })).headers.location).toBe("/owner/login");
    const page = await app.inject({ url: "/owner/login", headers });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    createOpsKey(db, { name: "publisher", token: publishingToken });
    expect((await app.inject({ url: "/api/v1/admin/stats", headers: { ...headers, authorization: `Bearer ${publishingToken}` } })).statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/owner/login", headers, payload: { token: publishingToken } });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).not.toContain(publishingToken);
    const response = await app.inject({ method: "POST", url: "/owner/login", headers, payload: { token: admin } });
    const rawCookie = String(response.headers["set-cookie"]);
    expect(rawCookie).toContain("__Host-shareplan_owner=");
    expect(rawCookie).toContain("HttpOnly");
    expect(rawCookie).toContain("Secure");
    expect(rawCookie).toContain("SameSite=Strict");
    expect(rawCookie).not.toContain("Domain=");
    expect(rawCookie).not.toContain(admin);
    const cookie = rawCookie.split(";")[0]!;
    const session = db.prepare("SELECT * FROM owner_sessions").get()!;
    expect(session.token_hash).toBe(hashApiKey(cookie.split("=")[1]!));
    const dashboard = await app.inject({ url: "/owner", headers: { ...headers, cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("No sites yet.");
    expect(dashboard.body).not.toContain(admin);
    expect((await app.inject({ url: "/api/v1/admin/stats", headers: { ...headers, cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/owner/logout", headers: { ...headers, cookie } })).statusCode).toBe(303);
    expect((await app.inject({ url: "/api/v1/admin/stats", headers: { ...headers, cookie } })).statusCode).toBe(401);
    expect(db.prepare("SELECT * FROM owner_sessions").all()).toHaveLength(0);
  });

  it("rejects cross-origin forms, missing origins, unexpected hosts, and site-host access", async () => {
    const { app } = await setup();
    for (const origin of [undefined, "https://attacker.example", "https://site.share.example.com"]) {
      expect((await app.inject({ method: "POST", url: "/owner/login", headers: { host: headers.host, ...(origin ? { origin } : {}) }, payload: { token: admin } })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: "/owner/login", headers: { host: "elsewhere.example" } })).statusCode).toBe(404);
    const cookie = await login(app);
    expect((await app.inject({ method: "POST", url: "/owner/logout", headers: { ...headers, cookie, origin: "https://site.share.example.com" } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/v1/admin/stats", headers: { ...headers, cookie, host: "missing.share.example.com" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/owner/login", headers: { ...headers, host: "missing.share.example.com" }, payload: { token: admin } })).statusCode).toBe(405);
  });

  it("disables owner sessions without isolation, without credentials, or over public HTTP", async () => {
    for (const override of [{ siteHostSuffix: null }, { adminTokenHash: null }, { publicBaseUrl: "http://share.example.com" }]) {
      const { app } = await setup(override);
      expect((await app.inject({ url: "/owner/login", headers })).statusCode).toBe(503);
    }
  });

  it("expires sessions, invalidates them on credential rotation, and limits login attempts", async () => {
    const { app, db, config } = await setup();
    let cookie = await login(app);
    db.prepare("UPDATE owner_sessions SET expires_at = ?").run(Date.now() - 1);
    expect((await app.inject({ url: "/api/v1/admin/stats", headers: { ...headers, cookie } })).statusCode).toBe(401);
    cookie = await login(app);
    config.adminTokenHash = hashApiKey("replacement-secret");
    expect((await app.inject({ url: "/api/v1/admin/stats", headers: { ...headers, cookie } })).statusCode).toBe(401);
    for (let i = 0; i < 8; i++) {
      expect((await app.inject({ method: "POST", url: "/owner/login", headers, payload: { token: "incorrect" } })).statusCode).toBe(401);
    }
    const limited = await app.inject({ method: "POST", url: "/owner/login", headers, payload: { token: "incorrect" } });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("reports real publishes, retained storage, expiry, claims, and deletions without exposing secrets", async () => {
    const { app, db, s3, config } = await setup({ versionRetention: 1 });
    createOpsKey(db, { name: "publisher", token: publishingToken });
    const cookie = await login(app);
    const readStats = async () => (await app.inject({ url: "/api/v1/admin/stats", headers: { ...headers, cookie } })).json();
    const empty = await readStats();
    expect(empty.sites.total).toBe(0);
    expect(empty.versions.retainedBytes).toBe(0);
    expect(empty.activity).toHaveLength(30);
    const registered = (await app.inject({ method: "POST", url: "/api/v1/register", headers, payload: { name: "agent" } })).json();
    // Claim records are written by the existing WorkOS callback, covered in app.test.ts.
    db.prepare("UPDATE users SET claimed_at = ?, tier = 'free', email = ? WHERE id = ?").run(Date.now(), "private@example.com", registered.userId);
    const publishHeaders = { ...headers, authorization: `Bearer ${publishingToken}` };
    const created = await app.inject({ method: "POST", url: "/api/v1/sites", headers: publishHeaders, payload: { title: '<script>alert("oops")</script>', ttl: "1d", files: [{ path: "index.html", content: "first" }] } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await app.inject({ method: "PUT", url: `/api/v1/sites/${id}`, headers: publishHeaders, payload: { files: [{ path: "index.html", content: "second version" }] } })).statusCode).toBe(200);
    const stats = await readStats();
    expect(stats.accounts).toMatchObject({ total: 2, customers: 1, claimed: 1 });
    expect(stats.sites).toMatchObject({ total: 1, active: 1, expiringNext7Days: 1, currentBytes: 14 });
    expect(stats.versions).toEqual({ publishes: 2, retained: 1, retainedBytes: 14 });
    expect(stats.activity.reduce((sum: number, day: { publishes: number }) => sum + day.publishes, 0)).toBe(2);
    expect(stats.tiers.find((t: { tier: string }) => t.tier === "free").count).toBe(1);
    expect(JSON.stringify(stats)).not.toContain("private@example.com");
    expect(JSON.stringify(stats)).not.toContain(registered.token);
    const dashboard = await app.inject({ url: "/owner", headers: { ...headers, cookie } });
    expect(dashboard.body).toContain("&lt;script&gt;");
    expect(dashboard.body).not.toContain('<script>alert("oops")</script>');
    db.prepare("UPDATE sites SET expires_at = ? WHERE id = ?").run(Date.now() - 1, id);
    expect((await readStats()).sites).toMatchObject({ active: 0, expired: 1, expiringNext7Days: 0 });
    await reapExpiredSites({ config, db, s3: s3.client });
    const reaped = await readStats();
    expect(reaped.sites.total).toBe(0);
    expect(reaped.versions.retainedBytes).toBe(0);
    expect(reaped.versions.publishes).toBe(0);
  });
});
