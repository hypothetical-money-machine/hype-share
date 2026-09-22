import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildApp, type WorkOSAuthClient } from "./app.js";
import type { Config } from "./config.js";
import {
  createApiKeyRecord,
  createOpsKey,
  createUser,
  getUser,
  hashApiKey,
  openDb,
  setUserTier,
} from "./db.js";
import { hashIp } from "./ip.js";
import { ORG_TOKEN_RE } from "./orgs.js";
import { HOUR_MS } from "./rate-limit.js";
import { reapExpiredSites } from "./reap.js";
import { createFakeS3, type FakeS3 } from "./testing/fake-s3.js";

const TOKEN = "sp_test_token";
const ADMIN = "admin-token";
const WORKOS_CONFIG = {
  apiKey: "sk_test",
  clientId: "client_test",
  redirectUri: "http://test.local/v1/auth/workos/callback",
};
const DAY_MS = 86_400_000;
const IP = "203.0.113.10";
// 2023-11-14T22:13:20Z: well inside both an hour and a UTC day, so a
// rate-limit test pinned here can never straddle a window boundary.
const FIXED_NOW = 1_700_000_000_000;

/** Pin Date only, so fastify's inject timers stay real. */
function pinClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
}

// Well-formed but never issued.
const UNKNOWN_ORG_TOKEN = `org_${"A".repeat(43)}`;

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  s3: FakeS3;
  config: Config;
  keyId: string;
}

const open: Harness[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const h of open.splice(0)) {
    await h.app.close();
    h.db.close();
  }
});

async function setup(
  overrides: Partial<Config> = {},
  workos?: WorkOSAuthClient,
): Promise<Harness> {
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
    orgRegisterPerDay: 100,
    versionRetention: 2,
    reapIntervalMs: 0,
    workos: null,
    ...overrides,
  };

  const db = openDb(":memory:");
  const s3 = createFakeS3();
  const app = await buildApp({ config, db, s3: s3.client, logger: false, workos });
  const { key } = createOpsKey(db, { name: "test", token: TOKEN });

  const harness: Harness = { app, db, s3, config, keyId: key.id };
  open.push(harness);
  return harness;
}

interface FakeWorkOS {
  client: WorkOSAuthClient;
  method: string | undefined;
}

function createFakeWorkOS(method: string | undefined = "MagicAuth"): FakeWorkOS {
  let flow = 0;
  const fake: FakeWorkOS = {
    method,
    client: undefined as unknown as WorkOSAuthClient,
  };
  fake.client = {
    userManagement: {
      getAuthorizationUrlWithPKCE: async () => {
        flow += 1;
        return {
          url: `https://auth.test/authorize?flow=${flow}`,
          state: `state_${flow}`,
          codeVerifier: `verifier_${flow}`,
        };
      },
      authenticateWithCode: async () => ({
        user: {
          id: "user_workos",
          email: "Human@Example.com",
          emailVerified: true,
        },
        authenticationMethod: fake.method,
      }),
    },
  };
  return fake;
}

const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
const adminHeaders = { "x-admin-token": ADMIN };

/** Narrows fastify's chainable inject() overloads to the promise form. */
function inject(
  app: FastifyInstance,
  opts: InjectOptions,
): Promise<LightMyRequestResponse> {
  return app.inject(opts);
}

