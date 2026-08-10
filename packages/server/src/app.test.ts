import { afterEach, describe, expect, it } from "vitest";
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { createApiKeyRecord, openDb } from "./db.js";
import { reapExpiredSites } from "./reap.js";
import { createFakeS3, type FakeS3 } from "./testing/fake-s3.js";

const TOKEN = "sp_test_token";
const ADMIN = "admin-token";

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  s3: FakeS3;
  config: Config;
  keyId: string;
}

const open: Harness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.app.close();
    h.db.close();
  }
});

async function setup(overrides: Partial<Config> = {}): Promise<Harness> {
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://test.local",
    dataDir: "/tmp",
    dbPath: ":memory:",
    s3: {
      region: "auto",
      bucket: "test",
      accessKeyId: "a",
      secretAccessKey: "b",
      forcePathStyle: true,
    },
    maxSiteBytes: 1_000_000,
    maxFileCount: 20,
    defaultTtl: null,
    adminToken: ADMIN,
    versionRetention: 2,
    reapIntervalMs: 0,
    ...overrides,
  };

  const db = openDb(":memory:");
  const s3 = createFakeS3();
  const app = await buildApp({ config, db, s3: s3.client, logger: false });
  const key = createApiKeyRecord(db, { name: "test", token: TOKEN });

  const harness: Harness = { app, db, s3, config, keyId: key.id };
  open.push(harness);
  return harness;
}

const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

/** Narrows fastify's chainable inject() overloads to the promise form. */
function inject(
  app: FastifyInstance,
  opts: InjectOptions,
): Promise<LightMyRequestResponse> {
  return app.inject(opts);
}

function publish(
  app: FastifyInstance,
  body: object,
  token = TOKEN,
): Promise<LightMyRequestResponse> {
  return inject(app, {
    method: "POST",
    url: "/api/v1/sites",
    headers: auth(token),
    payload: body,
  });
}

const helloSite = (html = "<h1>hello</h1>") => ({
  title: "demo",
  files: [{ path: "index.html", content: html }],
});

