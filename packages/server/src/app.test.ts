import { afterEach, describe, expect, it } from "vitest";
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from "fastify";
import net from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import {
  createApiKeyRecord,
  createOpsKey,
  createUser,
  hashApiKey,
  openDb,
} from "./db.js";
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
    siteHostSuffix: null,
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
    adminTokenHash: hashApiKey(ADMIN),
    ipHashPepper: "test-pepper",
    trustForwarded: false,
    registerPerDay: 10,
    versionRetention: 2,
    reapIntervalMs: 0,
    ...overrides,
  };

  const db = openDb(":memory:");
  const s3 = createFakeS3();
  const app = await buildApp({ config, db, s3: s3.client, logger: false });
  const { key } = createOpsKey(db, { name: "test", token: TOKEN });

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

type Send = (cmd: { constructor: { name: string } }) => Promise<unknown>;

/** Makes every upload fail, so publishes die halfway through. */
function breakUploads(s3: FakeS3): void {
  const stub = s3.client as unknown as { send: Send };
  const original = stub.send;
  stub.send = (cmd) => {
    if (cmd.constructor.name === "PutObjectCommand") {
      return Promise.reject(new Error("s3 unavailable"));
    }
    return original(cmd);
  };
}

/** Holds uploads open long enough for two publishes to interleave. */
function slowUploads(s3: FakeS3, ms = 20): void {
  const stub = s3.client as unknown as { send: Send };
  const original = stub.send;
  stub.send = async (cmd) => {
    if (cmd.constructor.name === "PutObjectCommand") {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return original(cmd);
  };
}

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

    const redirect = await inject(app, { method: "GET", url: `/s/${site.id}/docs` });
    expect(redirect.statusCode).toBe(302);

    const res = await inject(app, {
      method: "GET",
      url: redirect.headers.location as string,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("docs");
  });

  it("does not loop on an encoded id in path mode", async () => {
    const { app } = await setup();
    for (const url of ["/s/a%20b/", "/s/a%2Fb/", "/s/a%23b/index.html"]) {
      const res = await inject(app, { method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers.location, url).toBeUndefined();
    }
  });

  it("keeps the query on the bare /s/:id redirect in path mode", async () => {
    const { app } = await setup();
    const res = await inject(app, { method: "GET", url: "/s/abc?q=1" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/s/abc/?q=1");
  });

  it("redirects a directory hit to its trailing-slash URL", async () => {
    const { app } = await setup();
    const site = (
      await publish(app, {
        files: [
          { path: "index.html", content: "root" },
          { path: "docs/index.html", content: `<link href="./style.css">` },
          { path: "docs/style.css", content: "body{}" },
        ],
      })
    ).json<{ id: string }>();

    // Serving the index at the slash-less URL would resolve "./style.css"
    // against /s/:id/ instead of /s/:id/docs/.
    const res = await inject(app, { method: "GET", url: `/s/${site.id}/docs` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/s/${site.id}/docs/`);
    expect(res.body).not.toContain("style.css");
  });

  it("keeps the slug and query string in the directory redirect", async () => {
    const { app } = await setup();
    await publish(app, {
      slug: "my-plan",
      files: [
        { path: "index.html", content: "root" },
        { path: "docs/index.html", content: "docs" },
      ],
    });

    const res = await inject(app, { method: "GET", url: "/s/my-plan/docs?page=2&q=a b" });
    expect(res.headers.location).toBe("/s/my-plan/docs/?page=2&q=a%20b");
  });

  it("still 404s a directory that has no index.html", async () => {
    const { app } = await setup();
    const site = (
      await publish(app, {
        files: [
          { path: "index.html", content: "root" },
          { path: "docs/style.css", content: "body{}" },
        ],
      })
    ).json<{ id: string }>();

    const res = await inject(app, { method: "GET", url: `/s/${site.id}/docs` });
    expect(res.statusCode).toBe(404);
  });

  it("400s serve paths the sanitizer rejects instead of 500ing", async () => {
    const { app } = await setup();
    const site = (await publish(app, helloSite())).json<{ id: string }>();

    const shapes = [
      "C:foo", // drive letter
      "%5Cwindows%5Csystem32", // backslashes normalize to an absolute path
      "a%00b", // null byte
      "x".repeat(600), // over the 512-char cap
      "..%2Fsecret", // traversal that survives URL normalization
    ];
    for (const shape of shapes) {
      const res = await inject(app, { method: "GET", url: `/s/${site.id}/${shape}` });
      expect(res.statusCode, shape).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("invalid_path");
    }
  });

  it("400s paths that only the second sanitizer pass would reject", async () => {
    const { app } = await setup();
    const site = (await publish(app, helloSite())).json<{ id: string }>();

    // Sanitizing twice is unavoidable here — the route sanitizes, then hands the
    // result to s3ObjectKey, which sanitizes again. These shapes used to survive
    // the first pass and throw on the second, straight into the 500 handler.
    const shapes = [".%2FC:foo", ".%2F.%2FC:foo", ".%2Fx:y%2Fz", ".%5CC:foo", ".%2FD:"];
    for (const shape of shapes) {
      const res = await inject(app, { method: "GET", url: `/s/${site.id}/${shape}` });
      expect(res.statusCode, shape).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("invalid_path");
    }
  });

  it("400s an uploaded path that only fails on re-sanitize", async () => {
    const { app } = await setup();
    // prepareFiles sanitizes, then putSiteFiles sanitizes again on the way to
    // the S3 key; "./C:foo" cleared the first and threw on the second.
    const res = await publish(app, {
      files: [
        { path: "index.html", content: "<h1>hi</h1>" },
        { path: "./C:foo", content: "x" },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("invalid_path");
  });

  it("lands on the index when the directory redirect goes through the sanitizer", async () => {
    const { app } = await setup();
    const site = (
      await publish(app, {
        files: [
          { path: "index.html", content: "root" },
          { path: "docs/index.html", content: "docs" },
        ],
      })
    ).json<{ id: string }>();

    // The redirect target is the raw request URL, so it only round-trips if the
    // sanitizer normalizes both spellings to the same key.
    const redirect = await inject(app, { method: "GET", url: `/s/${site.id}/docs%20` });
    expect(redirect.statusCode).toBe(302);
    const res = await inject(app, {
      method: "GET",
      url: redirect.headers.location as string,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("docs");
  });

  it("rejects a non-string contentBase64 before it reaches the decoder", async () => {
    const { app } = await setup();
    // prepareFiles trusts the schema for the type, so the schema has to hold it.
    for (const contentBase64 of [123, null, [], {}, true]) {
      const res = await publish(app, { files: [{ path: "a.bin", contentBase64 }] });
      expect(res.statusCode, JSON.stringify(contentBase64)).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("validation_error");
    }
  });

  it("keeps the site's headers on the directory redirect", async () => {
    const { app } = await setup();
    const site = (
      await publish(app, {
        visibility: "private",
        files: [
          { path: "index.html", content: "root" },
          { path: "docs/index.html", content: "docs" },
        ],
      })
    ).json<{ id: string }>();

    const res = await inject(app, {
      method: "GET",
      url: `/s/${site.id}/docs`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["x-robots-tag"]).toContain("noindex");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
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

    createOpsKey(db, { name: "other", token: "sp_other" });
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
    createOpsKey(db, { name: "other", token: "sp_other" });

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

  it("keeps the old slug when the republish upload fails", async () => {
    const { app, s3 } = await setup();
    const site = (
      await publish(app, { ...helloSite("v1"), slug: "before" })
    ).json<{ id: string }>();

    breakUploads(s3);
    const failed = await inject(app, {
      method: "PUT",
      url: `/api/v1/sites/${site.id}`,
      headers: auth(),
      payload: { ...helloSite("v2"), slug: "after" },
    });
    expect(failed.statusCode).toBe(500);

    // The site is still reachable where it was before the failed publish.
    expect((await inject(app, { method: "GET", url: "/s/before/" })).statusCode).toBe(200);
    expect((await inject(app, { method: "GET", url: "/s/after/" })).statusCode).toBe(404);

    const row = await inject(app, {
      method: "GET",
      url: `/api/v1/sites/${site.id}`,
      headers: auth(),
    });
    expect(row.json<{ slug: string | null }>().slug).toBe("before");
  });

  it("409s the loser when two republishes race for one slug", async () => {
    const { app, s3 } = await setup();
    const rename = async (id: string, body: object) =>
      inject(app, {
        method: "PUT",
        url: `/api/v1/sites/${id}`,
        headers: auth(),
        payload: body,
      });

    const a = (await publish(app, { ...helloSite(), slug: "a" })).json<{ id: string }>();
    const b = (await publish(app, { ...helloSite(), slug: "b" })).json<{ id: string }>();

    // The slug check and the slug write now straddle the upload await, so both
    // requests can pass the check before either writes.
    slowUploads(s3);
    const before = s3.keysUnder("sites/").length;
    const results = await Promise.all([
      rename(a.id, { ...helloSite("a2"), slug: "contested" }),
      rename(b.id, { ...helloSite("b2"), slug: "contested" }),
    ]);

    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409)!;
    expect(loser.json<{ error: { code: string } }>().error.code).toBe("slug_taken");

    // Only the winner's new version survives; the loser's upload is cleaned up
    // rather than stranded where version pruning can never reach it.
    expect(s3.keysUnder("sites/")).toHaveLength(before + 1);
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

describe("request limits", () => {
  it("reports malformed JSON as a 400", async () => {
    const { app } = await setup();
    const res = await inject(app, {
      method: "POST",
      url: "/api/v1/sites",
      headers: { ...auth(), "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("invalid_json");
  });

  it("reports an oversized body as a 413", async () => {
    const { app } = await setup({ maxSiteBytes: 1000 });
    const res = await inject(app, {
      method: "POST",
      url: "/api/v1/sites",
      headers: { ...auth(), "content-type": "application/json" },
      payload: "x".repeat((app.initialConfig.bodyLimit ?? 0) + 1024),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("payload_too_large");
  });

  it("reports a content type it cannot parse as a 415", async () => {
    const { app } = await setup();
    const res = await inject(app, {
      method: "POST",
      url: "/api/v1/sites",
      headers: { ...auth(), "content-type": "application/xml" },
      payload: "<files/>",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json<{ error: { code: string } }>().error.code).toBe(
      "unsupported_media_type",
    );
  });

  it("keeps an internal error opaque even when it carries a status code", async () => {
    const { app } = await setup();
    // Storage and database clients attach their own statusCode; trusting it
    // would hand the client an upstream's message verbatim, unlogged.
    app.get("/test-internal-error", async () => {
      throw Object.assign(new Error("AccessDenied: bucket policy xyz"), {
        statusCode: 403,
        code: "AccessDenied",
      });
    });

    const res = await inject(app, { method: "GET", url: "/test-internal-error" });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("internal_error");
    expect(res.body).not.toContain("bucket policy");
  });

  it("accepts a base64 bundle that fills maxSiteBytes", async () => {
    // Binary reaches us as base64 — 4 characters per 3 bytes — so a transport
    // limit sized off the decoded budget rejects sites prepareFiles allows.
    const maxSiteBytes = 8 * 1024 * 1024;
    const { app } = await setup({ maxSiteBytes });
    const res = await publish(app, {
      files: [
        { path: "big.png", contentBase64: Buffer.alloc(maxSiteBytes - 4096, 7).toString("base64") },
      ],
    });
    expect(res.statusCode).toBe(201);
  });

  it("still enforces maxSiteBytes on decoded bytes", async () => {
    const { app } = await setup({ maxSiteBytes: 1000 });
    const res = await publish(app, {
      files: [
        { path: "index.html", content: "<h1>hi</h1>" },
        { path: "big.png", contentBase64: Buffer.alloc(2000).toString("base64") },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("site_too_large");
  });
});


describe("hostname serving", () => {
  const SUFFIX = "sites.test";
  const host = (label: string) => ({ host: `${label}.${SUFFIX}` });

  async function setupHosted() {
    const h = await setup({ siteHostSuffix: SUFFIX, publicBaseUrl: "https://api.test" });
    const res = await publish(h.app, {
      title: "hosted",
      files: [
        { path: "index.html", content: "root" },
        { path: "docs/index.html", content: "docs" },
        { path: "style.css", content: "body{}" },
      ],
    });
    expect(res.statusCode).toBe(201);
    return { ...h, site: res.json<{ id: string; url: string }>() };
  }

  it("returns subdomain urls from the api", async () => {
    const { site } = await setupHosted();
    expect(site.url).toBe(`https://${site.id}.${SUFFIX}/`);
  });

  it("serves the site from its own host", async () => {
    const { app, site } = await setupHosted();
    const index = await inject(app, { method: "GET", url: "/", headers: host(site.id) });
    expect(index.statusCode).toBe(200);
    expect(index.body).toBe("root");

    const css = await inject(app, { method: "GET", url: "/style.css", headers: host(site.id) });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");

    const nested = await inject(app, { method: "GET", url: "/docs/", headers: host(site.id) });
    expect(nested.statusCode).toBe(200);
    expect(nested.body).toBe("docs");
  });

  it("redirects a directory hit on the site host without the /s/ prefix", async () => {
    const { app, site } = await setupHosted();
    const res = await inject(app, { method: "GET", url: "/docs?x=1", headers: host(site.id) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/docs/?x=1");
  });

  it("matches the host case-insensitively and with a port", async () => {
    const { app, site } = await setupHosted();
    const res = await inject(app, {
      method: "GET",
      url: "/",
      headers: { host: `${site.id.toUpperCase()}.${SUFFIX}:8788` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("root");
  });

  it("serves by slug on the site host", async () => {
    const { app } = await setupHosted();
    await publish(app, { ...helloSite("slugged"), slug: "my-plan" });
    const res = await inject(app, { method: "GET", url: "/", headers: host("my-plan") });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("slugged");
  });

  it("hides the api from site hosts", async () => {
    const { app, site } = await setupHosted();
    for (const url of ["/healthz", "/api/v1/sites", "/docs/agents"]) {
      const res = await inject(app, { method: "GET", url, headers: { ...host(site.id), ...auth() } });
      // Anything under a site host is looked up as a file of that site.
      expect(res.statusCode, url).toBe(404);
      expect(res.json<{ error: { message: string } }>().error.message).toBe("file not found");
    }
    const post = await inject(app, {
      method: "POST",
      url: "/api/v1/sites",
      headers: { ...host(site.id), ...auth() },
      payload: helloSite(),
    });
    expect(post.statusCode).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
  });

  it("keeps the api on the apex host", async () => {
    const { app } = await setupHosted();
    const res = await inject(app, { method: "GET", url: "/healthz", headers: { host: SUFFIX } });
    expect(res.statusCode).toBe(200);
    const deeper = await inject(app, {
      method: "GET",
      url: "/healthz",
      headers: { host: `a.b.${SUFFIX}` },
    });
    expect(deeper.statusCode, "multi-label hosts are not site hosts").toBe(200);
  });

  it("redirects old /s/ links to the site host", async () => {
    const { app, site } = await setupHosted();
    const cases: [string, string][] = [
      [`/s/${site.id}`, `https://${site.id}.${SUFFIX}/`],
      [`/s/${site.id}/`, `https://${site.id}.${SUFFIX}/`],
      [`/s/${site.id}/?q=1`, `https://${site.id}.${SUFFIX}/?q=1`],
      [`/s/${site.id}/docs/style.css?v=2`, `https://${site.id}.${SUFFIX}/docs/style.css?v=2`],
      [`/s/${site.id.toUpperCase()}/`, `https://${site.id}.${SUFFIX}/`],
    ];
    for (const [url, location] of cases) {
      const res = await inject(app, { method: "GET", url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe(location);
    }
  });

  it("sends reserved labels like www to the api host", async () => {
    const { app } = await setupHosted();
    for (const label of ["www", "api", "admin"]) {
      const res = await inject(app, { method: "GET", url: "/", headers: host(label) });
      expect(res.statusCode, label).toBe(302);
      expect(res.headers.location, label).toBe("https://api.test/");
    }
  });

  it("rejects slugs that cannot be hostnames, in either mode", async () => {
    for (const h of [await setupHosted(), await setup()]) {
      for (const slug of ["MyPlan", "-lead", "trail-", "a".repeat(64)]) {
        const bad = await publish(h.app, { ...helloSite(), slug });
        expect(bad.statusCode, slug).toBe(400);
        expect(bad.json<{ error: { code: string } }>().error.code).toBe("validation_error");
      }

      const reserved = await publish(h.app, { ...helloSite(), slug: "www" });
      expect(reserved.statusCode).toBe(409);
      expect(reserved.json<{ error: { code: string } }>().error.code).toBe("slug_taken");
    }
  });

  it("keeps a legacy mixed-case slug reachable from its lowercase host", async () => {
    const { app, db } = await setupHosted();
    const site = (await publish(app, helloSite("legacy"))).json<{ id: string }>();
    // Stored before slugs were forced lowercase.
    db.prepare(`UPDATE sites SET slug = ? WHERE id = ?`).run("MyPlan", site.id);

    const served = await inject(app, { method: "GET", url: "/", headers: host("myplan") });
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe("legacy");

    const legacyLink = await inject(app, { method: "GET", url: "/s/MyPlan/" });
    expect(legacyLink.headers.location).toBe(`https://myplan.${SUFFIX}/`);

    // And nobody else can claim the lowercase form out from under it.
    const clash = await publish(app, { ...helloSite(), slug: "myplan" });
    expect(clash.statusCode).toBe(409);
    // Not even by writing around the API: the index is case-insensitive.
    expect(() =>
      db.prepare(`UPDATE sites SET slug = 'MYPLAN' WHERE id <> ?`).run(site.id),
    ).toThrow(/UNIQUE/);
  });

  it("treats a trailing-dot or ported host as the same site host", async () => {
    const { app, site } = await setupHosted();
    for (const h of [
      `${site.id}.${SUFFIX}.`,
      `${site.id}.${SUFFIX}.:443`,
      ` ${site.id}.${SUFFIX}:8788 `,
    ]) {
      const page = await inject(app, { method: "GET", url: "/", headers: { host: h } });
      expect(page.statusCode, h).toBe(200);
      expect(page.body, h).toBe("root");
      const api = await inject(app, { method: "GET", url: "/healthz", headers: { host: h } });
      expect(api.statusCode, `${h} must not reach the api`).toBe(404);
    }
  });

  it("refuses legacy ids that could steer the redirect off the suffix", async () => {
    const { app } = await setupHosted();
    for (const id of ["evil.example%23", "evil.example", "a%2Fb", "x%3Ay", "%20", "a%2Eb"]) {
      for (const url of [`/s/${id}`, `/s/${id}/`, `/s/${id}/index.html`]) {
        const res = await inject(app, { method: "GET", url });
        expect(res.statusCode, url).toBe(404);
        expect(res.headers.location, url).toBeUndefined();
      }
    }
  });

  it("serves percent-encoded file names on the site host", async () => {
    const h = await setup({ siteHostSuffix: SUFFIX, publicBaseUrl: "https://api.test" });
    const res = await publish(h.app, {
      title: "encoded",
      files: [
        { path: "index.html", content: "root" },
        { path: "my file.txt", content: "spaced" },
        { path: "日.html", content: "<p>sun</p>" },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json<{ id: string }>();
    const spaced = await inject(h.app, { method: "GET", url: "/my%20file.txt", headers: host(id) });
    expect(spaced.statusCode).toBe(200);
    expect(spaced.body).toBe("spaced");
    const sun = await inject(h.app, { method: "GET", url: "/%E6%97%A5.html", headers: host(id) });
    expect(sun.statusCode).toBe(200);
    const broken = await inject(h.app, { method: "GET", url: "/%E6%97", headers: host(id) });
    expect(broken.statusCode).toBe(400);
  });

  it("re-encodes the path in a legacy redirect instead of pasting it decoded", async () => {
    const { app, site } = await setupHosted();
    const cases: [string, string][] = [
      [`/s/${site.id}/my%20file.txt`, `https://${site.id}.${SUFFIX}/my%20file.txt`],
      [`/s/${site.id}/%E6%97%A5.html`, `https://${site.id}.${SUFFIX}/%E6%97%A5.html`],
      [`/s/${site.id}/a%23b`, `https://${site.id}.${SUFFIX}/a%23b`],
      [`/s/${site.id}/docs/%3Fx`, `https://${site.id}.${SUFFIX}/docs/%3Fx`],
    ];
    for (const [url, location] of cases) {
      const res = await inject(app, { method: "GET", url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe(location);
    }
  });

  it("keeps the path and query when bouncing a reserved label to the api host", async () => {
    const { app } = await setupHosted();
    const res = await inject(app, { method: "GET", url: "/docs/agents?x=1", headers: host("www") });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://api.test/docs/agents?x=1");
  });

  it("never turns a directory redirect into a scheme-relative location", async () => {
    const h = await setup({ siteHostSuffix: SUFFIX, publicBaseUrl: "https://api.test" });
    const res = await publish(h.app, {
      title: "trap",
      files: [
        { path: "index.html", content: "root" },
        { path: "evil.example/index.html", content: "x" },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json<{ id: string }>();
    // inject() would parse "//evil.example" as a host, so go over a socket.
    const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(address).port);
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(`GET //evil.example HTTP/1.1\r\nHost: ${id}.${SUFFIX}\r\nConnection: close\r\n\r\n`);
      });
      let buf = "";
      sock.on("data", (d) => (buf += d.toString()));
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
    });
    expect(raw).toMatch(/^HTTP\/1.1 302/);
    expect(raw).toMatch(/^location: \/evil\.example\/\r$/im);
  });

  it("keeps the query on a bare /s/:id redirect", async () => {
    const { app, site } = await setupHosted();
    const res = await inject(app, { method: "GET", url: `/s/${site.id}?q=1&r=2` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://${site.id}.${SUFFIX}/?q=1&r=2`);
  });

  it("describes site urls on the landing page with the api scheme", async () => {
    const http = await setup({ siteHostSuffix: SUFFIX, publicBaseUrl: "http://localhost:8788" });
    const page = await inject(http.app, { method: "GET", url: "/" });
    expect(page.body).toContain(`http://:id.${SUFFIX}/`);
    expect(page.body).not.toContain(`https://:id.${SUFFIX}/`);
  });

  it("uses http site urls when the api base is http", async () => {
    const h = await setup({ siteHostSuffix: SUFFIX, publicBaseUrl: "http://localhost:8788" });
    const res = await publish(h.app, helloSite());
    const { id, url } = res.json<{ id: string; url: string }>();
    expect(url).toBe(`http://${id}.${SUFFIX}/`);
  });
});

describe("register and tiers", () => {
  async function register(
    app: FastifyInstance,
    name = "claude",
    ip = "203.0.113.10",
  ) {
    return inject(app, {
      method: "POST",
      url: "/api/v1/register",
      payload: { name },
      remoteAddress: ip,
    });
  }

  it("returns a free-- token", async () => {
    const { app } = await setup();
    const res = await register(app);
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      token: string;
      tier: string;
      userId: string;
      keyId: string;
      claimUrl: string;
    }>();
    expect(body.token.startsWith("sp_")).toBe(true);
    expect(body.tier).toBe("free--");
    expect(body.claimUrl).toContain("/claim/");
  });

  it("rate-limits register by IP", async () => {
    const { app } = await setup({ registerPerDay: 1 });
    expect((await register(app)).statusCode).toBe(201);
    const second = await register(app);
    expect(second.statusCode).toBe(429);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("rate_limited");
  });

  it("defaults free-- ttl to 7d", async () => {
    const { app } = await setup();
    const token = (await register(app)).json<{ token: string }>().token;
    const before = Date.now();
    const created = await publish(app, helloSite(), token);
    expect(created.statusCode).toBe(201);
    const { expiresAt } = created.json<{ expiresAt: string }>();
    const exp = Date.parse(expiresAt);
    const week = 7 * 86_400_000;
    expect(exp).toBeGreaterThanOrEqual(before + week - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + week + 1000);
  });

  it("rejects ttl null on free-- and allows it on paid", async () => {
    const { app, db } = await setup();
    const token = (await register(app)).json<{ token: string }>().token;
    const denied = await publish(app, { ...helloSite(), ttl: null }, token);
    expect(denied.statusCode).toBe(400);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe("ttl_not_allowed");

    const paid = createUser(db, { tier: "paid" });
    createApiKeyRecord(db, { name: "paid", token: "sp_paid", userId: paid.id });
    const ok = await publish(app, { ...helloSite(), ttl: null }, "sp_paid");
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ expiresAt: string | null }>().expiresAt).toBeNull();
  });

  it("rejects slugs and public visibility on free--", async () => {
    const { app } = await setup();
    const token = (await register(app)).json<{ token: string }>().token;
    const slug = await publish(app, { ...helloSite(), slug: "my-plan" }, token);
    expect(slug.statusCode).toBe(400);
    expect(slug.json<{ error: { code: string } }>().error.code).toBe("slug_not_allowed");
    const vis = await publish(app, { ...helloSite(), visibility: "public" }, token);
    expect(vis.statusCode).toBe(400);
    expect(vis.json<{ error: { code: string } }>().error.code).toBe(
      "visibility_not_allowed",
    );
  });

  it("touches expiry without writing objects", async () => {
    const { app, s3 } = await setup();
    const token = (await register(app)).json<{ token: string }>().token;
    const site = (await publish(app, helloSite(), token)).json<{
      id: string;
      expiresAt: string;
    }>();
    const keysBefore = s3.keysUnder(`sites/${site.id}/`).length;
    const touched = await inject(app, {
      method: "POST",
      url: `/api/v1/sites/${site.id}/touch`,
      headers: auth(token),
    });
    expect(touched.statusCode).toBe(200);
    const { expiresAt } = touched.json<{ expiresAt: string }>();
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.parse(site.expiresAt));
    expect(s3.keysUnder(`sites/${site.id}/`)).toHaveLength(keysBefore);
  });

  it("lists sites across keys of the same user", async () => {
    const { app, db } = await setup();
    const token = (await register(app)).json<{ token: string; userId: string }>();
    await publish(app, helloSite("one"), token.token);
    createApiKeyRecord(db, { name: "two", token: "sp_two", userId: token.userId });
    const listed = await inject(app, {
      method: "GET",
      url: "/api/v1/sites",
      headers: auth("sp_two"),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ sites: unknown[] }>().sites).toHaveLength(1);
  });

  it("rejects disallowed file types", async () => {
    const { app } = await setup();
    const res = await publish(app, {
      files: [{ path: "clip.mp4", contentBase64: "AAAA" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe(
      "file_type_not_allowed",
    );
  });

  it("does not cap ttl for admin-minted ops keys", async () => {
    const { app } = await setup();
    const created = await publish(app, helloSite());
    expect(created.statusCode).toBe(201);
    expect(created.json<{ expiresAt: string | null }>().expiresAt).toBeNull();
  });
});