function setCookieHeaders(res: LightMyRequestResponse): string[] {
  const value = res.headers["set-cookie"];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function cookiePair(res: LightMyRequestResponse, name: string): string {
  const line = setCookieHeaders(res).find((value) => value.startsWith(`${name}=`));
  if (!line) throw new Error(`response did not set ${name}`);
  return line.split(";", 1)[0]!;
}

/** Confirm, start, and complete the fake WorkOS claim for a claim URL. */
async function completeClaimFlow(app: FastifyInstance, claimUrl: string): Promise<void> {
  const claimPath = new URL(claimUrl).pathname;
  const confirmation = await inject(app, { method: "GET", url: claimPath });
  const confirmationCookie = cookiePair(confirmation, "shareplan_claim_confirm");
  const start = await inject(app, {
    method: "POST",
    url: claimPath,
    headers: {
      cookie: confirmationCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "",
  });
  expect(start.statusCode).toBe(200);
  const callbackCookie = cookiePair(start, "shareplan_claim_callback");
  const state = /state=(state_\d+)/.exec(start.body)?.[1] ?? "state_1";
  const callback = await inject(app, {
    method: "GET",
    url: `/v1/auth/workos/callback?code=auth_code&state=${state}`,
    headers: { cookie: callbackCookie },
  });
  expect(callback.statusCode).toBe(200);
}

function publish(
  app: FastifyInstance,
  body: object,
  token = TOKEN,
  ip = IP,
): Promise<LightMyRequestResponse> {
  return inject(app, {
    method: "POST",
    url: "/api/v1/sites",
    headers: auth(token),
    payload: body,
    remoteAddress: ip,
  });
}

function register(
  app: FastifyInstance,
  name = "claude",
  ip = IP,
): Promise<LightMyRequestResponse> {
  return inject(app, {
    method: "POST",
    url: "/api/v1/register",
    payload: { name },
    remoteAddress: ip,
  });
}

function registerWithToken(
  app: FastifyInstance,
  orgToken: string,
  name = "agent",
  ip = IP,
): Promise<LightMyRequestResponse> {
  return inject(app, {
    method: "POST",
    url: "/api/v1/register",
    payload: { name, orgToken },
    remoteAddress: ip,
  });
}

const helloSite = (html = "<h1>hello</h1>") => ({
  title: "demo",
  files: [{ path: "index.html", content: html }],
});

interface OrgAdmin {
  id: string;
  name: string;
  tier: string | null;
  compTier: string | null;
  billingTier: string | null;
  stripeCustomerId: string | null;
  maxMembers: number;
  memberCount: number;
  publishPerHour: number | null;
  joinEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Minted {
  userId: string;
  keyId: string;
  name: string;
  token: string;
  tier: string;
  effectiveTier: string;
  org: { id: string; name: string; tier: string | null; role: string } | null;
  claimUrl: string;
  createdAt: string;
}

interface Member {
  userId: string;
  role: string;
  tier: string;
  effectiveTier: string;
  email: string | null;
  claimedAt: string | null;
  createdAt: string;
  keys: { id: string; name: string; createdAt: string }[];
  sites: number;
}

interface ApiError {
  error: { code: string; message: string };
}

function admin(
  app: FastifyInstance,
  method: InjectOptions["method"],
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> {
  return inject(app, { method, url, headers: adminHeaders, ...(payload ? { payload } : {}) });
}

async function createOrg(
  app: FastifyInstance,
  body: object = { name: "SkySlope", compTier: "paid" },
): Promise<{ org: OrgAdmin; joinToken: string }> {
  const res = await admin(app, "POST", "/api/v1/admin/orgs", body);
  expect(res.statusCode).toBe(201);
  return res.json<{ org: OrgAdmin; joinToken: string }>();
}

/** A token-registered member; the response carries token, userId, keyId. */
async function joinAsMember(
  app: FastifyInstance,
  joinToken: string,
  name = "agent",
): Promise<Minted> {
  const res = await registerWithToken(app, joinToken, name);
  expect(res.statusCode).toBe(201);
  return res.json<Minted>();
}

/** An operator-minted org admin key. */
async function mintAdmin(app: FastifyInstance, orgId: string, name = "lead"): Promise<Minted> {
  const res = await admin(app, "POST", `/api/v1/admin/orgs/${orgId}/keys`, {
    name,
    role: "admin",
  });
  expect(res.statusCode).toBe(201);
  return res.json<Minted>();
}

function errorCode(res: LightMyRequestResponse): string {
  return res.json<ApiError>().error.code;
}

function userCount(db: DatabaseSync): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n);
}

function siteRow(db: DatabaseSync, id: string) {
  return db
    .prepare(`SELECT slug, visibility, expires_at, updated_at FROM sites WHERE id = ?`)
    .get(id) as {
    slug: string | null;
    visibility: string;
    expires_at: number | null;
    updated_at: number;
  };
}

function expectAbout(actual: number, expected: number, slackMs = 5_000): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(slackMs);
}

describe("operator: create and validate orgs", () => {
  it("creates an org with a hashed join token", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app);
    expect(joinToken).toMatch(ORG_TOKEN_RE);
    const row = db.prepare(`SELECT join_token_hash FROM orgs WHERE id = ?`).get(org.id) as {
      join_token_hash: string;
    };
    expect(row.join_token_hash).toBe(hashApiKey(joinToken));
    expect(row.join_token_hash).not.toBe(joinToken);
    expect(org).toMatchObject({
      name: "SkySlope",
      tier: "paid",
      compTier: "paid",
      billingTier: null,
      joinEnabled: true,
      memberCount: 0,
      maxMembers: 100,
      publishPerHour: 3_600,
    });

    const withUserKey = await inject(app, {
      method: "POST",
      url: "/api/v1/admin/orgs",
      headers: auth(),
      payload: { name: "Nope" },
    });
    expect(withUserKey.statusCode).toBe(401);

    const disabled = await setup({ adminTokenHash: null });
    const res = await admin(disabled.app, "POST", "/api/v1/admin/orgs", { name: "Nope" });
    expect(res.statusCode).toBe(503);
    expect(errorCode(res)).toBe("admin_disabled");
  });

  it("rejects ops and unknown tiers on create and update", async () => {
    const { app, db } = await setup();
    const ops = await admin(app, "POST", "/api/v1/admin/orgs", { name: "X", compTier: "ops" });
    expect(ops.statusCode).toBe(400);
    expect(errorCode(ops)).toBe("invalid_tier");
    const gold = await admin(app, "POST", "/api/v1/admin/orgs", { name: "X", compTier: "gold" });
    expect(gold.statusCode).toBe(400);
    expect(errorCode(gold)).toBe("invalid_tier");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM orgs`).get()).toEqual({ n: 0 });

    const { org } = await createOrg(app);
    const before = db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(org.id);
    const put = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, { compTier: "ops" });
    expect(put.statusCode).toBe(400);
    expect(errorCode(put)).toBe("invalid_tier");
    expect(db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(org.id)).toEqual(before);

    const empty = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {});
    expect(empty.statusCode).toBe(400);
    expect(errorCode(empty)).toBe("validation_error");
  });
});

describe("register with an org token", () => {
  it("puts the new key inside the org at the org tier", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app);
    const res = await registerWithToken(app, joinToken, "alice-claude");
    expect(res.statusCode).toBe(201);
    const minted = res.json<Minted>();
    expect(minted).toMatchObject({
      name: "alice-claude",
      tier: "free--",
      effectiveTier: "paid",
      org: { id: org.id, name: "SkySlope", tier: "paid", role: "member" },
    });
    expect(minted.token).toMatch(/^sp_/);
    expect(minted.claimUrl).toContain("/claim/");
    const user = getUser(db, minted.userId)!;
    expect(user.org_id).toBe(org.id);
    expect(user.org_role).toBe("member");

    const plain = (await register(app)).json<Minted>();
    expect(plain.effectiveTier).toBe("free--");
    expect(plain.org).toBeNull();
  });

  it("charges the IP register bucket for an invalid token and nothing for a malformed one", async () => {
    pinClock();
    const { app, db } = await setup({ registerPerDay: 2 });
    await createOrg(app);
    const before = userCount(db);
    const first = await registerWithToken(app, UNKNOWN_ORG_TOKEN);
    expect(first.statusCode).toBe(401);
    expect(errorCode(first)).toBe("invalid_org_token");
    expect(userCount(db)).toBe(before);
    expect((await registerWithToken(app, UNKNOWN_ORG_TOKEN)).statusCode).toBe(401);
    const third = await registerWithToken(app, UNKNOWN_ORG_TOKEN);
    expect(third.statusCode).toBe(429);
    expect(errorCode(third)).toBe("rate_limited");
    expect(userCount(db)).toBe(before);

    const strict = await setup({ registerPerDay: 1 });
    const malformed = await registerWithToken(strict.app, "org_short");
    expect(malformed.statusCode).toBe(400);
    expect(errorCode(malformed)).toBe("validation_error");
    expect((await register(strict.app)).statusCode).toBe(201);
  });

  it("skips the IP bucket and uses the org's daily bucket for a valid token", async () => {
    pinClock();
    const { app, db } = await setup({ registerPerDay: 1, orgRegisterPerDay: 2 });
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    const mint = () =>
      inject(app, {
        method: "POST",
        url: "/api/v1/org/keys",
        headers: auth(lead.token),
        payload: { name: "b" },
      });
    expect((await registerWithToken(app, joinToken, "a")).statusCode).toBe(201);
    // Admin minting draws from the same daily bucket as token registration.
    expect((await mint()).statusCode).toBe(201);
    const third = await registerWithToken(app, joinToken, "c");
    expect(third.statusCode).toBe(429);
    expect(third.json<ApiError>().error.message).toContain("organization");
    const fourth = await mint();
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json<ApiError>().error).toEqual(third.json<ApiError>().error);
    expect(
      db.prepare(`SELECT bucket, count FROM rate_limits WHERE action = 'register'`).all(),
    ).toEqual([{ bucket: `org:${org.id}`, count: 2 }]);
    expect((await register(app)).statusCode).toBe(201);
  });

  it("needs no pepper when the token is the credential", async () => {
    const { app } = await setup({ ipHashPepper: null });
    const { joinToken } = await createOrg(app);
    const plain = await register(app);
    expect(plain.statusCode).toBe(503);
    expect(errorCode(plain)).toBe("rate_limit_unconfigured");
    expect((await registerWithToken(app, joinToken)).statusCode).toBe(201);
    const bad = await registerWithToken(app, UNKNOWN_ORG_TOKEN);
    expect(bad.statusCode).toBe(401);
    expect(errorCode(bad)).toBe("invalid_org_token");
  });

  it("operator can disable and rotate the join token", async () => {
    const { app } = await setup();
    const { org, joinToken } = await createOrg(app);
    const disabled = await admin(app, "POST", `/api/v1/admin/orgs/${org.id}/join-token`, {
      disable: true,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<{ joinToken: string | null }>().joinToken).toBeNull();
    const old = await registerWithToken(app, joinToken);
    expect(old.statusCode).toBe(401);
    expect(errorCode(old)).toBe("invalid_org_token");
    const shown = await admin(app, "GET", `/api/v1/admin/orgs/${org.id}`);
    expect(shown.json<{ org: OrgAdmin }>().org.joinEnabled).toBe(false);

    const rotated = await admin(app, "POST", `/api/v1/admin/orgs/${org.id}/join-token`, {});
    const fresh = rotated.json<{ joinToken: string }>().joinToken;
    expect(fresh).toMatch(ORG_TOKEN_RE);
    expect(fresh).not.toBe(joinToken);
    expect((await registerWithToken(app, fresh)).statusCode).toBe(201);
    const again = await admin(app, "GET", `/api/v1/admin/orgs/${org.id}`);
    expect(again.json<{ org: OrgAdmin }>().org.joinEnabled).toBe(true);
  });

  it("enforces the member cap", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app, {
      name: "Small",
      compTier: "paid",
      maxMembers: 2,
    });
    expect((await registerWithToken(app, joinToken, "a")).statusCode).toBe(201);
    expect((await registerWithToken(app, joinToken, "b")).statusCode).toBe(201);
    const before = userCount(db);
    const full = await registerWithToken(app, joinToken, "c");
    expect(full.statusCode).toBe(403);
    expect(errorCode(full)).toBe("org_full");
    expect(userCount(db)).toBe(before);

    const raised = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, { maxMembers: 3 });
    expect(raised.statusCode).toBe(200);
    expect((await registerWithToken(app, joinToken, "c")).statusCode).toBe(201);
  });
});

describe("publishing as an org member", () => {
  it("publishes at the org tier", async () => {
    const { app } = await setup();
    const { joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);
    const body = { ...helloSite(), ttl: null, slug: "team-plan", visibility: "public" };
    const ok = await publish(app, body, member.token);
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ expiresAt: string | null; slug: string; visibility: string }>()).toMatchObject(
      { expiresAt: null, slug: "team-plan", visibility: "public" },
    );

    const plain = (await register(app)).json<Minted>();
    const denied = await publish(app, { ...body, slug: "other-plan" }, plain.token);
    expect(denied.statusCode).toBe(400);
  });

  it("skips the IP publish bucket when the org lifts the tier", async () => {
    pinClock();
    const { app, db } = await setup();
    const { joinToken } = await createOrg(app, { name: "Team", compTier: "free-" });
    const ipBucket = `ip:${hashIp(IP, "test-pepper")}`;
    const windowStart = Math.floor(FIXED_NOW / HOUR_MS) * HOUR_MS;
    db.prepare(
      `INSERT INTO rate_limits (bucket, action, window_start, count) VALUES (?, 'publish', ?, 120)`,
    ).run(ipBucket, windowStart);

    const member = await joinAsMember(app, joinToken);
    expect((await publish(app, helloSite(), member.token, IP)).statusCode).toBe(201);
    // The member never touched the IP bucket, not merely stayed under its cap.
    expect(
      db
        .prepare(`SELECT count FROM rate_limits WHERE bucket = ? AND action = 'publish'`)
        .get(ipBucket),
    ).toEqual({ count: 120 });

    const plain = (await register(app)).json<Minted>();
    const denied = await publish(app, helloSite(), plain.token, IP);
    expect(denied.statusCode).toBe(429);
    expect(denied.json<ApiError>().error.message).toBe("too many publishes from this address");
  });

  it("shares one pooled bucket across the org", async () => {
    pinClock();
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app, {
      name: "Pool",
      compTier: "paid",
      publishPerHour: 3,
    });
    const a = await joinAsMember(app, joinToken, "a");
    const b = await joinAsMember(app, joinToken, "b");
    expect((await publish(app, helloSite(), a.token)).statusCode).toBe(201);
    expect((await publish(app, helloSite(), b.token)).statusCode).toBe(201);
    expect((await publish(app, helloSite(), a.token)).statusCode).toBe(201);
    const fourth = await publish(app, helloSite(), b.token);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json<ApiError>().error.message).toBe("organization publish limit reached");
    const fromA = await publish(app, helloSite(), a.token);
    expect(fromA.statusCode).toBe(429);
    const rows = db
      .prepare(`SELECT bucket, count FROM rate_limits WHERE action = 'publish' AND bucket LIKE 'org:%'`)
      .all();
    expect(rows).toEqual([{ bucket: `org:${org.id}`, count: 3 }]);
  });

  it("a member on a higher own plan skips the pool", async () => {
    const { app, db } = await setup();
    const { org } = await createOrg(app, { name: "Free", compTier: "free", publishPerHour: 1 });
    const user = createUser(db, { tier: "free--" });
    setUserTier(db, user.id, "paid");
    createApiKeyRecord(db, { name: "paid", token: "sp_paid", userId: user.id });
    const attach = await admin(app, "PUT", `/api/v1/admin/users/${user.id}/org`, { orgId: org.id });
    expect(attach.statusCode).toBe(200);
    expect((await publish(app, helloSite(), "sp_paid")).statusCode).toBe(201);
    expect((await publish(app, helloSite(), "sp_paid")).statusCode).toBe(201);
    const rows = db.prepare(`SELECT bucket FROM rate_limits WHERE bucket LIKE 'org:%'`).all();
    expect(rows).toEqual([]);
  });

  it("never lowers a member below their own tier", async () => {
    const { app, db } = await setup();
    const { org } = await createOrg(app, { name: "Low", compTier: "free-" });
    const paid = createUser(db, { tier: "paid" });
    createApiKeyRecord(db, { name: "paid", token: "sp_paid", userId: paid.id });
    const attach = await admin(app, "PUT", `/api/v1/admin/users/${paid.id}/org`, { orgId: org.id });
    expect(attach.statusCode).toBe(200);
    expect(attach.json<{ effectiveTier: string }>().effectiveTier).toBe("paid");
    const res = await publish(app, { ...helloSite(), ttl: null }, "sp_paid");
    expect(res.statusCode).toBe(201);
    expect(res.json<{ expiresAt: string | null }>().expiresAt).toBeNull();
  });

  it("ops users never join an org", async () => {
    const { app, db, keyId } = await setup();
    const { org, joinToken } = await createOrg(app);
    const opsUserId = (
      db.prepare(`SELECT user_id FROM api_keys WHERE id = ?`).get(keyId) as { user_id: string }
    ).user_id;
    const attach = await admin(app, "PUT", `/api/v1/admin/users/${opsUserId}/org`, {
      orgId: org.id,
    });
    expect(attach.statusCode).toBe(400);
    expect(errorCode(attach)).toBe("invalid_tier");
    expect(getUser(db, opsUserId)!.org_id).toBeNull();

    const join = await inject(app, {
      method: "POST",
      url: "/api/v1/org/join",
      headers: auth(),
      payload: { orgToken: joinToken },
    });
    expect(join.statusCode).toBe(400);
    expect(errorCode(join)).toBe("invalid_tier");
    expect(getUser(db, opsUserId)!.org_id).toBeNull();
  });
});

describe("lowering an org tier", () => {
  it("clamps permanent sites and the reaper removes them", async () => {
    const { app, db, s3, config } = await setup();
    const { org, joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);
    const site = (await publish(app, { ...helloSite(), ttl: null }, member.token)).json<{
      id: string;
      updatedAt: string;
    }>();
    const now = Date.now();
    const lowered = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, { compTier: "free" });
    expect(lowered.statusCode).toBe(200);
    const body = lowered.json<{ org: OrgAdmin; clamped: { users: number; sites: number } }>();
    expect(body.org.tier).toBe("free");
    expect(body.clamped.sites).toBe(1);

    const shown = await inject(app, {
      method: "GET",
      url: `/api/v1/sites/${site.id}`,
      headers: auth(member.token),
    });
    const info = shown.json<{ expiresAt: string; updatedAt: string }>();
    expectAbout(Date.parse(info.expiresAt), now + 365 * DAY_MS);
    expect(info.updatedAt).toBe(site.updatedAt);

    const result = await reapExpiredSites({ config, db, s3: s3.client }, now + 366 * DAY_MS);
    expect(result.sites).toBe(1);
    expect(s3.keysUnder(`sites/${site.id}/`)).toHaveLength(0);
  });

  it("the reaper assigns an expiry after an out-of-band org tier change, then removes the site", async () => {
    const { app, db, s3, config } = await setup();
    const { org, joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);
    const site = (await publish(app, { ...helloSite(), ttl: null }, member.token)).json<{
      id: string;
    }>();
    expect(siteRow(db, site.id).expires_at).toBeNull();
    // Bypass the route clamp: the case reconcilePermanentSites exists for.
    db.prepare(`UPDATE orgs SET comp_tier = 'free' WHERE id = ?`).run(org.id);
    expect(siteRow(db, site.id).expires_at).toBeNull();

    const now = Date.now();
    const first = await reapExpiredSites({ config, db, s3: s3.client }, now);
    expect(first.sites).toBe(0);
    const after = siteRow(db, site.id).expires_at;
    expect(after).not.toBeNull();
    expectAbout(after!, now + 365 * DAY_MS);

    const second = await reapExpiredSites({ config, db, s3: s3.client }, now + 366 * DAY_MS);
    expect(second.sites).toBe(1);
    expect(s3.keysUnder(`sites/${site.id}/`)).toHaveLength(0);
  });

  it("lowering to free-- clears slug and public visibility", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);
    const created = await publish(
      app,
      { ...helloSite(), slug: "kept", visibility: "public", ttl: "2y" },
      member.token,
    );
    expect(created.statusCode).toBe(201);
    const site = created.json<{ id: string }>();
    expect((await inject(app, { method: "GET", url: "/s/kept/" })).statusCode).toBe(200);

    const now = Date.now();
    const lowered = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      compTier: "free--",
    });
    expect(lowered.statusCode).toBe(200);
    const row = siteRow(db, site.id);
    expect(row.slug).toBeNull();
    expect(row.visibility).toBe("unlisted");
    expectAbout(row.expires_at!, now + 30 * DAY_MS);
    expect((await inject(app, { method: "GET", url: "/s/kept/" })).statusCode).toBe(404);
  });

  it("raising is a no-op", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app, { name: "Free", compTier: "free" });
    const member = await joinAsMember(app, joinToken);
    const site = (await publish(app, { ...helloSite(), ttl: "90d" }, member.token)).json<{
      id: string;
    }>();
    const before = siteRow(db, site.id);
    const raised = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, { compTier: "paid" });
    expect(raised.statusCode).toBe(200);
    expect(raised.json<{ clamped: { sites: number } }>().clamped.sites).toBe(0);
    expect(siteRow(db, site.id)).toEqual(before);
  });

  it("comp and billing tiers are independent", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);
    const site = (await publish(app, { ...helloSite(), ttl: null }, member.token)).json<{
      id: string;
    }>();
    db.prepare(`UPDATE orgs SET billing_tier = 'unlock' WHERE id = ?`).run(org.id);

    const now = Date.now();
    const withdrawn = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, { compTier: null });
    expect(withdrawn.statusCode).toBe(200);
    const body = withdrawn.json<{ org: OrgAdmin; clamped: { sites: number } }>();
    expect(body.org.tier).toBe("unlock");
    expect(body.org.compTier).toBeNull();
    expect(body.clamped.sites).toBe(1);
    const after = siteRow(db, site.id);
    expectAbout(after.expires_at!, now + 365 * DAY_MS);

    const regranted = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, { compTier: "paid" });
    expect(regranted.json<{ clamped: { sites: number } }>().clamped.sites).toBe(0);
    expect(siteRow(db, site.id)).toEqual(after);
  });

  it("a rename does not clamp", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app, { name: "SkySlope", compTier: "free" });
    const member = await joinAsMember(app, joinToken);
    const site = (await publish(app, helloSite(), member.token)).json<{ id: string }>();
    db.prepare(`UPDATE sites SET expires_at = NULL WHERE id = ?`).run(site.id);
    const renamed = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      name: "SkySlope Eng",
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ org: OrgAdmin; clamped: object }>()).toMatchObject({
      org: { name: "SkySlope Eng" },
      clamped: { users: 0, sites: 0, skipped: 0 },
    });
    expect(siteRow(db, site.id).expires_at).toBeNull();
  });
});

describe("operator: attach and detach users", () => {
  it("attaches then detaches, clamping on the way out", async () => {
    const { app } = await setup();
    const { org } = await createOrg(app);
    const plain = (await register(app)).json<Minted>();
    expect((await publish(app, helloSite(), plain.token)).statusCode).toBe(201);

    const attach = await admin(app, "PUT", `/api/v1/admin/users/${plain.userId}/org`, {
      orgId: org.id,
    });
    expect(attach.statusCode).toBe(200);
    expect(attach.json<object>()).toEqual({
      userId: plain.userId,
      orgId: org.id,
      role: "member",
      tier: "free--",
      effectiveTier: "paid",
      clampedSites: 0,
    });
    expect((await publish(app, { ...helloSite(), ttl: null }, plain.token)).statusCode).toBe(201);

    const detach = await admin(app, "PUT", `/api/v1/admin/users/${plain.userId}/org`, {
      orgId: null,
    });
    expect(detach.statusCode).toBe(200);
    expect(detach.json<object>()).toEqual({
      userId: plain.userId,
      orgId: null,
      role: null,
      tier: "free--",
      effectiveTier: "free--",
      clampedSites: 1,
    });
    const denied = await publish(app, { ...helloSite(), ttl: null }, plain.token);
    expect(denied.statusCode).toBe(400);
    expect(errorCode(denied)).toBe("ttl_not_allowed");
  });

  it("validates the attach", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app);
    const other = await createOrg(app, { name: "Other", compTier: "free" });
    const plain = (await register(app)).json<Minted>();

    const unknownUser = await admin(app, "PUT", `/api/v1/admin/users/nope/org`, { orgId: org.id });
    expect(unknownUser.statusCode).toBe(404);
    expect(errorCode(unknownUser)).toBe("not_found");

    const unknownOrg = await admin(app, "PUT", `/api/v1/admin/users/${plain.userId}/org`, {
      orgId: "nope",
    });
    expect(unknownOrg.statusCode).toBe(400);
    expect(errorCode(unknownOrg)).toBe("unknown_org");

    const member = await joinAsMember(app, joinToken);
    const elsewhere = await admin(app, "PUT", `/api/v1/admin/users/${member.userId}/org`, {
      orgId: other.org.id,
    });
    expect(elsewhere.statusCode).toBe(409);
    expect(errorCode(elsewhere)).toBe("already_in_org");

    const promoted = await admin(app, "PUT", `/api/v1/admin/users/${member.userId}/org`, {
      orgId: org.id,
      role: "admin",
    });
    expect(promoted.statusCode).toBe(200);
    expect(getUser(db, member.userId)!.org_role).toBe("admin");

    const tiny = await createOrg(app, { name: "Tiny", compTier: "free", maxMembers: 1 });
    await joinAsMember(app, tiny.joinToken, "only");
    const full = await admin(app, "PUT", `/api/v1/admin/users/${plain.userId}/org`, {
      orgId: tiny.org.id,
    });
    expect(full.statusCode).toBe(403);
    expect(errorCode(full)).toBe("org_full");
    expect(getUser(db, plain.userId)!.org_id).toBeNull();
  });
});

describe("member: join", () => {
  it("joins an existing account, once, with a rate limit and a cap", async () => {
    pinClock();
    const { app } = await setup();
    const { org, joinToken } = await createOrg(app);
    const plain = (await register(app, "human")).json<Minted>();
    const site = (await publish(app, helloSite(), plain.token)).json<{ id: string }>();

    const join = (payload: object, token: string) =>
      inject(app, { method: "POST", url: "/api/v1/org/join", headers: auth(token), payload });

    const joined = await join({ orgToken: joinToken }, plain.token);
    expect(joined.statusCode).toBe(200);
    expect(joined.json<object>()).toEqual({
      org: { id: org.id, name: "SkySlope", tier: "paid" },
      role: "member",
      tier: "free--",
      effectiveTier: "paid",
    });
    expect((await inject(app, { method: "GET", url: `/s/${site.id}/` })).statusCode).toBe(200);
    expect((await publish(app, { ...helloSite(), ttl: null }, plain.token)).statusCode).toBe(201);

    const again = await join({ orgToken: joinToken }, plain.token);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe("already_in_org");

    const prober = (await register(app, "prober", "203.0.113.11")).json<Minted>();
    for (let i = 0; i < 10; i += 1) {
      const res = await join({ orgToken: UNKNOWN_ORG_TOKEN }, prober.token);
      expect(res.statusCode).toBe(401);
      expect(errorCode(res)).toBe("invalid_org_token");
    }
    const limited = await join({ orgToken: UNKNOWN_ORG_TOKEN }, prober.token);
    expect(limited.statusCode).toBe(429);
    expect(errorCode(limited)).toBe("rate_limited");

    const tiny = await createOrg(app, { name: "Tiny", compTier: "free", maxMembers: 1 });
    await joinAsMember(app, tiny.joinToken, "only");
    const late = (await register(app, "late", "203.0.113.12")).json<Minted>();
    const full = await join({ orgToken: tiny.joinToken }, late.token);
    expect(full.statusCode).toBe(403);
    expect(errorCode(full)).toBe("org_full");
  });
});

describe("org admin", () => {
  it("mints keys inside the org without sharing the join token", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    expect(lead).toMatchObject({
      tier: "free--",
      effectiveTier: "paid",
      org: { id: org.id, role: "admin" },
    });
    expect(getUser(db, lead.userId)!.org_role).toBe("admin");

    const minted = await inject(app, {
      method: "POST",
      url: "/api/v1/org/keys",
      headers: auth(lead.token),
      payload: { name: "deploy-bot" },
    });
    expect(minted.statusCode).toBe(201);
    const bot = minted.json<Minted>();
    expect(bot).toMatchObject({
      name: "deploy-bot",
      effectiveTier: "paid",
      org: { id: org.id, role: "member" },
    });
    expect(getUser(db, bot.userId)!.org_id).toBe(org.id);
    expect((await publish(app, { ...helloSite(), ttl: null }, bot.token)).statusCode).toBe(201);

    const member = await joinAsMember(app, joinToken);
    const denied = await inject(app, {
      method: "POST",
      url: "/api/v1/org/keys",
      headers: auth(member.token),
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe("org_admin_required");

    const plain = (await register(app)).json<Minted>();
    const noOrg = await inject(app, {
      method: "POST",
      url: "/api/v1/org/keys",
      headers: auth(plain.token),
      payload: {},
    });
    expect(noOrg.statusCode).toBe(404);
    expect(errorCode(noOrg)).toBe("no_org");

    const tight = await setup({ orgRegisterPerDay: 1 });
    const tightOrg = await createOrg(tight.app);
    const tightLead = await mintAdmin(tight.app, tightOrg.org.id);
    const mint = () =>
      inject(tight.app, {
        method: "POST",
        url: "/api/v1/org/keys",
        headers: auth(tightLead.token),
        payload: {},
      });
    expect((await mint()).statusCode).toBe(201);
    const second = await mint();
    expect(second.statusCode).toBe(429);
    expect(errorCode(second)).toBe("rate_limited");
  });

  it("lists members with claim state, keys, and site counts", async () => {
    const workos = createFakeWorkOS("MagicAuth");
    const { app } = await setup({ workos: WORKOS_CONFIG }, workos.client);
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    const alice = await joinAsMember(app, joinToken, "alice-claude");
    expect((await publish(app, helloSite(), alice.token)).statusCode).toBe(201);
    await completeClaimFlow(app, alice.claimUrl);

    const res = await inject(app, {
      method: "GET",
      url: "/api/v1/org/members",
      headers: auth(lead.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ org: object; members: Member[] }>();
    expect(body.org).toEqual({ id: org.id, name: "SkySlope", tier: "paid" });
    expect(body.members).toHaveLength(2);
    const leadRow = body.members.find((m) => m.userId === lead.userId)!;
    const aliceRow = body.members.find((m) => m.userId === alice.userId)!;
    expect(leadRow).toMatchObject({
      role: "admin",
      tier: "free--",
      effectiveTier: "paid",
      email: null,
      claimedAt: null,
      sites: 0,
      keys: [{ id: lead.keyId, name: "lead" }],
    });
    expect(aliceRow).toMatchObject({
      role: "member",
      tier: "free-",
      effectiveTier: "paid",
      email: "human@example.com",
      sites: 1,
      keys: [{ id: alice.keyId, name: "alice-claude" }],
    });
    expect(aliceRow.claimedAt).not.toBeNull();

    const denied = await inject(app, {
      method: "GET",
      url: "/api/v1/org/members",
      headers: auth(alice.token),
    });
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe("org_admin_required");
  });

  it("removes members but never the last admin", async () => {
    const { app } = await setup();
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    const m1 = await joinAsMember(app, joinToken, "m1");
    const m2 = await joinAsMember(app, joinToken, "m2");
    expect((await publish(app, { ...helloSite(), ttl: null }, m1.token)).statusCode).toBe(201);

    const remove = (userId: string, token: string) =>
      inject(app, { method: "DELETE", url: `/api/v1/org/members/${userId}`, headers: auth(token) });

    const removed = await remove(m1.userId, lead.token);
    expect(removed.statusCode).toBe(200);
    expect(removed.json<object>()).toEqual({ userId: m1.userId, clampedSites: 1, revokedKeys: 0 });
    expect((await publish(app, helloSite(), m1.token)).statusCode).toBe(201);
    const denied = await publish(app, { ...helloSite(), ttl: null }, m1.token);
    expect(denied.statusCode).toBe(400);
    expect(errorCode(denied)).toBe("ttl_not_allowed");

    const self = await remove(lead.userId, lead.token);
    expect(self.statusCode).toBe(409);
    expect(errorCode(self)).toBe("last_admin");

    const promoted = await inject(app, {
      method: "PUT",
      url: `/api/v1/org/members/${m2.userId}`,
      headers: auth(lead.token),
      payload: { role: "admin" },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<Member>().role).toBe("admin");
    expect((await remove(lead.userId, lead.token)).statusCode).toBe(200);

    const missing = await remove("nope", m2.token);
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe("member_not_found");
  });

  it("removes a member and revokes their keys in one request", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    const member = await joinAsMember(app, joinToken);
    expect((await publish(app, { ...helloSite(), ttl: null }, member.token)).statusCode).toBe(201);

    const removed = await inject(app, {
      method: "DELETE",
      url: `/api/v1/org/members/${member.userId}?revokeKeys=true`,
      headers: auth(lead.token),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<object>()).toEqual({
      userId: member.userId,
      clampedSites: 1,
      revokedKeys: 1,
    });
    expect((await publish(app, helloSite(), member.token)).statusCode).toBe(401);
    expect(getUser(db, member.userId)).toMatchObject({ org_id: null, org_role: null });

    const bad = await inject(app, {
      method: "DELETE",
      url: `/api/v1/org/members/${lead.userId}?revokeKeys=yes`,
      headers: auth(lead.token),
    });
    expect(bad.statusCode).toBe(400);
    expect(errorCode(bad)).toBe("validation_error");
  });

  it("an admin can leave with their keys revoked, unless they are the last admin", async () => {
    const { app, db } = await setup();
    const { org } = await createOrg(app);
    const lead = await mintAdmin(app, org.id, "lead");
    const leave = () =>
      inject(app, {
        method: "DELETE",
        url: `/api/v1/org/members/${lead.userId}?revokeKeys=true`,
        headers: auth(lead.token),
      });
    const me = () => inject(app, { method: "GET", url: "/api/v1/me", headers: auth(lead.token) });

    const sole = await leave();
    expect(sole.statusCode).toBe(409);
    expect(errorCode(sole)).toBe("last_admin");
    expect((await me()).statusCode).toBe(200);
    expect(db.prepare(`SELECT revoked_at FROM api_keys WHERE id = ?`).get(lead.keyId)).toEqual({
      revoked_at: null,
    });

    const second = await mintAdmin(app, org.id, "second");
    const left = await leave();
    expect(left.statusCode).toBe(200);
    expect(left.json<object>()).toEqual({ userId: lead.userId, clampedSites: 0, revokedKeys: 1 });
    expect((await me()).statusCode).toBe(401);
    expect(getUser(db, lead.userId)).toMatchObject({ org_id: null, org_role: null });
    const members = await inject(app, {
      method: "GET",
      url: "/api/v1/org/members",
      headers: auth(second.token),
    });
    expect(members.json<{ members: Member[] }>().members.map((m) => m.userId)).toEqual([
      second.userId,
    ]);
  });

  it("never reaches another org's members or keys", async () => {
    const { app, db } = await setup();
    const a = await createOrg(app, { name: "A", compTier: "paid" });
    const b = await createOrg(app, { name: "B", compTier: "paid" });
    const aLead = await mintAdmin(app, a.org.id, "a-lead");
    const bLead = await mintAdmin(app, b.org.id, "b-lead");
    const bMember = await joinAsMember(app, b.joinToken, "b-member");
    const asA = (method: InjectOptions["method"], url: string, payload?: object) =>
      inject(app, { method, url, headers: auth(aLead.token), ...(payload ? { payload } : {}) });

    const promoted = await asA("PUT", `/api/v1/org/members/${bMember.userId}`, { role: "admin" });
    expect(promoted.statusCode).toBe(404);
    expect(errorCode(promoted)).toBe("member_not_found");
    expect(getUser(db, bMember.userId)).toMatchObject({ org_id: b.org.id, org_role: "member" });

    const removed = await asA("DELETE", `/api/v1/org/members/${bMember.userId}?revokeKeys=true`);
    expect(removed.statusCode).toBe(404);
    expect(errorCode(removed)).toBe("member_not_found");
    expect(getUser(db, bMember.userId)!.org_id).toBe(b.org.id);
    expect((await publish(app, { ...helloSite(), ttl: null }, bMember.token)).statusCode).toBe(201);

    const removedAdmin = await asA("DELETE", `/api/v1/org/members/${bLead.userId}`);
    expect(removedAdmin.statusCode).toBe(404);
    expect(getUser(db, bLead.userId)).toMatchObject({ org_id: b.org.id, org_role: "admin" });

    const revoked = await asA("DELETE", `/api/v1/org/keys/${bMember.keyId}`);
    expect(revoked.statusCode).toBe(404);
    expect(errorCode(revoked)).toBe("not_found");
    expect((await publish(app, helloSite(), bMember.token)).statusCode).toBe(201);
  });

  it("revokes a member's key", async () => {
    const { app } = await setup();
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    const member = await joinAsMember(app, joinToken);
    const revoke = (keyId: string) =>
      inject(app, { method: "DELETE", url: `/api/v1/org/keys/${keyId}`, headers: auth(lead.token) });

    expect((await revoke(member.keyId)).statusCode).toBe(204);
    const gone = await publish(app, helloSite(), member.token);
    expect(gone.statusCode).toBe(401);

    const plain = (await register(app)).json<Minted>();
    const outsider = await revoke(plain.keyId);
    expect(outsider.statusCode).toBe(404);
    expect(errorCode(outsider)).toBe("not_found");
    expect((await publish(app, helloSite(), plain.token)).statusCode).toBe(201);

    expect((await revoke(member.keyId)).statusCode).toBe(404);
  });

  it("changes roles but keeps one admin", async () => {
    const { app } = await setup();
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    const member = await joinAsMember(app, joinToken);
    const setRole = (userId: string, role: string) =>
      inject(app, {
        method: "PUT",
        url: `/api/v1/org/members/${userId}`,
        headers: auth(lead.token),
        payload: { role },
      });

    const up = await setRole(member.userId, "admin");
    expect(up.statusCode).toBe(200);
    expect(up.json<Member>()).toMatchObject({ userId: member.userId, role: "admin" });
    const down = await setRole(member.userId, "member");
    expect(down.statusCode).toBe(200);
    expect(down.json<Member>().role).toBe("member");

    const last = await setRole(lead.userId, "member");
    expect(last.statusCode).toBe(409);
    expect(errorCode(last)).toBe("last_admin");
  });

  it("rotates and disables the join token", async () => {
    const { app } = await setup();
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    const rotate = (payload: object) =>
      inject(app, {
        method: "POST",
        url: "/api/v1/org/join-token",
        headers: auth(lead.token),
        payload,
      });

    const rotated = await rotate({});
    expect(rotated.statusCode).toBe(200);
    const fresh = rotated.json<{ joinToken: string }>().joinToken;
    expect(fresh).toMatch(ORG_TOKEN_RE);
    expect((await registerWithToken(app, joinToken)).statusCode).toBe(401);
    expect((await registerWithToken(app, fresh)).statusCode).toBe(201);

    const disabled = await rotate({ disable: true });
    expect(disabled.json<{ joinToken: string | null }>().joinToken).toBeNull();
    expect((await registerWithToken(app, fresh)).statusCode).toBe(401);
  });

  it("lists every member's sites read-only", async () => {
    const { app } = await setup();
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    const a = await joinAsMember(app, joinToken, "a");
    const b = await joinAsMember(app, joinToken, "b");
    const siteA = (await publish(app, helloSite(), a.token)).json<{ id: string }>();
    const siteB = (await publish(app, helloSite(), b.token)).json<{ id: string }>();

    const res = await inject(app, {
      method: "GET",
      url: "/api/v1/org/sites",
      headers: auth(lead.token),
    });
    expect(res.statusCode).toBe(200);
    const sites = res.json<{ sites: { id: string; ownerUserId: string; url: string }[] }>().sites;
    expect(sites.map((s) => [s.id, s.ownerUserId]).sort()).toEqual(
      [
        [siteA.id, a.userId],
        [siteB.id, b.userId],
      ].sort(),
    );
    expect(sites[0]!.url).toContain("/s/");

    const denied = await inject(app, {
      method: "GET",
      url: "/api/v1/org/sites",
      headers: auth(a.token),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe("GET /api/v1/me", () => {
  it("shows own and effective tier plus the org", async () => {
    const { app } = await setup();
    const { org, joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken, "alice");
    const me = await inject(app, { method: "GET", url: "/api/v1/me", headers: auth(member.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json<object>()).toEqual({
      userId: member.userId,
      tier: "free--",
      effectiveTier: "paid",
      email: null,
      claimed: false,
      key: { id: member.keyId, name: "alice" },
      org: { id: org.id, name: "SkySlope", tier: "paid", role: "member" },
    });

    const plain = (await register(app)).json<Minted>();
    const plainMe = await inject(app, { method: "GET", url: "/api/v1/me", headers: auth(plain.token) });
    expect(plainMe.json<{ org: unknown; effectiveTier: string }>()).toMatchObject({
      org: null,
      effectiveTier: "free--",
    });

    expect((await inject(app, { method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
  });
});

describe("claiming an org member", () => {
  it("raises the own tier and keeps the org", async () => {
    const workos = createFakeWorkOS("MagicAuth");
    const { app, db } = await setup({ workos: WORKOS_CONFIG }, workos.client);
    const { org, joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);
    await completeClaimFlow(app, member.claimUrl);

    const user = getUser(db, member.userId)!;
    expect(user.tier).toBe("free-");
    expect(user.org_id).toBe(org.id);
    expect(user.org_role).toBe("member");

    const shown = await admin(app, "GET", `/api/v1/admin/orgs/${org.id}`);
    const row = shown.json<{ members: Member[] }>().members.find((m) => m.userId === member.userId)!;
    expect(row).toMatchObject({ tier: "free-", effectiveTier: "paid", email: "human@example.com" });
  });
});

describe("operator: list, show, delete", () => {
  it("lists and shows orgs with counts", async () => {
    const { app } = await setup();
    const { org, joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);
    expect((await publish(app, { ...helloSite(), ttl: null }, member.token)).statusCode).toBe(201);
    // Paid defaults to permanent, so the second site needs an explicit ttl.
    expect((await publish(app, { ...helloSite(), ttl: "7d" }, member.token)).statusCode).toBe(201);

    const list = await admin(app, "GET", "/api/v1/admin/orgs");
    expect(list.statusCode).toBe(200);
    const orgs = list.json<{ orgs: (OrgAdmin & { siteCount: number; permanentSites: number })[] }>()
      .orgs;
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({
      id: org.id,
      memberCount: 1,
      siteCount: 2,
      permanentSites: 1,
      joinEnabled: true,
    });

    const shown = await admin(app, "GET", `/api/v1/admin/orgs/${org.id}`);
    expect(shown.statusCode).toBe(200);
    const body = shown.json<{
      org: OrgAdmin;
      members: Member[];
      siteCount: number;
      permanentSites: number;
    }>();
    expect(body.org.id).toBe(org.id);
    expect(body.siteCount).toBe(2);
    expect(body.permanentSites).toBe(1);
    expect(body.members.map((m) => m.userId)).toEqual([member.userId]);

    const missing = await admin(app, "GET", "/api/v1/admin/orgs/nope");
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe("not_found");

    const userKey = await inject(app, { method: "GET", url: "/api/v1/admin/orgs", headers: auth() });
    expect(userKey.statusCode).toBe(401);
  });

  it("deletes an org unless it is billed", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);
    const site = (await publish(app, { ...helloSite(), ttl: null }, member.token)).json<{
      id: string;
    }>();

    db.prepare(`UPDATE orgs SET stripe_customer_id = 'cus_1' WHERE id = ?`).run(org.id);
    const billed = await admin(app, "DELETE", `/api/v1/admin/orgs/${org.id}`);
    expect(billed.statusCode).toBe(409);
    expect(errorCode(billed)).toBe("org_billed");
    expect(getUser(db, member.userId)!.org_id).toBe(org.id);

    db.prepare(`UPDATE orgs SET stripe_customer_id = NULL WHERE id = ?`).run(org.id);
    const now = Date.now();
    const deleted = await admin(app, "DELETE", `/api/v1/admin/orgs/${org.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<object>()).toEqual({ clamped: { users: 1, sites: 1, skipped: 0 } });

    const me = await inject(app, { method: "GET", url: "/api/v1/me", headers: auth(member.token) });
    expect(me.json<{ org: unknown; effectiveTier: string }>()).toMatchObject({
      org: null,
      effectiveTier: "free--",
    });
    expectAbout(siteRow(db, site.id).expires_at!, now + 30 * DAY_MS);
    expect((await admin(app, "GET", `/api/v1/admin/orgs/${org.id}`)).statusCode).toBe(404);
  });

  it("admin key listing carries userId and orgId", async () => {
    const { app, keyId } = await setup();
    const { org, joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);
    const res = await admin(app, "GET", "/api/v1/admin/keys");
    expect(res.statusCode).toBe(200);
    const keys = res.json<{ keys: { id: string; userId: string; orgId: string | null }[] }>().keys;
    const ops = keys.find((k) => k.id === keyId)!;
    expect(ops.orgId).toBeNull();
    expect(typeof ops.userId).toBe("string");
    const minted = keys.find((k) => k.id === member.keyId)!;
    expect(minted).toMatchObject({ userId: member.userId, orgId: org.id });
  });
});

describe("docs", () => {
  it("mentions the org token", async () => {
    const { app } = await setup();
    const res = await inject(app, { method: "GET", url: "/docs/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("orgToken");
    expect(res.body).toContain("--org-token");
  });
});