describe("auth", () => {
  it("rejects requests without a token", async () => {
    const { app } = await setup();
    const res = await inject(app, {
      method: "POST",
      url: "/api/v1/sites",
      payload: helloSite(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked key", async () => {
    const { app, db, keyId } = await setup();
    db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).run(
      Date.now(),
      keyId,
    );
    const res = await publish(app, helloSite());
    expect(res.statusCode).toBe(401);
  });
});

describe("publish and serve", () => {
  it("creates a site and serves its index", async () => {
    const { app, config } = await setup();
    const created = await publish(app, helloSite());
    expect(created.statusCode).toBe(201);

    const site = created.json<{ id: string; url: string; fileCount: number }>();
    expect(site.url).toBe(`${config.publicBaseUrl}/s/${site.id}/`);
    expect(site.fileCount).toBe(1);

    const served = await inject(app, { method: "GET", url: `/s/${site.id}/` });
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe("<h1>hello</h1>");
    expect(served.headers["content-type"]).toContain("text/html");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("marks unlisted sites noindex and public sites indexable", async () => {
    const { app } = await setup();
    const unlisted = (await publish(app, helloSite())).json<{ id: string }>();
    const pub = (
      await publish(app, { ...helloSite(), visibility: "public" })
    ).json<{ id: string }>();

    const a = await inject(app, { method: "GET", url: `/s/${unlisted.id}/` });
    const b = await inject(app, { method: "GET", url: `/s/${pub.id}/` });
    expect(a.headers["x-robots-tag"]).toContain("noindex");
    expect(b.headers["x-robots-tag"]).not.toContain("noindex");
  });

  it("rejects traversal in uploaded paths", async () => {
    const { app } = await setup();
    const res = await publish(app, {
      files: [{ path: "../escape.html", content: "x" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("invalid_path");
  });

  it("404s an unknown file inside a real site", async () => {
    const { app } = await setup();
    const site = (await publish(app, helloSite())).json<{ id: string }>();
    const res = await inject(app, { method: "GET", url: `/s/${site.id}/nope.css` });
    expect(res.statusCode).toBe(404);
  });

  it("serves nested directories via their index.html", async () => {
    const { app } = await setup();
    const site = (
      await publish(app, {
        files: [
          { path: "index.html", content: "root" },
          { path: "docs/index.html", content: "docs" },
        ],
      })
    ).json<{ id: string }>();

    const res = await inject(app, { method: "GET", url: `/s/${site.id}/docs` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("docs");
  });
});

describe("versions", () => {
  it("republishes and serves the new content", async () => {
    const { app } = await setup();
    const site = (await publish(app, helloSite("v1"))).json<{
      id: string;
      versionId: string;
    }>();

    const updated = await inject(app, {
      method: "PUT",
      url: `/api/v1/sites/${site.id}`,
      headers: auth(),
      payload: helloSite("v2"),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ versionId: string }>().versionId).not.toBe(site.versionId);

    const served = await inject(app, { method: "GET", url: `/s/${site.id}/` });
    expect(served.body).toBe("v2");
  });

  it("keeps the previous version's objects but prunes older ones", async () => {
    const { app, s3 } = await setup({ versionRetention: 1 });
    const site = (await publish(app, helloSite("v1"))).json<{
      id: string;
      versionId: string;
    }>();
    expect(s3.keysUnder(`sites/${site.id}/v/${site.versionId}/`)).toHaveLength(1);

    await inject(app, {
      method: "PUT",
      url: `/api/v1/sites/${site.id}`,
      headers: auth(),
      payload: helloSite("v2"),
    });

    // retention of 1 keeps only the live version
    expect(s3.keysUnder(`sites/${site.id}/v/${site.versionId}/`)).toHaveLength(0);
    expect(s3.keysUnder(`sites/${site.id}/`)).toHaveLength(1);

    const served = await inject(app, { method: "GET", url: `/s/${site.id}/` });
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe("v2");
  });

  it("never prunes the version currently being served", async () => {
    const { app, s3 } = await setup({ versionRetention: 0 });
    const site = (await publish(app, helloSite("v1"))).json<{ id: string }>();
    await inject(app, {
      method: "PUT",
      url: `/api/v1/sites/${site.id}`,
      headers: auth(),
      payload: helloSite("v2"),
    });

    expect(s3.keysUnder(`sites/${site.id}/`)).toHaveLength(1);
    const served = await inject(app, { method: "GET", url: `/s/${site.id}/` });
    expect(served.body).toBe("v2");
  });
});

describe("visibility", () => {
  it("requires the owner's key for private sites", async () => {
    const { app, db } = await setup();
    const site = (
      await publish(app, { ...helloSite(), visibility: "private" })
    ).json<{ id: string }>();

    const anon = await inject(app, { method: "GET", url: `/s/${site.id}/` });
    expect(anon.statusCode).toBe(401);

    const owner = await inject(app, {
      method: "GET",
      url: `/s/${site.id}/`,
      headers: auth(),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers["cache-control"]).toContain("private");

    createApiKeyRecord(db, { name: "other", token: "sp_other" });
    const other = await inject(app, {
      method: "GET",
      url: `/s/${site.id}/`,
      headers: auth("sp_other"),
    });
    expect(other.statusCode).toBe(404);
  });

  it("hides other owners' sites from the API", async () => {
    const { app, db } = await setup();
    const site = (await publish(app, helloSite())).json<{ id: string }>();
    createApiKeyRecord(db, { name: "other", token: "sp_other" });

    const res = await inject(app, {
      method: "GET",
      url: `/api/v1/sites/${site.id}`,
      headers: auth("sp_other"),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("slugs", () => {
  it("serves a site by its slug", async () => {
    const { app } = await setup();
    await publish(app, { ...helloSite("slugged"), slug: "my-plan" });
    const res = await inject(app, { method: "GET", url: "/s/my-plan/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("slugged");
  });

  it("rejects a slug that is already taken", async () => {
    const { app } = await setup();
    await publish(app, { ...helloSite(), slug: "taken" });
    const res = await publish(app, { ...helloSite(), slug: "taken" });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("slug_taken");
  });

  it("rejects a slug that collides with an existing site id", async () => {
    const { app } = await setup();
    const site = (await publish(app, helloSite())).json<{ id: string }>();
    const res = await publish(app, { ...helloSite(), slug: site.id });
    expect(res.statusCode).toBe(409);
  });
});

describe("expiry", () => {
  it("returns 410 once a site has expired", async () => {
    const { app, db } = await setup();
    const site = (await publish(app, { ...helloSite(), ttl: "1h" })).json<{
      id: string;
      expiresAt: string;
    }>();
    expect(site.expiresAt).not.toBeNull();

    db.prepare(`UPDATE sites SET expires_at = ? WHERE id = ?`).run(
      Date.now() - 1000,
      site.id,
    );
    const res = await inject(app, { method: "GET", url: `/s/${site.id}/` });
    expect(res.statusCode).toBe(410);
  });

  it("keeps an existing expiry across a republish", async () => {
    const { app } = await setup();
    const site = (await publish(app, { ...helloSite(), ttl: "1h" })).json<{
      id: string;
      expiresAt: string;
    }>();

    const updated = await inject(app, {
      method: "PUT",
      url: `/api/v1/sites/${site.id}`,
      headers: auth(),
      payload: helloSite("v2"),
    });
    expect(updated.json<{ expiresAt: string }>().expiresAt).toBe(site.expiresAt);
  });

  it("clears the expiry when ttl is explicitly null", async () => {
    const { app } = await setup();
    const site = (await publish(app, { ...helloSite(), ttl: "1h" })).json<{
      id: string;
    }>();

    const updated = await inject(app, {
      method: "PUT",
      url: `/api/v1/sites/${site.id}`,
      headers: auth(),
      payload: { ...helloSite("v2"), ttl: null },
    });
    expect(updated.json<{ expiresAt: string | null }>().expiresAt).toBeNull();
  });

  it("rejects an unparseable ttl", async () => {
    const { app } = await setup();
    const res = await publish(app, { ...helloSite(), ttl: "soon" });
    expect(res.statusCode).toBe(400);
  });

  it("reaps expired sites and their objects", async () => {
    const { app, db, s3, config } = await setup();
    const live = (await publish(app, helloSite())).json<{ id: string }>();
    const dead = (await publish(app, { ...helloSite(), ttl: "1h" })).json<{
      id: string;
    }>();
    db.prepare(`UPDATE sites SET expires_at = ? WHERE id = ?`).run(
      Date.now() - 1000,
      dead.id,
    );

    const result = await reapExpiredSites({ config, db, s3: s3.client });
    expect(result.sites).toBe(1);
    expect(s3.keysUnder(`sites/${dead.id}/`)).toHaveLength(0);
    expect(s3.keysUnder(`sites/${live.id}/`)).toHaveLength(1);

    const res = await inject(app, { method: "GET", url: `/s/${dead.id}/` });
    expect(res.statusCode).toBe(404);
  });
});

describe("delete", () => {
  it("removes the site and its objects", async () => {
    const { app, s3 } = await setup();
    const site = (await publish(app, helloSite())).json<{ id: string }>();

    const res = await inject(app, {
      method: "DELETE",
      url: `/api/v1/sites/${site.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    expect(s3.keysUnder(`sites/${site.id}/`)).toHaveLength(0);

    const served = await inject(app, { method: "GET", url: `/s/${site.id}/` });
    expect(served.statusCode).toBe(404);
  });
});

describe("admin keys", () => {
  it("mints, lists, and revokes keys", async () => {
    const { app } = await setup();

    const minted = await inject(app, {
      method: "POST",
      url: "/api/v1/admin/keys",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: "agent" },
    });
    expect(minted.statusCode).toBe(201);
    const key = minted.json<{ id: string; token: string }>();
    expect(key.token).toMatch(/^sp_/);

    // the freshly minted key works
    expect((await publish(app, helloSite(), key.token)).statusCode).toBe(201);

    const listed = await inject(app, {
      method: "GET",
      url: "/api/v1/admin/keys",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(listed.json<{ keys: unknown[] }>().keys).toHaveLength(2);

    const revoked = await inject(app, {
      method: "DELETE",
      url: `/api/v1/admin/keys/${key.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(revoked.statusCode).toBe(204);
    expect((await publish(app, helloSite(), key.token)).statusCode).toBe(401);
  });

  it("refuses a bad admin token", async () => {
    const { app } = await setup();
    const res = await inject(app, {
      method: "POST",
      url: "/api/v1/admin/keys",
      headers: { authorization: "Bearer nope" },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(401);
  });
});
