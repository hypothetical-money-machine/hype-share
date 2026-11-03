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
import { getOwnerStats } from "./owner-stats.js";
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

const WORKOS_ORG_A = "org_01HSKYSLOPEAAAAAAAAAAAAAAA";
const WORKOS_ORG_B = "org_01HSKYSLOPEBBBBBBBBBBBBBBB";

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
  /** WorkOS organizations that exist, by id. */
  organizations: Set<string>;
  organizationLookups: string[];
  failOrganizationLookup: boolean;
}

function createFakeWorkOS(method: string | undefined = "MagicAuth"): FakeWorkOS {
  let flow = 0;
  const fake: FakeWorkOS = {
    method,
    organizations: new Set([WORKOS_ORG_A, WORKOS_ORG_B]),
    organizationLookups: [],
    failOrganizationLookup: false,
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
    organizations: {
      getOrganization: async (id) => {
        fake.organizationLookups.push(id);
        if (fake.failOrganizationLookup) throw new Error("WorkOS unavailable");
        return fake.organizations.has(id) ? { id, name: `WorkOS ${id}` } : null;
      },
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
async function completeClaimFlow(
  app: FastifyInstance,
  claimUrl: string,
): Promise<LightMyRequestResponse> {
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
  return callback;
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
  workosOrganizationId: string | null;
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

  it("needs a tier to accept a publish pool on create", async () => {
    const { app, db } = await setup();
    const bare = await admin(app, "POST", "/api/v1/admin/orgs", { name: "X", publishPerHour: 5 });
    expect(bare.statusCode).toBe(400);
    expect(errorCode(bare)).toBe("validation_error");
    expect(bare.json<ApiError>().error.message).toContain("publishPerHour needs a tier");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM orgs`).get()).toEqual({ n: 0 });

    const { org } = await createOrg(app, { name: "X", compTier: "free", publishPerHour: 5 });
    expect(org).toMatchObject({ tier: "free", compTier: "free", publishPerHour: 5 });
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

  it("a full org spends no register slot on either path", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app, {
      name: "Small",
      compTier: "paid",
      maxMembers: 2,
    });
    const lead = await mintAdmin(app, org.id);
    expect((await registerWithToken(app, joinToken, "a")).statusCode).toBe(201);
    const bucket = () =>
      db
        .prepare(`SELECT count FROM rate_limits WHERE bucket = ? AND action = 'register'`)
        .all(`org:${org.id}`);
    expect(bucket()).toEqual([{ count: 1 }]);
    const before = userCount(db);

    const viaToken = await registerWithToken(app, joinToken, "b");
    expect(viaToken.statusCode).toBe(403);
    expect(errorCode(viaToken)).toBe("org_full");
    const viaAdmin = await inject(app, {
      method: "POST",
      url: "/api/v1/org/keys",
      headers: auth(lead.token),
      payload: { name: "b" },
    });
    expect(viaAdmin.statusCode).toBe(403);
    expect(errorCode(viaAdmin)).toBe("org_full");
    expect(viaAdmin.json<ApiError>().error).toEqual(viaToken.json<ApiError>().error);
    expect(bucket()).toEqual([{ count: 1 }]);
    expect(userCount(db)).toBe(before);
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

  it("a member at the org's own tier skips the pool", async () => {
    const { app, db } = await setup();
    const { org } = await createOrg(app, { name: "Free", compTier: "free", publishPerHour: 1 });
    const user = createUser(db, { tier: "free--" });
    setUserTier(db, user.id, "free");
    createApiKeyRecord(db, { name: "free", token: "sp_free", userId: user.id });
    const attach = await admin(app, "PUT", `/api/v1/admin/users/${user.id}/org`, { orgId: org.id });
    expect(attach.statusCode).toBe(200);
    expect((await publish(app, helloSite(), "sp_free")).statusCode).toBe(201);
    expect((await publish(app, helloSite(), "sp_free")).statusCode).toBe(201);
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

  it("never detaches or demotes the only admin", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);
    const url = `/api/v1/admin/users/${lead.userId}/org`;
    const before = getUser(db, lead.userId);

    for (const body of [{ orgId: null }, { orgId: org.id, role: "member" }]) {
      const res = await admin(app, "PUT", url, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(409);
      expect(errorCode(res)).toBe("last_admin");
      expect(getUser(db, lead.userId)).toEqual(before);
    }
    const same = await admin(app, "PUT", url, { orgId: org.id, role: "admin" });
    expect(same.statusCode).toBe(200);
    expect(same.json<{ role: string }>().role).toBe("admin");

    const member = await joinAsMember(app, joinToken);
    const promoted = await admin(app, "PUT", `/api/v1/admin/users/${member.userId}/org`, {
      orgId: org.id,
      role: "admin",
    });
    expect(promoted.statusCode).toBe(200);
    const demoted = await admin(app, "PUT", url, { orgId: org.id, role: "member" });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json<{ role: string }>().role).toBe("member");
    expect(getUser(db, lead.userId)!.org_role).toBe("member");
    expect((await admin(app, "PUT", url, { orgId: org.id, role: "admin" })).statusCode).toBe(200);
    const detached = await admin(app, "PUT", url, { orgId: null });
    expect(detached.statusCode).toBe(200);
    expect(getUser(db, lead.userId)).toMatchObject({ org_id: null, org_role: null });
  });

  it("keeps the current role when role is omitted", async () => {
    const { app, db } = await setup();
    const { org } = await createOrg(app);
    const lead = await mintAdmin(app, org.id);

    const kept = await admin(app, "PUT", `/api/v1/admin/users/${lead.userId}/org`, {
      orgId: org.id,
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json<{ role: string }>().role).toBe("admin");
    expect(getUser(db, lead.userId)!.org_role).toBe("admin");

    const plain = (await register(app)).json<Minted>();
    const attached = await admin(app, "PUT", `/api/v1/admin/users/${plain.userId}/org`, {
      orgId: org.id,
    });
    expect(attached.statusCode).toBe(200);
    expect(attached.json<{ role: string }>().role).toBe("member");
    expect(getUser(db, plain.userId)!.org_role).toBe("member");
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

  it("reports the effective tier on the claim page", async () => {
    const workos = createFakeWorkOS("MagicAuth");
    const { app, db } = await setup({ workos: WORKOS_CONFIG }, workos.client);
    const { joinToken } = await createOrg(app);
    const member = await joinAsMember(app, joinToken);

    const page = await completeClaimFlow(app, member.claimUrl);
    expect(page.body).toContain("now has paid limits");
    expect(getUser(db, member.userId)!.tier).toBe("free-");
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

describe("operator: link a WorkOS organization", () => {
  it("links on create, relinks and unlinks on update, and shows the link", async () => {
    const workos = createFakeWorkOS();
    const { app, db } = await setup({ workos: WORKOS_CONFIG }, workos.client);
    const { org } = await createOrg(app, { name: "SkySlope", workosOrganizationId: WORKOS_ORG_A });
    expect(org.workosOrganizationId).toBe(WORKOS_ORG_A);
    expect(workos.organizationLookups).toEqual([WORKOS_ORG_A]);

    const relinked = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      workosOrganizationId: WORKOS_ORG_B,
    });
    expect(relinked.statusCode).toBe(200);
    expect(relinked.json<{ org: OrgAdmin }>().org.workosOrganizationId).toBe(WORKOS_ORG_B);

    const shown = await admin(app, "GET", `/api/v1/admin/orgs/${org.id}`);
    expect(shown.json<{ org: OrgAdmin }>().org.workosOrganizationId).toBe(WORKOS_ORG_B);
    const listed = await admin(app, "GET", "/api/v1/admin/orgs");
    expect(listed.json<{ orgs: OrgAdmin[] }>().orgs[0]!.workosOrganizationId).toBe(WORKOS_ORG_B);

    const unlinked = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      workosOrganizationId: null,
    });
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json<{ org: OrgAdmin }>().org.workosOrganizationId).toBeNull();
    const row = db.prepare(`SELECT workos_organization_id FROM orgs WHERE id = ?`).get(org.id) as {
      workos_organization_id: string | null;
    };
    expect(row.workos_organization_id).toBeNull();
    // Unlinking never asks WorkOS.
    expect(workos.organizationLookups).toEqual([WORKOS_ORG_A, WORKOS_ORG_B]);
  });

  it("refuses a WorkOS organization already linked elsewhere", async () => {
    const workos = createFakeWorkOS();
    const { app, db } = await setup({ workos: WORKOS_CONFIG }, workos.client);
    const { org: first } = await createOrg(app, { name: "A", workosOrganizationId: WORKOS_ORG_A });
    const { org: second } = await createOrg(app, { name: "B" });

    const dupCreate = await admin(app, "POST", "/api/v1/admin/orgs", {
      name: "C",
      workosOrganizationId: WORKOS_ORG_A,
    });
    expect(dupCreate.statusCode).toBe(409);
    expect(errorCode(dupCreate)).toBe("workos_org_linked");
    expect((await admin(app, "GET", "/api/v1/admin/orgs")).json<{ orgs: unknown[] }>().orgs)
      .toHaveLength(2);

    const dupUpdate = await admin(app, "PUT", `/api/v1/admin/orgs/${second.id}`, {
      workosOrganizationId: WORKOS_ORG_A,
    });
    expect(dupUpdate.statusCode).toBe(409);
    expect(errorCode(dupUpdate)).toBe("workos_org_linked");

    // Re-sending an org's own link is not a duplicate.
    const same = await admin(app, "PUT", `/api/v1/admin/orgs/${first.id}`, {
      workosOrganizationId: WORKOS_ORG_A,
    });
    expect(same.statusCode).toBe(200);

    // The index holds even for a write that skips the route's check.
    expect(() =>
      db
        .prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`)
        .run(WORKOS_ORG_A, second.id),
    ).toThrow(/UNIQUE constraint failed: orgs\.workos_organization_id/);
    // Any number of orgs can be unlinked.
    await createOrg(app, { name: "D" });
    const unlinkedCount = db
      .prepare(`SELECT COUNT(*) AS n FROM orgs WHERE workos_organization_id IS NULL`)
      .get() as { n: number };
    expect(Number(unlinkedCount.n)).toBe(2);
  });

  it("validates the id with WorkOS before storing it", async () => {
    const workos = createFakeWorkOS();
    const { app } = await setup({ workos: WORKOS_CONFIG }, workos.client);
    const { org } = await createOrg(app, { name: "SkySlope" });

    const unknown = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      workosOrganizationId: "org_01HNOSUCHORG",
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorCode(unknown)).toBe("unknown_workos_org");

    const unknownCreate = await admin(app, "POST", "/api/v1/admin/orgs", {
      name: "X",
      workosOrganizationId: "org_01HNOSUCHORG",
    });
    expect(unknownCreate.statusCode).toBe(400);
    expect(errorCode(unknownCreate)).toBe("unknown_workos_org");

    for (const bad of ["01HSKYSLOPE", "org_", "org_../users", "org_abc def", ""]) {
      const res = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
        workosOrganizationId: bad,
      });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe("validation_error");
    }
    expect(workos.organizationLookups).toEqual(["org_01HNOSUCHORG", "org_01HNOSUCHORG"]);

    workos.failOrganizationLookup = true;
    const down = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      workosOrganizationId: WORKOS_ORG_A,
    });
    expect(down.statusCode).toBe(502);
    expect(errorCode(down)).toBe("workos_unavailable");

    const missing = await admin(app, "PUT", "/api/v1/admin/orgs/nope", {
      workosOrganizationId: WORKOS_ORG_A,
    });
    expect(missing.statusCode).toBe(404);
    expect(workos.organizationLookups.filter((id) => id === WORKOS_ORG_A)).toHaveLength(1);

    const shown = await admin(app, "GET", `/api/v1/admin/orgs/${org.id}`);
    expect(shown.json<{ org: OrgAdmin }>().org.workosOrganizationId).toBeNull();
  });

  it("needs WorkOS configured to link, but never to unlink", async () => {
    const workos = createFakeWorkOS();
    // A client without config counts as unconfigured, as for claiming.
    const { app, db } = await setup({}, workos.client);
    const create = await admin(app, "POST", "/api/v1/admin/orgs", {
      name: "SkySlope",
      workosOrganizationId: WORKOS_ORG_A,
    });
    expect(create.statusCode).toBe(503);
    expect(errorCode(create)).toBe("workos_unconfigured");

    const { org } = await createOrg(app, { name: "SkySlope", workosOrganizationId: null });
    expect(org.workosOrganizationId).toBeNull();
    const link = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      workosOrganizationId: WORKOS_ORG_A,
    });
    expect(link.statusCode).toBe(503);
    expect(errorCode(link)).toBe("workos_unconfigured");
    expect(workos.organizationLookups).toEqual([]);

    // A link left over from when WorkOS was configured: the emergency unlink still works.
    db.prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`).run(WORKOS_ORG_A, org.id);
    const unlink = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      workosOrganizationId: null,
    });
    expect(unlink.statusCode).toBe(200);
    expect(unlink.json<{ org: OrgAdmin }>().org.workosOrganizationId).toBeNull();
  });

  it("works with no WorkOS client at all", async () => {
    const { app, db } = await setup();
    const { org } = await createOrg(app, { name: "SkySlope" });
    const link = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      workosOrganizationId: WORKOS_ORG_A,
    });
    expect(link.statusCode).toBe(503);
    db.prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`).run(WORKOS_ORG_A, org.id);
    const unlink = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
      workosOrganizationId: null,
    });
    expect(unlink.statusCode).toBe(200);
  });

  it("owner stats show only whether an org is linked", async () => {
    const workos = createFakeWorkOS();
    const { app, db } = await setup({ workos: WORKOS_CONFIG }, workos.client);
    await createOrg(app, { name: "Linked", workosOrganizationId: WORKOS_ORG_A });
    await createOrg(app, { name: "Plain" });
    const stats = getOwnerStats(db);
    expect(stats.orgs.workosLinked).toBe(1);
    // Both orgs have no members, so their order is by creation time and id.
    const linked = Object.fromEntries(stats.orgList.map((o) => [o.name, o.workosLinked]));
    expect(linked).toEqual({ Linked: 1, Plain: 0 });
    expect(JSON.stringify(stats)).not.toContain(WORKOS_ORG_A);
  });
});

