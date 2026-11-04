import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp, redactQuerySecrets, type WorkOSAuthClient } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import {
  createApiKeyRecord, createOrg, createUser, deleteSite, hashApiKey, openDb, setUserOrg,
  updateOrg, upgrade,
} from "./db.js";
import { reapExpiredSites } from "./reap.js";
import { ORG_HTML_CSP, ORG_SVG_CSP } from "./site-access.js";
import { createFakeS3 } from "./testing/fake-s3.js";
import { VIEW_CALLBACK_PATH } from "./viewer.js";
import type { SiteSession, ViewerSession } from "./viewer-db.js";

const NOW = 1_800_000_030_000;
const ORG = "org_skyslope";
const BASE = "https://shareplan.localhost";
const SUFFIX = "shareplan.localhost";
const ADMIN = "admin-token-for-tests";
const OWNER_KEY = "sp_publisher";
const SITE_COOKIE = "__Host-shareplan_site";
const NONCE_COOKIE = "__Host-shareplan_site_nonce";
const VIEW_COOKIE = "__Host-shareplan_viewer";
/** A top-level navigation the user started (address bar, bookmark). */
const NAV = { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
type Claims = { sid?: unknown; org_id?: unknown; sub?: unknown; auth_time?: unknown };
type Authentication = Awaited<ReturnType<WorkOSAuthClient["userManagement"]["authenticateWithCode"]>>;

function accessToken(claims: Claims): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function fakeWorkOS() {
  const claims: Claims = { sid: "session_workos", org_id: ORG, sub: "user_workos", auth_time: NOW / 1000 };
  const response: Authentication = {
    user: { id: "user_workos", email: "Viewer@SkySlope.example", emailVerified: true },
    organizationId: ORG, authenticationMethod: "SSO", accessToken: "",
  };
  let state = 0;
  const authorize = vi.fn<WorkOSAuthClient["userManagement"]["getAuthorizationUrlWithPKCE"]>(async () => {
    state += 1;
    return { state: `state_${state}`, codeVerifier: `verifier_${state}`, url: `https://auth.test/authorize?state=state_${state}` };
  });
  const authenticate = vi.fn<WorkOSAuthClient["userManagement"]["authenticateWithCode"]>(async () => ({
    ...structuredClone(response), accessToken: accessToken(claims),
  }));
  const client: WorkOSAuthClient = {
    userManagement: {
      getAuthorizationUrlWithPKCE: authorize, authenticateWithCode: authenticate,
      getLogoutUrl: (opts) => `https://auth.test/logout?session_id=${opts.sessionId}`,
    },
    organizations: { getOrganization: async (id) => ({ id, name: "SkySlope" }) },
  };
  return { client, authorize, authenticate, response, claims };
}

const open: { app: FastifyInstance; db: ReturnType<typeof openDb> }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  const seen = new Set<unknown>();
  for (const h of open.splice(0)) {
    await h.app.close();
    if (!seen.has(h.db)) { seen.add(h.db); h.db.close(); }
  }
});

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      SHAREPLAN_DATA_DIR: "/tmp", SHAREPLAN_PUBLIC_BASE_URL: BASE, SHAREPLAN_SITE_HOST_SUFFIX: SUFFIX,
      SHAREPLAN_IP_HASH_PEPPER: "test-pepper", SHAREPLAN_ADMIN_TOKEN: ADMIN,
      WORKOS_API_KEY: "sk_test", WORKOS_CLIENT_ID: "client_test",
      WORKOS_REDIRECT_URI: `${BASE}/v1/auth/workos/callback`,
    }),
    ...overrides,
  };
}

type Inject = (url: string, opts?: { method?: "GET" | "HEAD" | "POST" | "PUT"; cookie?: string; headers?: Record<string, string>; payload?: unknown }) => Promise<LightMyRequestResponse>;