interface SiteBody {
  id: string;
  url: string;
  versionId: string;
  slug: string | null;
  visibility: string;
}

/** A paid org linked to WORKOS_ORG_A with one token-registered member. */
async function linkedOrgSetup() {
  const workos = createFakeWorkOS();
  const harness = await setup({ workos: WORKOS_CONFIG }, workos.client);
  const { org, joinToken } = await createOrg(harness.app, {
    name: "SkySlope",
    compTier: "paid",
    workosOrganizationId: WORKOS_ORG_A,
  });
  const member = await joinAsMember(harness.app, joinToken);
  return { ...harness, workos, org, joinToken, member };
}

function republish(
  app: FastifyInstance,
  id: string,
  body: object,
  token: string,
): Promise<LightMyRequestResponse> {
  return inject(app, {
    method: "PUT",
    url: `/api/v1/sites/${id}`,
    headers: auth(token),
    payload: body,
    remoteAddress: IP,
  });
}

async function publishOrgSite(app: FastifyInstance, token: string): Promise<SiteBody> {
  const res = await publish(app, { ...helloSite(), visibility: "org" }, token);
  expect(res.statusCode).toBe(201);
  return res.json<SiteBody>();
}

function rawSite(db: DatabaseSync, id: string) {
  return db
    .prepare(
      `SELECT visibility, slug, current_version_id, audience_org_id, audience_workos_org_id,
              audience_version_id
       FROM sites WHERE id = ?`,
    )
    .get(id) as {
    visibility: string;
    slug: string | null;
    current_version_id: string;
    audience_org_id: string | null;
    audience_workos_org_id: string | null;
    audience_version_id: string | null;
  };
}

const NO_AUDIENCE = {
  audience_org_id: null,
  audience_workos_org_id: null,
  audience_version_id: null,
};

async function apiVisibility(app: FastifyInstance, id: string, token: string): Promise<string> {
  const res = await inject(app, { method: "GET", url: `/api/v1/sites/${id}`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json<SiteBody>().visibility;
}

/**
 * Hold the next S3 put until release(), so a test can run another write while
 * a publish is mid-upload. Only the first put pauses; the rest pass through.
 */
function pauseNextUpload(s3: FakeS3): { started: Promise<void>; release: () => void } {
  const client = s3.client as unknown as {
    send: (cmd: { constructor: { name: string } }) => Promise<unknown>;
  };
  const original = client.send;
  let open!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  let paused = false;
  client.send = async (cmd) => {
    if (!paused && cmd.constructor.name === "PutObjectCommand") {
      paused = true;
      markStarted();
      await gate;
    }
    return original(cmd);
  };
  return {
    started,
    release: () => {
      client.send = original;
      open();
    },
  };
}

/** Every version prefix in S3 belongs to a recorded version: no orphaned upload. */
function expectNoOrphanedVersions(db: DatabaseSync, s3: FakeS3, siteId: string): void {
  const stored = new Set(
    s3.keysUnder(`sites/${siteId}/v/`).map((key) => key.split("/")[3]!),
  );
  const recorded = new Set(
    (
      db.prepare(`SELECT id FROM site_versions WHERE site_id = ?`).all(siteId) as { id: string }[]
    ).map((r) => r.id),
  );
  for (const version of stored) expect(recorded.has(version)).toBe(true);
}

describe("org visibility: create", () => {
  it("stores an org site as private plus an audience and reports it as org", async () => {
    const { app, db, org, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    expect(site.visibility).toBe("org");
    expect(site.slug).toBeNull();

    // The raw row is private, so anything that misses the audience fails closed.
    expect(rawSite(db, site.id)).toEqual({
      visibility: "private",
      slug: null,
      current_version_id: site.versionId,
      audience_org_id: org.id,
      audience_workos_org_id: WORKOS_ORG_A,
      audience_version_id: site.versionId,
    });

    expect(await apiVisibility(app, site.id, member.token)).toBe("org");
    const list = await inject(app, { method: "GET", url: "/api/v1/sites", headers: auth(member.token) });
    expect(list.json<{ sites: SiteBody[] }>().sites.map((s) => s.visibility)).toEqual(["org"]);
    const lead = await mintAdmin(app, org.id);
    const orgSites = await inject(app, {
      method: "GET",
      url: "/api/v1/org/sites",
      headers: auth(lead.token),
    });
    expect(orgSites.json<{ sites: SiteBody[] }>().sites.map((s) => s.visibility)).toEqual(["org"]);
  });

  it("serves an org site exactly like a private one: owner key only", async () => {
    const { app, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    const anonymous = await inject(app, { method: "GET", url: `/s/${site.id}/` });
    expect(anonymous.statusCode).toBe(401);
    const otherKey = await inject(app, { method: "GET", url: `/s/${site.id}/`, headers: auth() });
    expect(otherKey.statusCode).toBe(404);
    const owner = await inject(app, {
      method: "GET",
      url: `/s/${site.id}/`,
      headers: auth(member.token),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain("hello");
    expect(owner.headers["cache-control"]).toBe("private, no-store");
  });

  it("needs the caller's org linked to WorkOS", async () => {
    const workos = createFakeWorkOS();
    const { app } = await setup({ workos: WORKOS_CONFIG }, workos.client);
    const { joinToken } = await createOrg(app, { name: "Unlinked", compTier: "paid" });
    const member = await joinAsMember(app, joinToken);
    const unlinked = await publish(app, { ...helloSite(), visibility: "org" }, member.token);
    expect(unlinked.statusCode).toBe(400);
    expect(errorCode(unlinked)).toBe("visibility_not_allowed");

    // An account outside any org, here the operator key.
    const noOrg = await publish(app, { ...helloSite(), visibility: "org" });
    expect(noOrg.statusCode).toBe(400);
    expect(errorCode(noOrg)).toBe("visibility_not_allowed");
  });

  it("is refused when WorkOS is not configured, even with a leftover link", async () => {
    const { app, db } = await setup();
    const { org, joinToken } = await createOrg(app, { name: "SkySlope", compTier: "paid" });
    db.prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`).run(WORKOS_ORG_A, org.id);
    const member = await joinAsMember(app, joinToken);
    const res = await publish(app, { ...helloSite(), visibility: "org" }, member.token);
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe("visibility_not_allowed");
  });

  it("never takes a vanity slug, even on a tier that allows slugs", async () => {
    const { app, s3, member } = await linkedOrgSetup();
    const res = await publish(app, { ...helloSite(), visibility: "org", slug: "plan" }, member.token);
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe("slug_not_allowed");
    // The same member may still take a slug on an ordinary site.
    expect((await publish(app, { ...helloSite(), slug: "plan" }, member.token)).statusCode).toBe(201);
    expect(s3.keysUnder("sites/").length).toBe(1);
  });
});

describe("org visibility: republish", () => {
  it("keeps org when visibility is omitted or org, on the new version", async () => {
    const { app, db, org, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);

    const omitted = await republish(app, site.id, helloSite("<h1>v2</h1>"), member.token);
    expect(omitted.statusCode).toBe(200);
    const v2 = omitted.json<SiteBody>();
    expect(v2.visibility).toBe("org");
    expect(rawSite(db, site.id)).toMatchObject({
      visibility: "private",
      audience_org_id: org.id,
      audience_workos_org_id: WORKOS_ORG_A,
      audience_version_id: v2.versionId,
    });

    const explicit = await republish(
      app,
      site.id,
      { ...helloSite("<h1>v3</h1>"), visibility: "org" },
      member.token,
    );
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json<SiteBody>().visibility).toBe("org");
    expect(rawSite(db, site.id).audience_version_id).toBe(explicit.json<SiteBody>().versionId);
  });

  it("any other explicit visibility clears the audience", async () => {
    const { app, db, member } = await linkedOrgSetup();
    for (const visibility of ["private", "unlisted", "public"]) {
      const site = await publishOrgSite(app, member.token);
      const res = await republish(app, site.id, { ...helloSite(), visibility }, member.token);
      expect(res.statusCode).toBe(200);
      expect(res.json<SiteBody>().visibility).toBe(visibility);
      expect(rawSite(db, site.id)).toMatchObject({ visibility, ...NO_AUDIENCE });
      // Once it is not org, it cannot go back in place.
      const back = await republish(app, site.id, { ...helloSite(), visibility: "org" }, member.token);
      expect(back.statusCode).toBe(400);
      expect(errorCode(back)).toBe("org_requires_new_site");
    }
  });

  it("refuses org on a site that is not org now", async () => {
    const { app, db, s3, member } = await linkedOrgSetup();
    for (const visibility of ["unlisted", "private", "public"]) {
      const site = (await publish(app, { ...helloSite(), visibility }, member.token)).json<SiteBody>();
      const res = await republish(app, site.id, { ...helloSite(), visibility: "org" }, member.token);
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe("org_requires_new_site");
      expect(rawSite(db, site.id)).toMatchObject({ visibility, ...NO_AUDIENCE });
      expect(s3.keysUnder(`sites/${site.id}/`)).toHaveLength(1);
    }
  });

  it("refuses a slug on an org site", async () => {
    const { app, db, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    for (const body of [
      { ...helloSite(), slug: "plan" },
      { ...helloSite(), slug: "plan", visibility: "public" },
    ]) {
      const res = await republish(app, site.id, body, member.token);
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe("slug_not_allowed");
    }
    expect(rawSite(db, site.id)).toMatchObject({ slug: null, audience_version_id: site.versionId });
  });

  it("an omitted visibility on a site whose audience lapsed stays owner-only private", async () => {
    const { app, db, org, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    // Out of band, as an older binary would relink.
    db.prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`).run(WORKOS_ORG_B, org.id);
    const res = await republish(app, site.id, helloSite("<h1>v2</h1>"), member.token);
    expect(res.statusCode).toBe(200);
    expect(res.json<SiteBody>().visibility).toBe("private");
    // Never rebinds to the new link.
    expect(rawSite(db, site.id)).toMatchObject({ visibility: "private", ...NO_AUDIENCE });
  });

  it("touch keeps the audience", async () => {
    const { app, db, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    const before = rawSite(db, site.id);
    const res = await inject(app, {
      method: "POST",
      url: `/api/v1/sites/${site.id}/touch`,
      headers: auth(member.token),
      remoteAddress: IP,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SiteBody>().visibility).toBe("org");
    expect(rawSite(db, site.id)).toEqual(before);
  });
});

describe("reserved __shareplan/ paths", () => {
  it("are refused on create and republish, for every visibility", async () => {
    const { app, s3, member } = await linkedOrgSetup();
    const reserved = (path: string) => ({
      files: [
        { path: "index.html", content: "<h1>hi</h1>" },
        { path, content: "x" },
      ],
    });
    for (const path of ["__shareplan/session.html", "__SHAREPLAN/x.css", "__shareplan/nested/a.js"]) {
      for (const visibility of ["org", "unlisted"]) {
        const res = await publish(app, { ...reserved(path), visibility }, member.token);
        expect(res.statusCode).toBe(400);
        expect(errorCode(res)).toBe("reserved_path");
      }
    }
    expect(s3.keysUnder("sites/")).toEqual([]);

    const orgSite = await publishOrgSite(app, member.token);
    const plain = (await publish(app, helloSite(), member.token)).json<SiteBody>();
    for (const id of [orgSite.id, plain.id]) {
      const res = await republish(app, id, reserved("__shareplan/x.html"), member.token);
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe("reserved_path");
      expect(s3.keysUnder(`sites/${id}/`)).toHaveLength(1);
    }
    // A name that only starts like it is fine.
    const near = await publish(app, reserved("__shareplanned/x.html"), member.token);
    expect(near.statusCode).toBe(201);
  });
});

describe("org visibility: create race", () => {
  const changes: [string, (h: Awaited<ReturnType<typeof linkedOrgSetup>>) => Promise<void>][] = [
    [
      "detach",
      async ({ app, member }) => {
        const res = await admin(app, "PUT", `/api/v1/admin/users/${member.userId}/org`, { orgId: null });
        expect(res.statusCode).toBe(200);
      },
    ],
    [
      "relink",
      async ({ app, org }) => {
        const res = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
          workosOrganizationId: WORKOS_ORG_B,
        });
        expect(res.statusCode).toBe(200);
      },
    ],
  ];

  it("a paused org create loses to a detach or relink, and writes nothing", async () => {
    for (const [label, change] of changes) {
      const h = await linkedOrgSetup();
      const pause = pauseNextUpload(h.s3);
      const slow = publish(h.app, { ...helloSite(), visibility: "org" }, h.member.token);
      await pause.started;
      await change(h);
      pause.release();
      const res = await slow;
      expect(res.statusCode, label).toBe(409);
      expect(errorCode(res), label).toBe("site_changed");
      expect(h.db.prepare(`SELECT COUNT(*) AS n FROM sites`).get(), label).toEqual({ n: 0 });
      expect(h.db.prepare(`SELECT COUNT(*) AS n FROM site_versions`).get(), label).toEqual({ n: 0 });
      expect(h.s3.keysUnder("sites/"), label).toEqual([]);
    }
  });

  it("re-attaching after a lost create does not leave an org site behind", async () => {
    const h = await linkedOrgSetup();
    const pause = pauseNextUpload(h.s3);
    const slow = publish(h.app, { ...helloSite(), visibility: "org" }, h.member.token);
    await pause.started;
    await changes[0]![1](h);
    pause.release();
    expect((await slow).statusCode).toBe(409);
    const back = await admin(h.app, "PUT", `/api/v1/admin/users/${h.member.userId}/org`, {
      orgId: h.org.id,
    });
    expect(back.statusCode).toBe(200);
    const list = await inject(h.app, { method: "GET", url: "/api/v1/sites", headers: auth(h.member.token) });
    expect(list.json<{ sites: SiteBody[] }>().sites).toEqual([]);
  });

  it("a paused org create with nothing in between still lands", async () => {
    const { app, db, s3, org, member } = await linkedOrgSetup();
    const pause = pauseNextUpload(s3);
    const slow = publish(app, { ...helloSite(), visibility: "org" }, member.token);
    await pause.started;
    pause.release();
    const res = await slow;
    expect(res.statusCode).toBe(201);
    const site = res.json<SiteBody>();
    expect(site.visibility).toBe("org");
    expect(rawSite(db, site.id)).toMatchObject({ audience_org_id: org.id, audience_version_id: site.versionId });
  });
});

describe("org visibility: republish race", () => {
  it("a paused org republish loses to a concurrent public, private, or relink write", async () => {
    const concurrent: [string, (h: Awaited<ReturnType<typeof linkedOrgSetup>>, id: string) => Promise<void>][] = [
      [
        "public publish",
        async ({ app, member }, id) => {
          const res = await republish(app, id, { ...helloSite("<h1>pub</h1>"), visibility: "public" }, member.token);
          expect(res.statusCode).toBe(200);
        },
      ],
      [
        "private publish",
        async ({ app, member }, id) => {
          const res = await republish(app, id, { ...helloSite("<h1>pri</h1>"), visibility: "private" }, member.token);
          expect(res.statusCode).toBe(200);
        },
      ],
      [
        "relink",
        async ({ app, org }) => {
          const res = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, {
            workosOrganizationId: WORKOS_ORG_B,
          });
          expect(res.statusCode).toBe(200);
        },
      ],
    ];
    for (const [label, write] of concurrent) {
      const h = await linkedOrgSetup();
      const site = await publishOrgSite(h.app, h.member.token);
      const pause = pauseNextUpload(h.s3);
      const slow = republish(h.app, site.id, helloSite("<h1>slow</h1>"), h.member.token);
      await pause.started;
      await write(h, site.id);
      const afterWrite = h.db.prepare(`SELECT * FROM sites WHERE id = ?`).get(site.id);
      pause.release();
      const res = await slow;
      expect(res.statusCode, label).toBe(409);
      expect(errorCode(res), label).toBe("site_changed");
      expect(h.db.prepare(`SELECT * FROM sites WHERE id = ?`).get(site.id), label).toEqual(afterWrite);
      expect(await apiVisibility(h.app, site.id, h.member.token), label).not.toBe("org");
      expectNoOrphanedVersions(h.db, h.s3, site.id);
      const versions = h.db
        .prepare(`SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ?`)
        .get(site.id) as { n: number };
      expect(Number(versions.n), label).toBe(label === "relink" ? 1 : 2);
    }
  });

  it("a paused org republish loses to a concurrent org republish", async () => {
    const { app, db, s3, org, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    const pause = pauseNextUpload(s3);
    const slow = republish(app, site.id, helloSite("<h1>slow</h1>"), member.token);
    await pause.started;
    const fast = await republish(app, site.id, helloSite("<h1>fast</h1>"), member.token);
    expect(fast.statusCode).toBe(200);
    const v2 = fast.json<SiteBody>();
    expect(v2.visibility).toBe("org");
    const afterFast = db.prepare(`SELECT * FROM sites WHERE id = ?`).get(site.id);
    pause.release();
    const res = await slow;
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe("site_changed");
    // The faster version stands, with its audience, and the slower upload is gone.
    expect(db.prepare(`SELECT * FROM sites WHERE id = ?`).get(site.id)).toEqual(afterFast);
    expect(rawSite(db, site.id)).toMatchObject({
      current_version_id: v2.versionId,
      audience_org_id: org.id,
      audience_version_id: v2.versionId,
    });
    expectNoOrphanedVersions(db, s3, site.id);
    const owner = await inject(app, { method: "GET", url: `/s/${site.id}/`, headers: auth(member.token) });
    expect(owner.body).toContain("fast");
  });

  it("a paused org republish with nothing in between still lands", async () => {
    const { app, db, s3, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    const pause = pauseNextUpload(s3);
    const slow = republish(app, site.id, helloSite("<h1>slow</h1>"), member.token);
    await pause.started;
    pause.release();
    const res = await slow;
    expect(res.statusCode).toBe(200);
    expect(res.json<SiteBody>().visibility).toBe("org");
    expect(rawSite(db, site.id).audience_version_id).toBe(res.json<SiteBody>().versionId);
  });

  it("plain republishes stay last-writer-wins", async () => {
    const { app, db, s3, member } = await linkedOrgSetup();
    const site = (await publish(app, helloSite(), member.token)).json<SiteBody>();
    const pause = pauseNextUpload(s3);
    const slow = republish(app, site.id, { ...helloSite("<h1>slow</h1>"), visibility: "private" }, member.token);
    await pause.started;
    const fast = await republish(app, site.id, { ...helloSite("<h1>fast</h1>"), visibility: "public" }, member.token);
    expect(fast.statusCode).toBe(200);
    pause.release();
    const res = await slow;
    expect(res.statusCode).toBe(200);
    expect(rawSite(db, site.id).visibility).toBe("private");
  });
});

describe("org visibility fails closed", () => {
  it("an old-style write of visibility and version without the audience makes it owner-only", async () => {
    const { app, db, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    // What the previous binary's republish writes: it knows nothing of audiences.
    db.prepare(
      `INSERT INTO site_versions (id, site_id, created_at, byte_size, file_count, note)
       VALUES ('v_old_binary', ?, ?, 1, 1, NULL)`,
    ).run(site.id, Date.now());
    db.prepare(
      `UPDATE sites SET current_version_id = 'v_old_binary', visibility = COALESCE(NULL, visibility)
       WHERE id = ?`,
    ).run(site.id);
    expect(rawSite(db, site.id)).toMatchObject({
      visibility: "private",
      audience_version_id: site.versionId,
    });
    expect(await apiVisibility(app, site.id, member.token)).toBe("private");
    // And a later republish on this binary does not revive it.
    const res = await republish(app, site.id, helloSite(), member.token);
    expect(res.json<SiteBody>().visibility).toBe("private");
    expect(rawSite(db, site.id)).toMatchObject(NO_AUDIENCE);
  });

  it("a relink, an unlink, a detach, and a delete each make it owner-only", async () => {
    const steps: [string, (h: Awaited<ReturnType<typeof linkedOrgSetup>>) => Promise<LightMyRequestResponse>][] = [
      ["relink", ({ app, org }) => admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, { workosOrganizationId: WORKOS_ORG_B })],
      ["unlink", ({ app, org }) => admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, { workosOrganizationId: null })],
      ["detach", ({ app, member }) => admin(app, "PUT", `/api/v1/admin/users/${member.userId}/org`, { orgId: null })],
      ["remove", async ({ app, org, member }) => {
        const lead = await mintAdmin(app, org.id);
        return inject(app, { method: "DELETE", url: `/api/v1/org/members/${member.userId}`, headers: auth(lead.token) });
      }],
      ["delete", ({ app, org }) => admin(app, "DELETE", `/api/v1/admin/orgs/${org.id}`)],
    ];
    for (const [label, step] of steps) {
      const h = await linkedOrgSetup();
      const site = await publishOrgSite(h.app, h.member.token);
      const res = await step(h);
      expect(res.statusCode, label).toBe(200);
      expect(rawSite(h.db, site.id), label).toMatchObject({ visibility: "private", ...NO_AUDIENCE });
      expect(await apiVisibility(h.app, site.id, h.member.token), label).toBe("private");
      const anonymous = await inject(h.app, { method: "GET", url: `/s/${site.id}/` });
      expect(anonymous.statusCode, label).toBe(401);
    }
  });

  it("the link-change and delete clamps report the cleared sites", async () => {
    const h = await linkedOrgSetup();
    await publishOrgSite(h.app, h.member.token);
    await publishOrgSite(h.app, h.member.token);
    const relink = await admin(h.app, "PUT", `/api/v1/admin/orgs/${h.org.id}`, {
      workosOrganizationId: WORKOS_ORG_B,
    });
    expect(relink.json<{ clamped: object }>().clamped).toEqual({ users: 0, sites: 2, skipped: 0 });
    // Re-sending the same link is not a change.
    const same = await admin(h.app, "PUT", `/api/v1/admin/orgs/${h.org.id}`, {
      workosOrganizationId: WORKOS_ORG_B,
    });
    expect(same.json<{ clamped: object }>().clamped).toEqual({ users: 0, sites: 0, skipped: 0 });

    await publishOrgSite(h.app, h.member.token);
    const deleted = await admin(h.app, "DELETE", `/api/v1/admin/orgs/${h.org.id}`);
    expect(deleted.statusCode).toBe(200);
    // One audience cleared; the paid member's three permanent sites get expiries.
    expect(deleted.json<{ clamped: object }>().clamped).toEqual({ users: 1, sites: 3, skipped: 0 });
  });

  // Raw SQL stands in for a rolled-back binary: it writes users and orgs
  // without knowing the audience columns, so only the triggers can clear them.
  it("an old binary's detach then re-attach does not revive the audience", async () => {
    const { app, db, org, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    db.prepare(`UPDATE users SET org_id = NULL, org_role = NULL WHERE id = ?`).run(member.userId);
    expect(rawSite(db, site.id)).toMatchObject({ visibility: "private", ...NO_AUDIENCE });
    expect(await apiVisibility(app, site.id, member.token)).toBe("private");
    // Every value honouredAudience compares is back as it was.
    db.prepare(`UPDATE users SET org_id = ?, org_role = 'member' WHERE id = ?`).run(org.id, member.userId);
    expect(rawSite(db, site.id)).toMatchObject({ visibility: "private", ...NO_AUDIENCE });
    expect(await apiVisibility(app, site.id, member.token)).toBe("private");
    expect((await inject(app, { method: "GET", url: `/s/${site.id}/` })).statusCode).toBe(401);
  });

  it("an old binary's relink A to B and back to A does not revive the audience", async () => {
    const { app, db, org, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    const other = await publishOrgSite(app, member.token);
    db.prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`).run(WORKOS_ORG_B, org.id);
    expect(rawSite(db, site.id)).toMatchObject(NO_AUDIENCE);
    expect(await apiVisibility(app, site.id, member.token)).toBe("private");
    db.prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`).run(WORKOS_ORG_A, org.id);
    for (const id of [site.id, other.id]) {
      expect(rawSite(db, id)).toMatchObject({ visibility: "private", ...NO_AUDIENCE });
      expect(await apiVisibility(app, id, member.token)).toBe("private");
    }
    // Unlink and relink to A through slice 2's own method: same result.
    const third = await publishOrgSite(app, member.token);
    for (const workosOrganizationId of [null, WORKOS_ORG_A]) {
      const res = await admin(app, "PUT", `/api/v1/admin/orgs/${org.id}`, { workosOrganizationId });
      expect(res.statusCode).toBe(200);
    }
    expect(rawSite(db, third.id)).toMatchObject(NO_AUDIENCE);
    expect(await apiVisibility(app, third.id, member.token)).toBe("private");
    // A write that keeps the link, or touches other columns, keeps the audience.
    const kept = await publishOrgSite(app, member.token);
    db.prepare(`UPDATE orgs SET workos_organization_id = ?, name = 'Renamed' WHERE id = ?`).run(
      WORKOS_ORG_A,
      org.id,
    );
    db.prepare(`UPDATE users SET org_role = 'admin' WHERE id = ?`).run(member.userId);
    expect(await apiVisibility(app, kept.id, member.token)).toBe("org");
  });

  it("an old binary's delete clears audiences naming the org instead of failing", async () => {
    const { app, db, org, member } = await linkedOrgSetup();
    await publishOrgSite(app, member.token);
    // A leftover audience on a site whose owner is not in the org: detaching
    // the members does not reach it, so only the delete trigger can.
    const stray = (await publish(app, { ...helloSite(), visibility: "private" })).json<SiteBody>();
    db.prepare(
      `UPDATE sites SET audience_org_id = ?, audience_workos_org_id = ?, audience_version_id = ?
       WHERE id = ?`,
    ).run(org.id, WORKOS_ORG_A, stray.versionId, stray.id);
    db.prepare(`UPDATE users SET org_id = NULL, org_role = NULL WHERE org_id = ?`).run(org.id);
    // Foreign keys are on; without the trigger this would fail.
    db.prepare(`DELETE FROM orgs WHERE id = ?`).run(org.id);
    expect(rawSite(db, stray.id)).toMatchObject({ visibility: "private", ...NO_AUDIENCE });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM sites WHERE audience_org_id IS NOT NULL`).get(),
    ).toEqual({ n: 0 });
  });

  it("the per-request check refuses a stale audience on its own", async () => {
    const { app, db, org, member } = await linkedOrgSetup();
    // Without the triggers, as on a database they never reached.
    db.exec(`
      DROP TRIGGER trg_users_org_change_clears_audience;
      DROP TRIGGER trg_orgs_link_change_clears_audience;
    `);
    const site = await publishOrgSite(app, member.token);
    db.prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`).run(WORKOS_ORG_B, org.id);
    expect(rawSite(db, site.id).audience_workos_org_id).toBe(WORKOS_ORG_A);
    expect(await apiVisibility(app, site.id, member.token)).toBe("private");
    db.prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`).run(WORKOS_ORG_A, org.id);
    db.prepare(`UPDATE users SET org_id = NULL, org_role = NULL WHERE id = ?`).run(member.userId);
    expect(rawSite(db, site.id).audience_org_id).toBe(org.id);
    expect(await apiVisibility(app, site.id, member.token)).toBe("private");
  });

  it("detach and remove count a cleared audience once", async () => {
    for (const label of ["detach", "remove"]) {
      const h = await linkedOrgSetup();
      await publishOrgSite(h.app, h.member.token);
      const lead = await mintAdmin(h.app, h.org.id);
      const res =
        label === "detach"
          ? await admin(h.app, "PUT", `/api/v1/admin/users/${h.member.userId}/org`, { orgId: null })
          : await inject(h.app, {
              method: "DELETE",
              url: `/api/v1/org/members/${h.member.userId}`,
              headers: auth(lead.token),
            });
      expect(res.statusCode, label).toBe(200);
      // The audience and the expiry clamp land on the same site.
      expect(res.json<{ clampedSites: number }>().clampedSites, label).toBe(1);
    }
  });

  it("clamps only audiences that no longer match", async () => {
    const h = await linkedOrgSetup();
    const site = await publishOrgSite(h.app, h.member.token);
    // A tier change runs the member clamp, but the audience still matches.
    const tier = await admin(h.app, "PUT", `/api/v1/admin/orgs/${h.org.id}`, { compTier: "free" });
    expect(tier.statusCode).toBe(200);
    expect(rawSite(h.db, site.id).audience_version_id).toBe(site.versionId);
    expect(await apiVisibility(h.app, site.id, h.member.token)).toBe("org");
    // A role change too.
    const role = await admin(h.app, "PUT", `/api/v1/admin/users/${h.member.userId}/org`, {
      orgId: h.org.id,
      role: "admin",
    });
    expect(role.statusCode).toBe(200);
    expect(await apiVisibility(h.app, site.id, h.member.token)).toBe("org");
  });

  it("clears a stale audience on detach even when the owner's own tier is unknown", async () => {
    const { app, db, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    db.prepare(`UPDATE users SET tier = 'mystery' WHERE id = ?`).run(member.userId);
    const res = await admin(app, "PUT", `/api/v1/admin/users/${member.userId}/org`, { orgId: null });
    expect(res.statusCode).toBe(200);
    expect(rawSite(db, site.id)).toMatchObject(NO_AUDIENCE);
    // The tier clamp is skipped, but the cleared audience still counts.
    expect(res.json<{ clampedSites: number }>().clampedSites).toBe(1);
  });

  it("owner stats count org sites through the same check", async () => {
    const { app, db, org, member } = await linkedOrgSetup();
    const site = await publishOrgSite(app, member.token);
    await publish(app, { ...helloSite(), visibility: "private" }, member.token);
    await publish(app, helloSite(), member.token);
    const counts = () => Object.fromEntries(getOwnerStats(db).visibility.map((v) => [v.visibility, v.count]));
    expect(counts()).toEqual({ org: 1, private: 1, unlisted: 1 });
    expect(getOwnerStats(db).recentSites.find((s) => s.id === site.id)!.visibility).toBe("org");
    db.prepare(`UPDATE orgs SET workos_organization_id = ? WHERE id = ?`).run(WORKOS_ORG_B, org.id);
    expect(counts()).toEqual({ private: 2, unlisted: 1 });
    expect(getOwnerStats(db).recentSites.find((s) => s.id === site.id)!.visibility).toBe("private");
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