function injector(app: FastifyInstance): Inject {
  return (url, opts = {}) => {
    const target = new URL(url);
    return app.inject({
      method: opts.method ?? "GET",
      url: `${target.pathname}${target.search}`,
      remoteAddress: "203.0.113.10",
      headers: { host: target.host, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
      ...(opts.payload !== undefined ? { payload: opts.payload as Record<string, unknown> } : {}),
    });
  };
}

async function setup(overrides: Partial<Config> = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const config = testConfig(overrides);
  const db = openDb(":memory:");
  const s3 = createFakeS3();
  const workos = fakeWorkOS();
  const app = await buildApp({ config, db, s3: s3.client, workos: workos.client, logger: false });
  open.push({ app, db });
  const org = createOrg(db, { name: "SkySlope", compTier: "paid", joinToken: "org_test", workosOrganizationId: ORG });
  const user = createUser(db, { tier: "free--" });
  setUserOrg(db, user, org, "member", NOW);
  createApiKeyRecord(db, { name: "publisher", token: OWNER_KEY, userId: user.id });
  const other = createUser(db, { tier: "free--" });
  createApiKeyRecord(db, { name: "other", token: "sp_other", userId: other.id });
  const get = injector(app);
  const publish = async (visibility: string) => {
    const res = await get(`${BASE}/api/v1/sites`, {
      method: "POST", headers: { authorization: `Bearer ${OWNER_KEY}` },
      payload: { visibility, files: [
        { path: "index.html", content: "<!doctype html><h1>Org home</h1>" },
        { path: "report.html", content: "<!doctype html><h1>Quarterly report</h1>" },
        { path: "docs/index.html", content: "<!doctype html><h1>Docs</h1>" },
        { path: "style.css", content: "h1 { color: teal }" },
        { path: "logo.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
        { path: "data.json", content: "{\"secret\":42}" },
      ] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const site = res.json<{ id: string; url: string; visibility: string }>();
    expect(site.visibility).toBe(visibility);
    return site;
  };
  const siteA = await publish("org");
  const siteB = await publish("org");
  return { app, db, s3, config, workos, org, user, get, publish, siteA, siteB };
}
type H = Awaited<ReturnType<typeof setup>>;

function setCookies(res: LightMyRequestResponse): string[] {
  const header = res.headers["set-cookie"];
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
}
function setCookie(res: LightMyRequestResponse, name: string): string | undefined {
  // Site nonces carry a slot suffix: __Host-shareplan_site_nonce_<8 hex>.
  const slotted = name === NONCE_COOKIE ? new RegExp(`^${name}_[a-f0-9]{8}=`) : null;
  return setCookies(res).find((c) => c.startsWith(`${name}=`) || (slotted?.test(c) ?? false));
}
function pair(res: LightMyRequestResponse, name: string): string {
  const header = setCookie(res, name);
  if (!header) throw new Error(`missing cookie ${name}`);
  return header.split(";", 1)[0]!;
}
function value(cookiePair: string): string {
  return cookiePair.slice(cookiePair.indexOf("=") + 1);
}
function flowPair(res: LightMyRequestResponse): string {
  const header = setCookies(res).find((c) => c.includes("shareplan_view_flow_"));
  if (!header) throw new Error("missing flow cookie");
  return header.split(";", 1)[0]!;
}
function siteSessions(h: H): SiteSession[] {
  return h.db.prepare("SELECT * FROM site_sessions ORDER BY created_at, rowid").all() as unknown as SiteSession[];
}
function viewerSessions(h: H): ViewerSession[] {
  return h.db.prepare("SELECT * FROM viewer_sessions").all() as unknown as ViewerSession[];
}

function expectOrgHeaders(res: LightMyRequestResponse, csp = ORG_HTML_CSP) {
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.headers.vary).toBe("Cookie, Authorization");
  expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(res.headers["x-frame-options"]).toBe("DENY");
  expect(res.headers["content-security-policy"]).toBe(csp);
  expect(res.headers["content-security-policy"]).toContain("worker-src 'none'");
  for (const name of Object.keys(res.headers)) expect(name).not.toMatch(/^access-control-/);
}

/** Navigate to an org site, sign in through the fake WorkOS and redeem the grant. */
async function signIn(h: H, siteUrl: string, path = "/report.html?tab=2", opts: { nonceCookie?: string; viewerCookie?: string } = {}) {
  const first = await h.get(new URL(path, siteUrl).href, { headers: NAV, cookie: opts.nonceCookie });
  expect(first.statusCode).toBe(302);
  const nonceCookie = pair(first, NONCE_COOKIE);
  const startUrl = new URL(first.headers.location as string);
  const started = await h.get(startUrl.href, { cookie: opts.viewerCookie, headers: { ...NAV, "sec-fetch-site": "same-site" } });
  expect(started.statusCode).toBe(302);
  let grant = started;
  let viewerCookie = opts.viewerCookie;
  if (!(started.headers.location as string).includes("/__shareplan/session")) {
    const state = new URL(started.headers.location as string).searchParams.get("state")!;
    grant = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=auth_code&state=${state}`, {
      cookie: flowPair(started), headers: { ...NAV, "sec-fetch-site": "cross-site" },
    });
    expect(grant.statusCode, grant.body).toBe(302);
    viewerCookie = pair(grant, VIEW_COOKIE);
  }
  const grantUrl = new URL(grant.headers.location as string);
  const redeemed = await h.get(grantUrl.href, { cookie: nonceCookie, headers: { ...NAV, "sec-fetch-site": "cross-site" } });
  expect(redeemed.statusCode, redeemed.body).toBe(302);
  const siteCookie = pair(redeemed, SITE_COOKIE);
  return { first, nonceCookie, startUrl, started, grant, grantUrl, redeemed, siteCookie, viewerCookie: viewerCookie! };
}

describe("org site handoff", () => {
  it("signs a member in through the apex and serves the site with a host-only site cookie", async () => {
    const h = await setup();
    const flow = await signIn(h, h.siteA.url);
    // 1. The site host mints a nonce and sends the browser to the absolute apex URL.
    expectOrgHeaders(flow.first);
    const nonceHeader = setCookie(flow.first, NONCE_COOKIE)!;
    for (const part of ["Max-Age=600", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(nonceHeader).toContain(part);
    expect(nonceHeader).not.toContain("Domain=");
    expect(flow.startUrl.origin).toBe(BASE);
    expect(flow.startUrl.pathname).toBe("/v1/view/start");
    expect(Object.fromEntries(flow.startUrl.searchParams)).toEqual({
      site: h.siteA.id, path: "/report.html?tab=2", n: hashApiKey(value(flow.nonceCookie)),
    });
    // 2. The grant goes to the database host, bound to the session, site and n.
    expect(flow.grantUrl.origin).toBe(`https://${h.siteA.id}.${SUFFIX}`);
    expect(flow.grantUrl.pathname).toBe("/__shareplan/session");
    const code = flow.grantUrl.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = siteSessions(h);
    expect(row).toMatchObject({
      code_hash: hashApiKey(code), code_expires_at: NOW + 60_000, used_at: NOW,
      token_hash: hashApiKey(value(flow.siteCookie)), site_id: h.siteA.id,
      viewer_token_hash: hashApiKey(value(flow.viewerCookie)),
      nonce_hash: hashApiKey(value(flow.nonceCookie)), return_path: "/report.html?tab=2",
      expires_at: NOW + 8 * 60 * 60 * 1000,
    });
    expect(JSON.stringify(siteSessions(h))).not.toContain(code);
    // 3. Redemption sets the site cookie, leaves the nonce, and returns relative.
    expectOrgHeaders(flow.redeemed);
    expect(flow.redeemed.headers.location).toBe("/report.html?tab=2");
    const siteHeader = setCookie(flow.redeemed, SITE_COOKIE)!;
    for (const part of ["Max-Age=28800", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(siteHeader).toContain(part);
    expect(siteHeader).not.toContain("Domain=");
    expect(setCookie(flow.redeemed, NONCE_COOKIE)).toBeUndefined();
    // 4. The member reads the site.
    const page = await h.get(new URL("/report.html?tab=2", h.siteA.url).href, { cookie: flow.siteCookie, headers: NAV });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Quarterly report");
    expectOrgHeaders(page);
    const json = await h.get(new URL("/data.json", h.siteA.url).href, {
      cookie: flow.siteCookie, headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    });
    expect(json.statusCode).toBe(200);
    expect(json.json()).toEqual({ secret: 42 });
  });

  it("refuses a viewer from another WorkOS org at sign-in, and a forged session at serve time", async () => {
    const h = await setup();
    const first = await h.get(h.siteA.url, { headers: NAV });
    const started = await h.get(first.headers.location as string, { headers: NAV });
    h.workos.response.organizationId = "org_other";
    h.workos.claims.org_id = "org_other";
    const callback = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c&state=state_1`, { cookie: flowPair(started) });
    expect(callback.statusCode).toBe(403);
    expect(siteSessions(h)).toHaveLength(0);
    // A site session whose viewer belongs to another org is not honoured.
    h.workos.response.organizationId = ORG;
    h.workos.claims.org_id = ORG;
    const { siteCookie } = await signIn(h, h.siteA.url);
    h.db.prepare("UPDATE viewer_sessions SET workos_org_id = 'org_other'").run();
    expect((await h.get(h.siteA.url, { cookie: siteCookie })).statusCode).toBe(401);
    expect((await h.get(h.siteA.url, { cookie: siteCookie, headers: NAV })).statusCode).toBe(302);
  });

  it("rejects site A's cookie on site B", async () => {
    const h = await setup();
    const { siteCookie } = await signIn(h, h.siteA.url);
    expect((await h.get(h.siteA.url, { cookie: siteCookie })).statusCode).toBe(200);
    const onB = await h.get(h.siteB.url, { cookie: siteCookie });
    expect(onB.statusCode).toBe(401);
    expectOrgHeaders(onB);
    const navB = await h.get(h.siteB.url, { cookie: siteCookie, headers: NAV });
    expect(navB.statusCode).toBe(302);
    expect(navB.headers.location).toContain("/v1/view/start?");
  });

  it("uses the apex session to hand a second site off without a second sign-in", async () => {
    const h = await setup();
    const a = await signIn(h, h.siteA.url);
    const b = await signIn(h, h.siteB.url, "/", { viewerCookie: a.viewerCookie });
    expect(h.workos.authorize).toHaveBeenCalledTimes(1);
    expect(b.grantUrl.origin).toBe(`https://${h.siteB.id}.${SUFFIX}`);
    expect((await h.get(h.siteB.url, { cookie: b.siteCookie })).body).toContain("Org home");
    expect(siteSessions(h).map((s) => s.viewer_token_hash)).toEqual([
      hashApiKey(value(a.viewerCookie)), hashApiKey(value(a.viewerCookie)),
    ]);
  });

  it("lets two tabs share one nonce and both redeem", async () => {
    const h = await setup();
    const tab1 = await h.get(new URL("/report.html", h.siteA.url).href, { headers: NAV });
    const nonce = pair(tab1, NONCE_COOKIE);
    vi.setSystemTime(NOW + 5 * 60_000);
    h.workos.claims.auth_time = (NOW + 5 * 60_000) / 1000;
    // Tab 2 navigates while tab 1 is still at the IdP; it sends the nonce cookie.
    const tab2 = await h.get(new URL("/docs/", h.siteA.url).href, { headers: NAV, cookie: nonce });
    expect(pair(tab2, NONCE_COOKIE)).toBe(nonce);
    expect(setCookie(tab2, NONCE_COOKIE)).toContain("Max-Age=600");
    const n = new URL(tab1.headers.location as string).searchParams.get("n");
    expect(new URL(tab2.headers.location as string).searchParams.get("n")).toBe(n);
    const s1 = await h.get(tab1.headers.location as string, { headers: NAV });
    const s2 = await h.get(tab2.headers.location as string, { headers: NAV });
    const g1 = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c1&state=state_1`, { cookie: flowPair(s1) });
    const g2 = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c2&state=state_2`, { cookie: flowPair(s2) });
    const r1 = await h.get(g1.headers.location as string, { cookie: nonce, headers: NAV });
    const r2 = await h.get(g2.headers.location as string, { cookie: nonce, headers: NAV });
    expect([r1.statusCode, r2.statusCode]).toEqual([302, 302]);
    expect([r1.headers.location, r2.headers.location]).toEqual(["/report.html", "/docs/"]);
    for (const r of [r1, r2]) {
      expect((await h.get(h.siteA.url, { cookie: pair(r, SITE_COOKIE) })).statusCode).toBe(200);
    }
  });

  it.each([
    ["the same viewer", "user_workos", 302, 200],
    ["a different viewer", "user_someone_else", 403, 401],
  ])("when %s signs in again in this browser before the first tab redeems", async (_name, userId, redeem, serve) => {
    const h = await setup();
    const tab1 = await h.get(new URL("/report.html", h.siteA.url).href, { headers: NAV });
    const nonce = pair(tab1, NONCE_COOKIE);
    const tab2 = await h.get(new URL("/docs/", h.siteA.url).href, { headers: NAV, cookie: nonce });
    const s1 = await h.get(tab1.headers.location as string, { headers: NAV });
    const s2 = await h.get(tab2.headers.location as string, { headers: NAV });
    const g1 = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c1&state=state_1`, { cookie: flowPair(s1) });
    const v1 = pair(g1, VIEW_COOKIE);
    const r1early = await h.get(g1.headers.location as string, { cookie: nonce, headers: NAV });
    const early = pair(r1early, SITE_COOKIE);
    // Tab 1 has a second grant in flight when tab 2's callback replaces its session.
    const again = await h.get(new URL("/report.html", h.siteA.url).href, { headers: NAV, cookie: nonce });
    const pending = await h.get(again.headers.location as string, { cookie: v1, headers: NAV });
    expect(pending.headers.location).toContain("/__shareplan/session");
    h.workos.response.user.id = userId;
    h.workos.claims.sub = userId;
    const g2 = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c2&state=state_2`, { cookie: `${flowPair(s2)}; ${v1}` });
    expect(g2.statusCode).toBe(302);
    expect(viewerSessions(h).find((v) => v.token_hash === hashApiKey(value(v1)))!.revoked_at).toBe(NOW);
    const r1 = await h.get(pending.headers.location as string, { cookie: nonce, headers: NAV });
    expect(r1.statusCode).toBe(redeem);
    expect((await h.get(h.siteA.url, { cookie: early })).statusCode).toBe(serve);
    const r2 = await h.get(g2.headers.location as string, { cookie: nonce, headers: NAV });
    expect(r2.statusCode).toBe(302);
    const v2Hash = hashApiKey(value(pair(g2, VIEW_COOKIE)));
    // Carried sessions never outlive the session that minted them.
    for (const row of siteSessions(h).filter((r) => r.viewer_token_hash === v2Hash)) {
      expect(row.expires_at).toBeLessThanOrEqual(NOW + 8 * 60 * 60 * 1000);
    }
    // Signing out the new session ends everything this browser holds.
    await h.get(`${BASE}/v1/view/logout`, {
      method: "POST", cookie: pair(g2, VIEW_COOKIE),
      headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, payload: "",
    });
    for (const cookie of [early, pair(r2, SITE_COOKIE)]) {
      expect((await h.get(h.siteA.url, { cookie })).statusCode).toBe(401);
    }
  });

  it("lets two first visits that race, neither holding a nonce yet, both redeem", async () => {
    const h = await setup();
    // Both requests leave before either response sets a cookie.
    const [tab1, tab2] = await Promise.all([
      h.get(new URL("/report.html", h.siteA.url).href, { headers: NAV }),
      h.get(new URL("/docs/", h.siteA.url).href, { headers: NAV }),
    ]);
    const [n1, n2] = [pair(tab1, NONCE_COOKIE), pair(tab2, NONCE_COOKIE)];
    expect(n1.split("=")[0]).not.toBe(n2.split("=")[0]);
    // The browser now holds both cookies and sends both on every request.
    const jar = `${n1}; ${n2}`;
    const s1 = await h.get(tab1.headers.location as string, { headers: NAV });
    const s2 = await h.get(tab2.headers.location as string, { headers: NAV });
    const g1 = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c1&state=state_1`, { cookie: flowPair(s1) });
    const g2 = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c2&state=state_2`, { cookie: flowPair(s2) });
    const r1 = await h.get(g1.headers.location as string, { cookie: jar, headers: NAV });
    const r2 = await h.get(g2.headers.location as string, { cookie: jar, headers: NAV });
    expect([r1.statusCode, r2.statusCode]).toEqual([302, 302]);
    // A later visit reuses one of them rather than minting a third.
    const later = await h.get(h.siteA.url, { headers: NAV, cookie: jar });
    expect([n1, n2]).toContain(pair(later, NONCE_COOKIE));
  });

  it("refuses a reused, expired, wrong-host, wrong-nonce, missing-nonce or malformed code with 400", async () => {
    const h = await setup();
    const prepare = async (siteUrl: string) => {
      const first = await h.get(siteUrl, { headers: NAV });
      const started = await h.get(first.headers.location as string, { headers: NAV });
      const state = new URL(started.headers.location as string).searchParams.get("state")!;
      const grant = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c&state=${state}`, { cookie: flowPair(started) });
      expect(grant.statusCode).toBe(302);
      return { nonce: pair(first, NONCE_COOKIE), grant: new URL(grant.headers.location as string) };
    };
    // Reused.
    let { nonce, grant } = await prepare(h.siteA.url);
    expect((await h.get(grant.href, { cookie: nonce, headers: NAV })).statusCode).toBe(302);
    expect((await h.get(grant.href, { cookie: nonce, headers: NAV })).statusCode).toBe(400);
    // Expired after 60 seconds.
    ({ nonce, grant } = await prepare(h.siteA.url));
    vi.setSystemTime(NOW + 60_000);
    const expired = await h.get(grant.href, { cookie: nonce, headers: NAV });
    expect(expired.statusCode).toBe(400);
    expectOrgHeaders(expired);
    vi.setSystemTime(NOW);
    // Wrong host: site A's code presented on site B, with the nonce.
    ({ nonce, grant } = await prepare(h.siteA.url));
    const onB = new URL(`${grant.pathname}${grant.search}`, h.siteB.url);
    expect((await h.get(onB.href, { cookie: nonce, headers: NAV })).statusCode).toBe(400);
    // Wrong nonce, then no nonce: neither burns the code.
    const other = `${NONCE_COOKIE}_0000beef=${"B".repeat(43)}`;
    expect((await h.get(grant.href, { cookie: other, headers: NAV })).statusCode).toBe(400);
    expect((await h.get(grant.href, { headers: NAV })).statusCode).toBe(400);
    expect((await h.get(grant.href, { cookie: nonce, headers: NAV })).statusCode).toBe(302);
    // Malformed codes.
    for (const code of ["", "short", "A".repeat(44)]) {
      expect((await h.get(new URL(`/__shareplan/session?code=${code}`, h.siteA.url).href, { cookie: nonce })).statusCode).toBe(400);
    }
  });

  it("binds the grant to the nonce of the browser that started sign-in", async () => {
    const h = await setup();
    // The victim's browser has its own nonce; an attacker starts sign-in with theirs.
    const attacker = await h.get(h.siteA.url, { headers: NAV });
    const victim = await h.get(h.siteA.url, { headers: NAV });
    expect(pair(attacker, NONCE_COOKIE)).not.toBe(pair(victim, NONCE_COOKIE));
    const started = await h.get(attacker.headers.location as string, { headers: NAV });
    const grant = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c&state=state_1`, { cookie: flowPair(started) });
    // The attacker's code, planted in the victim's browser, does not redeem.
    const planted = await h.get(grant.headers.location as string, { cookie: pair(victim, NONCE_COOKIE), headers: NAV });
    expect(planted.statusCode).toBe(400);
    expect(setCookie(planted, SITE_COOKIE)).toBeUndefined();
    expect(siteSessions(h)[0]!.token_hash).toBeNull();
  });

  it("answers HEAD on the redemption endpoint with 405 and leaves the code redeemable", async () => {
    const h = await setup();
    const first = await h.get(h.siteA.url, { headers: NAV });
    const started = await h.get(first.headers.location as string, { headers: NAV });
    const grant = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c&state=state_1`, { cookie: flowPair(started) });
    const nonce = pair(first, NONCE_COOKIE);
    const head = await h.get(grant.headers.location as string, { method: "HEAD", cookie: nonce, headers: NAV });
    expect(head.statusCode).toBe(405);
    expect(head.headers.allow).toBe("GET");
    expectOrgHeaders(head);
    expect(siteSessions(h)[0]!.used_at).toBeNull();
    expect((await h.get(grant.headers.location as string, { cookie: nonce, headers: NAV })).statusCode).toBe(302);
  });

  it("rechecks the viewer session and audience at redemption", async () => {
    for (const change of ["revoke", "relink", "detach"] as const) {
      const h = await setup();
      const first = await h.get(h.siteA.url, { headers: NAV });
      const started = await h.get(first.headers.location as string, { headers: NAV });
      const grant = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c&state=state_1`, { cookie: flowPair(started) });
      if (change === "revoke") h.db.prepare("UPDATE viewer_sessions SET revoked_at = ?").run(NOW);
      else if (change === "relink") updateOrg(h.db, h.org.id, { workos_organization_id: "org_other" }, NOW);
      else setUserOrg(h.db, h.user, null, null, NOW);
      const res = await h.get(grant.headers.location as string, { cookie: pair(first, NONCE_COOKIE), headers: NAV });
      // A relink or detach makes it a plain private site: owner key only.
      expect(res.statusCode, change).toBe(change === "revoke" ? 403 : 401);
      expect(setCookie(res, SITE_COOKIE)).toBeUndefined();
    }
  });
});

describe("sign-out and overlapping sign-ins", () => {
  it("ends every site this person signed in to, even from tabs that signed in at the same time", async () => {
    const h = await setup();
    // Two tabs, no apex cookie yet: each callback creates its own viewer session.
    const a = await signIn(h, h.siteA.url);
    const b = await signIn(h, h.siteB.url, "/");
    expect(a.viewerCookie).not.toBe(b.viewerCookie);
    expect(viewerSessions(h).filter((v) => v.revoked_at === null)).toHaveLength(2);
    // The browser kept the last callback's apex cookie; signing out with it…
    const logout = await h.get(`${BASE}/v1/view/logout`, {
      method: "POST", cookie: b.viewerCookie,
      headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, payload: "",
    });
    expect(logout.statusCode).toBe(200);
    // …ends both sites, not just the one whose session the cookie named.
    expect((await h.get(h.siteA.url, { cookie: a.siteCookie })).statusCode).toBe(401);
    expect((await h.get(h.siteB.url, { cookie: b.siteCookie })).statusCode).toBe(401);
  });
});

describe("redemption audience check", () => {
  it("refuses a grant whose viewer is in another WorkOS org while the site is still org", async () => {
    const h = await setup();
    const first = await h.get(h.siteA.url, { headers: NAV });
    const started = await h.get(first.headers.location as string, { headers: NAV });
    const grant = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c&state=state_1`, { cookie: flowPair(started) });
    expect(grant.statusCode).toBe(302);
    h.db.prepare("UPDATE viewer_sessions SET workos_org_id = 'org_other'").run();
    const res = await h.get(grant.headers.location as string, { cookie: pair(first, NONCE_COOKIE), headers: NAV });
    expect(res.statusCode).toBe(403);
    expect(setCookie(res, SITE_COOKIE)).toBeUndefined();
  });
});

describe("legacy /s/ redirect", () => {
  it("sends the org headers on the hop to an org site's own origin", async () => {
    const h = await setup();
    const res = await h.get(`${BASE}/s/${h.siteA.id}/report.html`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://${h.siteA.id}.${SUFFIX}/report.html`);
    expectOrgHeaders(res);
  });
});

describe("org site request order", () => {
  it("serves the owner's key, 404s another key and 401s an invalid key", async () => {
    const h = await setup();
    const owner = await h.get(h.siteA.url, { headers: { authorization: `Bearer ${OWNER_KEY}` } });
    expect(owner.statusCode).toBe(200);
    expectOrgHeaders(owner);
    const other = await h.get(h.siteA.url, { headers: { authorization: "Bearer sp_other", ...NAV } });
    expect(other.statusCode).toBe(404);
    expectOrgHeaders(other);
    const invalid = await h.get(h.siteA.url, { headers: { authorization: "Bearer sp_nope", ...NAV } });
    expect(invalid.statusCode).toBe(401);
    expect(setCookie(invalid, NONCE_COOKIE)).toBeUndefined();
  });

  it.each([
    ["same-site", "cors", "empty"], ["same-site", "no-cors", "script"], ["same-site", "navigate", "iframe"],
    ["cross-site", "no-cors", "image"], ["cross-site", "navigate", "iframe"], ["cross-site", "cors", "empty"],
    ["same-site", "navigate", "embed"], ["same-site", "no-cors", "style"],
  ])("404s %s %s %s before reading a valid site cookie", async (site, mode, dest) => {
    const h = await setup();
    const { siteCookie } = await signIn(h, h.siteA.url);
    const headers = { "sec-fetch-site": site, "sec-fetch-mode": mode, "sec-fetch-dest": dest };
    const res = await h.get(h.siteA.url, { cookie: siteCookie, headers });
    expect(res.statusCode).toBe(404);
    expectOrgHeaders(res);
    expect(setCookie(res, NONCE_COOKIE)).toBeUndefined();
  });

  it("lets a sibling or external link navigate, and the site's own fetches through", async () => {
    const h = await setup();
    const { siteCookie } = await signIn(h, h.siteA.url);
    for (const headers of [
      { ...NAV, "sec-fetch-site": "same-site" }, { ...NAV, "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
      { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    ]) {
      expect((await h.get(h.siteA.url, { cookie: siteCookie, headers })).statusCode).toBe(200);
    }
  });

  it("applies the guard to the redemption endpoint", async () => {
    const h = await setup();
    const first = await h.get(h.siteA.url, { headers: NAV });
    const started = await h.get(first.headers.location as string, { headers: NAV });
    const grant = await h.get(`${BASE}${VIEW_CALLBACK_PATH}?code=c&state=state_1`, { cookie: flowPair(started) });
    const nonce = pair(first, NONCE_COOKIE);
    const framed = await h.get(grant.headers.location as string, {
      cookie: nonce, headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
    });
    expect(framed.statusCode).toBe(404);
    expect(siteSessions(h)[0]!.used_at).toBeNull();
  });

  it("404s a Service-Worker: script request even with a valid cookie or the owner's key", async () => {
    const h = await setup();
    const { siteCookie } = await signIn(h, h.siteA.url);
    for (const extra of [{ cookie: siteCookie }, { headers: { authorization: `Bearer ${OWNER_KEY}` } }]) {
      const res = await h.get(new URL("/style.css", h.siteA.url).href, {
        ...extra, headers: { ...extra.headers, "service-worker": "script", "sec-fetch-site": "same-origin", "sec-fetch-dest": "serviceworker" },
      });
      expect(res.statusCode).toBe(404);
      expectOrgHeaders(res);
    }
  });

  it("answers unauthenticated HEAD and fetches with 401 and never issues a nonce", async () => {
    const h = await setup();
    const cases: Parameters<Inject>[1][] = [
      { method: "HEAD", headers: NAV }, { method: "HEAD" },
      { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } },
      { headers: { accept: "application/json" } }, {},
    ];
    for (const opts of cases) {
      const res = await h.get(h.siteA.url, opts);
      expect(res.statusCode).toBe(401);
      expect(setCookie(res, NONCE_COOKIE)).toBeUndefined();
      expectOrgHeaders(res);
    }
    // Without fetch metadata, Accept: text/html counts as a document navigation.
    const legacy = await h.get(h.siteA.url, { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(legacy.statusCode).toBe(302);
    expect(setCookie(legacy, NONCE_COOKIE)).toBeDefined();
  });

  it("redirects a revoked or logged-out viewer back through sign-in", async () => {
    const h = await setup();
    const { siteCookie, viewerCookie } = await signIn(h, h.siteA.url);
    const logout = await h.get(`${BASE}/v1/view/logout`, {
      method: "POST", cookie: viewerCookie,
      headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, payload: "",
    });
    expect(logout.statusCode).toBe(200);
    const nav = await h.get(h.siteA.url, { cookie: siteCookie, headers: NAV });
    expect(nav.statusCode).toBe(302);
    expect(nav.headers.location).toContain("/v1/view/start?");
    expect((await h.get(h.siteA.url, { cookie: siteCookie })).statusCode).toBe(401);
  });

  it.each(["relink", "unlink", "detach", "republish private"])("denies an existing site cookie after %s", async (change) => {
    const h = await setup();
    const { siteCookie } = await signIn(h, h.siteA.url);
    if (change === "relink") updateOrg(h.db, h.org.id, { workos_organization_id: "org_other" }, NOW);
    else if (change === "unlink") updateOrg(h.db, h.org.id, { workos_organization_id: null }, NOW);
    else if (change === "detach") setUserOrg(h.db, h.user, null, null, NOW);
    else {
      const res = await h.get(`${BASE}/api/v1/sites/${h.siteA.id}`, {
        method: "PUT", headers: { authorization: `Bearer ${OWNER_KEY}` },
        payload: { visibility: "private", files: [{ path: "index.html", content: "<h1>now private</h1>" }] },
      });
      expect(res.statusCode).toBe(200);
    }
    // No longer an org site: plain owner-only private, no redirect, no cookie.
    const res = await h.get(h.siteA.url, { cookie: siteCookie, headers: NAV });
    expect(res.statusCode).toBe(401);
    expect(res.headers["cross-origin-resource-policy"]).toBeUndefined();
    expect(setCookie(res, NONCE_COOKIE)).toBeUndefined();
  });

  it("stops honouring site cookies when browser viewing is off, but keeps the owner key", async () => {
    const h = await setup();
    const { siteCookie } = await signIn(h, h.siteA.url);
    for (const overrides of [{ workos: null }, { publicBaseUrl: "http://shareplan.localhost" }] as Partial<Config>[]) {
      const app = await buildApp({ config: testConfig(overrides), db: h.db, s3: h.s3.client, workos: h.workos.client, logger: false });
      open.push({ app, db: h.db });
      const get = injector(app);
      const res = await get(h.siteA.url, { cookie: siteCookie, headers: NAV });
      expect(res.statusCode).toBe(401);
      expect(setCookie(res, NONCE_COOKIE)).toBeUndefined();
      expectOrgHeaders(res);
      expect((await get(h.siteA.url, { headers: { authorization: `Bearer ${OWNER_KEY}` } })).statusCode).toBe(200);
      expect((await get(new URL("/__shareplan/session?code=x", h.siteA.url).href)).statusCode).toBe(503);
    }
  });

  it("keeps path mode bearer-only", async () => {
    const h = await setup();
    const app = await buildApp({ config: testConfig({ siteHostSuffix: null }), db: h.db, s3: h.s3.client, workos: h.workos.client, logger: false });
    open.push({ app, db: h.db });
    const get = injector(app);
    const nav = await get(`${BASE}/s/${h.siteA.id}/`, { headers: NAV });
    expect(nav.statusCode).toBe(401);
    expect(setCookie(nav, NONCE_COOKIE)).toBeUndefined();
    expectOrgHeaders(nav);
    expect((await get(`${BASE}/s/${h.siteA.id}/`, { headers: { authorization: `Bearer ${OWNER_KEY}` } })).statusCode).toBe(200);
  });
});

describe("org site headers", () => {
  it("sends the org headers on 302s, 200s, non-HTML files and errors, with the SVG sandbox kept", async () => {
    const h = await setup();
    const { siteCookie, first, redeemed } = await signIn(h, h.siteA.url);
    expectOrgHeaders(first);
    expectOrgHeaders(redeemed);
    const at = (path: string, opts: Parameters<Inject>[1] = {}) => h.get(new URL(path, h.siteA.url).href, { cookie: siteCookie, ...opts });
    const html = await at("/");
    expect(html.statusCode).toBe(200);
    expectOrgHeaders(html);
    const css = await at("/style.css");
    expect(css.headers["content-type"]).toContain("text/css");
    expectOrgHeaders(css);
    const svg = await at("/logo.svg");
    expectOrgHeaders(svg, ORG_SVG_CSP);
    expect(svg.headers["content-security-policy"]).toContain("sandbox");
    const dir = await at("/docs");
    expect(dir.statusCode).toBe(302);
    expectOrgHeaders(dir);
    for (const [res, status] of [
      [await at("/missing.html"), 404], [await at("/__shareplan/other"), 404], [await at("/%E0%A4%A"), 400],
      [await at("/", { method: "POST" }), 405], [await h.get(h.siteA.url), 401],
    ] as const) {
      expect(res.statusCode).toBe(status);
      expectOrgHeaders(res);
    }
    h.db.prepare("UPDATE sites SET expires_at = ? WHERE id = ?").run(NOW, h.siteA.id);
    const gone = await at("/");
    expect(gone.statusCode).toBe(410);
    expectOrgHeaders(gone);
  });

  it("leaves non-org sites, including /__shareplan/ paths, exactly as before", async () => {
    const h = await setup();
    const site = await h.publish("unlisted");
    const page = await h.get(site.url, { headers: NAV });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("public, max-age=60");
    expect(page.headers["content-security-policy"]).not.toContain("worker-src");
    expect(page.headers["cross-origin-opener-policy"]).toBeUndefined();
    expect(page.headers.vary).toBeUndefined();
    const css = await h.get(new URL("/style.css", site.url).href);
    expect(css.headers["content-security-policy"]).toBeUndefined();
    const reserved = await h.get(new URL("/__shareplan/session?code=x", site.url).href, { headers: NAV });
    expect(reserved.statusCode).toBe(404);
    expect(reserved.json().error.message).toBe("file not found");
    const priv = await h.publish("private");
    const res = await h.get(priv.url, { headers: NAV });
    expect(res.statusCode).toBe(401);
    expect(setCookie(res, NONCE_COOKIE)).toBeUndefined();
    expect(res.headers["cross-origin-resource-policy"]).toBeUndefined();
  });
});

describe("operator viewer revoke", () => {
  it.each([
    [{ email: "viewer@skyslope.EXAMPLE" }], [{ workosUserId: "user_workos" }], [{ orgId: ORG }],
  ])("revokes by %j and the site cookie stops working on the next request", async (body) => {
    const h = await setup();
    const { siteCookie } = await signIn(h, h.siteA.url);
    expect((await h.get(h.siteA.url, { cookie: siteCookie })).statusCode).toBe(200);
    const res = await h.get(`${BASE}/api/v1/admin/viewer-sessions/revoke`, {
      method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, payload: body,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ revoked: 1 });
    expect(viewerSessions(h)[0]!.revoked_at).toBe(NOW);
    expect((await h.get(h.siteA.url, { cookie: siteCookie })).statusCode).toBe(401);
    // Idempotent.
    const again = await h.get(`${BASE}/api/v1/admin/viewer-sessions/revoke`, {
      method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, payload: body,
    });
    expect(again.json()).toEqual({ revoked: 0 });
  });

  it("matches only the given identity, validates the body and requires the admin token", async () => {
    const h = await setup();
    await signIn(h, h.siteA.url);
    const post = (payload: unknown, token = ADMIN) => h.get(`${BASE}/api/v1/admin/viewer-sessions/revoke`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, payload,
    });
    expect((await post({ email: "someone@else.example" })).json()).toEqual({ revoked: 0 });
    expect((await post({ orgId: "org_other" })).json()).toEqual({ revoked: 0 });
    for (const bad of [{}, { email: "a@b", orgId: ORG }, { orgId: "not-an-org" }, { email: "" }, { userId: "x" }]) {
      expect((await post(bad)).statusCode).toBe(400);
    }
    expect((await post({ email: "viewer@skyslope.example" }, OWNER_KEY)).statusCode).toBe(401);
    expect(viewerSessions(h)[0]!.revoked_at).toBeNull();
  });

  it("works with browser viewing disabled", async () => {
    const h = await setup();
    await signIn(h, h.siteA.url);
    const app = await buildApp({ config: testConfig({ workos: null }), db: h.db, s3: h.s3.client, logger: false });
    open.push({ app, db: h.db });
    const res = await injector(app)(`${BASE}/api/v1/admin/viewer-sessions/revoke`, {
      method: "POST", headers: { "x-admin-token": ADMIN }, payload: { orgId: ORG },
    });
    expect(res.json()).toEqual({ revoked: 1 });
  });
});

describe("site session lifecycle", () => {
  it("adds site_sessions idempotently without a user_version bump", async () => {
    const h = await setup();
    h.db.exec("DROP TABLE site_sessions");
    upgrade(h.db);
    upgrade(h.db);
    expect(h.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    const { siteCookie } = await signIn(h, h.siteA.url);
    expect((await h.get(h.siteA.url, { cookie: siteCookie })).statusCode).toBe(200);
  });

  it("the reaper prunes unredeemed expired codes, expired and revoked sessions; deleting a site cascades", async () => {
    const h = await setup();
    const live = await signIn(h, h.siteA.url);
    await signIn(h, h.siteB.url, "/", { viewerCookie: live.viewerCookie });
    // An unredeemed grant.
    const first = await h.get(h.siteA.url, { headers: NAV });
    await h.get((await h.get(first.headers.location as string, { cookie: live.viewerCookie, headers: NAV })).headers.location as string);
    expect(siteSessions(h)).toHaveLength(3);
    await reapExpiredSites({ config: h.config, db: h.db, s3: h.s3.client }, NOW + 61_000);
    expect(siteSessions(h)).toHaveLength(2);
    deleteSite(h.db, h.siteB.id);
    expect(siteSessions(h).map((s) => s.site_id)).toEqual([h.siteA.id]);
    h.db.prepare("UPDATE viewer_sessions SET revoked_at = ?").run(NOW);
    await reapExpiredSites({ config: h.config, db: h.db, s3: h.s3.client }, NOW + 62_000);
    expect(siteSessions(h)).toHaveLength(0);
    expect(viewerSessions(h)).toHaveLength(0);
  });

  it("expires the site session with the viewer session", async () => {
    const h = await setup();
    const { siteCookie } = await signIn(h, h.siteA.url);
    vi.setSystemTime(NOW + 8 * 60 * 60 * 1000 - 1);
    expect((await h.get(h.siteA.url, { cookie: siteCookie })).statusCode).toBe(200);
    vi.setSystemTime(NOW + 8 * 60 * 60 * 1000);
    expect((await h.get(h.siteA.url, { cookie: siteCookie })).statusCode).toBe(401);
  });

  it("redacts handoff codes, OAuth state and nonce hashes from logged URLs", () => {
    expect(redactQuerySecrets("/__shareplan/session?code=abc&x=1")).toBe("/__shareplan/session?code=[redacted]&x=1");
    expect(redactQuerySecrets("/v1/view/start?site=a&path=%2F&n=ff00")).toBe("/v1/view/start?site=a&path=%2F&n=[redacted]");
    expect(redactQuerySecrets("/cb?state=s&code=c")).toBe("/cb?state=[redacted]&code=[redacted]");
    expect(redactQuerySecrets("/report?notes=1")).toBe("/report?notes=1");
    // Encoded or case-varied names are the same parameter to the query parser.
    expect(redactQuerySecrets("/__shareplan/session?%63ode=abc")).toBe("/__shareplan/session?%63ode=[redacted]");
    expect(redactQuerySecrets("/cb?%73tate=s&CODE=c&%6E=ff")).toBe("/cb?%73tate=[redacted]&CODE=[redacted]&%6E=[redacted]");
    expect(redactQuerySecrets("/cb?%E0%A4%A=x&a=1#code=frag")).toBe("/cb?%E0%A4%A=[redacted]&a=1#code=frag");
    expect(redactQuerySecrets("/plain")).toBe("/plain");
  });
});
