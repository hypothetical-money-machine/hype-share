import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp, type WorkOSAuthClient } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import {
  createApiKeyRecord, createOrg, createUser, deleteOrg, getSite, hashApiKey, insertSite,
  openDb, setUserOrg, updateOrg, upgrade,
} from "./db.js";
import { hashIp } from "./ip.js";
import { reapExpiredSites } from "./reap.js";
import { createFakeS3 } from "./testing/fake-s3.js";
import { browserViewingEnabled, VIEW_CALLBACK_PATH, VIEWER_STARTS_PER_HOUR } from "./viewer.js";
import { getViewerSession, type ViewerAuthFlow, type ViewerSession } from "./viewer-db.js";

const NOW = 1_800_000_030_000;
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const ORG = "org_skyslope";
const IP = "203.0.113.10";
const N = hashApiKey("site-host-nonce");
const BASE = "https://shareplan.localhost";
const VIEW_COOKIE = "__Host-shareplan_viewer";
type Authentication = Awaited<ReturnType<WorkOSAuthClient["userManagement"]["authenticateWithCode"]>>;
type Claims = { sid?: unknown; org_id?: unknown; sub?: unknown; auth_time?: unknown };

function accessToken(claims: Claims): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function fakeWorkOS() {
  const claims: Claims = { sid: "session_workos", org_id: ORG, sub: "user_workos", auth_time: NOW / 1000 };
  const response: Authentication = {
    user: { id: "user_workos", email: "Viewer<test>@example.com", emailVerified: true },
    organizationId: ORG, authenticationMethod: "SSO", accessToken: accessToken(claims),
  };
  let state = 0;
  const authorize = vi.fn<WorkOSAuthClient["userManagement"]["getAuthorizationUrlWithPKCE"]>(async () => {
    state += 1;
    return { state: `state_${state}`, codeVerifier: `verifier_${state}`, url: `https://auth.test/authorize?state=state_${state}` };
  });
  const authenticate = vi.fn<WorkOSAuthClient["userManagement"]["authenticateWithCode"]>(async () => ({
    ...response, accessToken: accessToken(claims),
  }));
  const logout = vi.fn<WorkOSAuthClient["userManagement"]["getLogoutUrl"]>((opts) => {
    const url = new URL("https://auth.test/logout");
    url.searchParams.set("session_id", opts.sessionId);
    url.searchParams.set("return_to", opts.returnTo!);
    return url.href;
  });
  const client: WorkOSAuthClient = {
    userManagement: { getAuthorizationUrlWithPKCE: authorize, authenticateWithCode: authenticate, getLogoutUrl: logout },
    organizations: { getOrganization: async (id) => ({ id, name: "SkySlope" }) },
  };
  return { client, authorize, authenticate, logout, response, claims };
}

const open: { app: FastifyInstance; db: ReturnType<typeof openDb> }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const h of open.splice(0)) { await h.app.close(); h.db.close(); }
});

async function setup(overrides: Partial<Config> = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const config: Config = {
    ...loadConfig({ SHAREPLAN_DATA_DIR: "/tmp", SHAREPLAN_PUBLIC_BASE_URL: BASE,
      SHAREPLAN_SITE_HOST_SUFFIX: "shareplan.localhost", SHAREPLAN_IP_HASH_PEPPER: "test-pepper",
      WORKOS_API_KEY: "sk_test", WORKOS_CLIENT_ID: "client_test", WORKOS_REDIRECT_URI: `${BASE}/v1/auth/workos/callback` }),
    ...overrides,
  };
  const db = openDb(":memory:");
  const s3 = createFakeS3();
  const workos = fakeWorkOS();
  const app = await buildApp({ config, db, s3: s3.client, workos: workos.client, logger: false });
  open.push({ app, db });
  const org = createOrg(db, { name: "SkySlope", compTier: "paid", joinToken: "org_test", workosOrganizationId: ORG });
  const user = createUser(db, { tier: "free--" });
  setUserOrg(db, user, org, "member", NOW);
  const key = createApiKeyRecord(db, { name: "publisher", token: "sp_publisher", userId: user.id });
  insertSite(db, { id: "orgsite", owner_key_id: key.id, owner_user_id: user.id, slug: null,
    title: "Org site", visibility: "private", current_version_id: "version_1",
    created_at: NOW, updated_at: NOW, expires_at: null,
    audience: { orgId: org.id, workosOrgId: ORG, versionId: "version_1" } });
  const request = (opts: InjectOptions): Promise<LightMyRequestResponse> => app.inject({
    ...opts, remoteAddress: opts.remoteAddress ?? IP,
    headers: { host: new URL(config.publicBaseUrl).host, ...opts.headers },
  });
  const start = (path = "/report.html?tab=2&sort=desc", extra: Partial<InjectOptions> = {}) => request({
    method: "GET", url: `/v1/view/start?${new URLSearchParams({ site: "orgsite", path, n: N })}`, ...extra,
  });
  const callback = (cookie?: string, state = "state_1") => request({ method: "GET",
    url: `${VIEW_CALLBACK_PATH}?code=auth_code&state=${state}`, headers: cookie ? { cookie } : {},
  });
  return { app, db, s3, config, workos, org, user, request, start, callback };
}

function cookies(res: LightMyRequestResponse): string[] {
  const header = res.headers["set-cookie"];
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
}
function cookiePair(res: LightMyRequestResponse, name?: string): string {
  const value = cookies(res).find((value) => name ? value.startsWith(`${name}=`) : value.includes("shareplan_view_flow_"));
  if (!value) throw new Error(`Missing cookie ${name ?? "flow"}`);
  return value.split(";", 1)[0]!;
}
function sessions(h: Awaited<ReturnType<typeof setup>>): ViewerSession[] {
  return h.db.prepare("SELECT * FROM viewer_sessions").all() as unknown as ViewerSession[];
}
function flow(h: Awaited<ReturnType<typeof setup>>): ViewerAuthFlow {
  return h.db.prepare("SELECT * FROM viewer_auth_flows").get() as unknown as ViewerAuthFlow;
}
function privateHeaders(res: LightMyRequestResponse) {
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["referrer-policy"]).toBe("no-referrer");
  expect(res.headers["content-security-policy"]).toContain("form-action 'none'");
}
async function signIn(h: Awaited<ReturnType<typeof setup>>) {
  const started = await h.start();
  expect(started.statusCode).toBe(302);
  const completed = await h.callback(cookiePair(started));
  expect(completed.statusCode).toBe(302);
  expect(completed.headers.location).toMatch(/^https:\/\/orgsite\.shareplan\.localhost\/__shareplan\/session\?code=[A-Za-z0-9_-]{43}$/);
  return { started, completed, cookie: cookiePair(completed, VIEW_COOKIE) };
}

describe("browserViewingEnabled and route guards", () => {
  it.each([
    [BASE, "shareplan.localhost", true, true],
    ["http://localhost:8788", "sites.localhost", true, true],
    ["http://127.0.0.1:8788", "sites.localhost", true, true],
    ["http://[::1]:8788", "sites.localhost", true, true],
    ["http://shareplan.localhost", "shareplan.localhost", true, false],
    [BASE, null, true, false], [BASE, "shareplan.localhost", false, false],
  ])("%s suffix %s workos %s => %s", async (url, suffix, workos, expected) => {
    const h = await setup();
    expect(browserViewingEnabled({ ...h.config, publicBaseUrl: url, siteHostSuffix: suffix, workos: workos ? h.config.workos : null })).toBe(expected);
  });

  it.each([
    { workos: null }, { siteHostSuffix: null }, { publicBaseUrl: "http://shareplan.localhost" },
  ])("returns 503 on every viewer route when disabled: %j", async (overrides) => {
    const h = await setup(overrides);
    for (const [method, url] of [["GET", "/v1/view/"], ["GET", "/v1/view/start"], ["GET", VIEW_CALLBACK_PATH],
      ["POST", "/v1/view/logout"], ["GET", "/v1/view/unknown"]] as const) {
      const res = await h.request({ method, url });
      expect(res.statusCode).toBe(503);
      privateHeaders(res);
    }
  });

  it("refuses an unrelated host", async () => {
    const h = await setup();
    const res = await h.request({ method: "GET", url: "/v1/view/", headers: { host: "unrelated.test" } });
    expect(res.statusCode).toBe(404);
    privateHeaders(res);
  });
});

describe("viewer start", () => {
  it("requests fresh org-bound AuthKit SSO with the derived callback and stores only hashes", async () => {
    const h = await setup();
    const res = await h.start();
    expect(res.statusCode).toBe(302);
    privateHeaders(res);
    expect(h.workos.authorize).toHaveBeenCalledWith({ clientId: "client_test", provider: "authkit",
      organizationId: ORG, redirectUri: `${BASE}${VIEW_CALLBACK_PATH}`, maxAge: 0 });
    expect(h.config.workos!.redirectUri).toBe(`${BASE}/v1/auth/workos/callback`);
    const nonce = cookiePair(res).split("=")[1]!;
    expect(flow(h)).toMatchObject({ state_hash: hashApiKey("state_1"), browser_nonce_hash: hashApiKey(nonce),
      code_verifier: "verifier_1", workos_org_id: ORG, site_id: "orgsite",
      return_path: "/report.html?tab=2&sort=desc", site_nonce_hash: N, created_at: NOW, expires_at: NOW + 600_000 });
    expect(cookies(res)[0]).toMatch(/^__Host-shareplan_view_flow_state_1=/);
    for (const value of ["Max-Age=600", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(cookies(res)[0]).toContain(value);
    expect(cookies(res)[0]).not.toContain("Domain=");
  });

  it("redirects to the database site URL, including the query, when n is missing", async () => {
    const h = await setup();
    const res = await h.request({ method: "GET", url: `/v1/view/start?${new URLSearchParams({ site: "orgsite", path: "/report?a=2&b=3" })}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://orgsite.shareplan.localhost/report?a=2&b=3");
    expect(h.workos.authorize).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT * FROM viewer_auth_flows").all()).toHaveLength(0);
    privateHeaders(res);
  });

  it.each(["//evil.test", "/\\evil.test", "https://evil.test", "%2f%2fevil.test", "/%2fevil.test",
    "/%5cevil.test", "/%255cevil.test", "/%252fevil.test", "/a\n", "/a%0d%0aLocation:evil", "/a\x7f", "", "/" + "a".repeat(1024),
    "/%3F%2F%2Fevil.test", "/a?x#frag", "/a?x=\n", "?//evil.test"])(
    "rejects return-path attack %j", async (path) => {
      const h = await setup();
      const res = await h.start(path);
      expect(res.statusCode).toBe(400);
      expect(h.workos.authorize).not.toHaveBeenCalled();
      privateHeaders(res);
    });

  it.each(["/report.html?source=https%3A%2F%2Fexample.com", "/r?u=//cdn.example/x", "/a?q=%5C%0A"])(
    "accepts a query that carries an encoded URL or escapes: %j", async (path) => {
      const h = await setup();
      const res = await h.start(path);
      expect(res.statusCode).toBe(302);
      expect(flow(h).return_path).toBe(path);
    });

  it.each(["-invalid", "UPPER", "two.labels", "www", "a".repeat(64)])("rejects label %s", async (site) => {
    const h = await setup();
    const res = await h.request({ method: "GET", url: `/v1/view/start?${new URLSearchParams({ site, path: "/", n: N })}` });
    expect(res.statusCode).toBe(400);
  });

  it.each(["", "f".repeat(63), "g".repeat(64), "f".repeat(65)])("rejects invalid n %s", async (n) => {
    const h = await setup();
    const res = await h.request({ method: "GET", url: `/v1/view/start?${new URLSearchParams({ site: "orgsite", path: "/", n })}` });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    "UPDATE sites SET visibility = 'public'", "UPDATE sites SET audience_version_id = 'old_version'",
    "UPDATE orgs SET workos_organization_id = 'org_other'", "UPDATE users SET org_id = NULL",
    "UPDATE sites SET expires_at = 1", "UPDATE sites SET audience_org_id = NULL",
  ])("requires an honoured, unexpired org audience: %s", async (sql) => {
    const h = await setup(); h.db.exec(sql);
    expect((await h.start()).statusCode).toBe(404);
    expect(h.workos.authorize).not.toHaveBeenCalled();
  });

  it("limits starts by hashed IP and keeps other IPs independent", async () => {
    const h = await setup();
    for (let i = 0; i < VIEWER_STARTS_PER_HOUR; i++) expect((await h.start()).statusCode).toBe(302);
    expect((await h.start()).statusCode).toBe(429);
    expect(h.workos.authorize).toHaveBeenCalledTimes(VIEWER_STARTS_PER_HOUR);
    expect(h.db.prepare("SELECT bucket FROM rate_limits WHERE action = 'viewer_start'").get()).toEqual({ bucket: `viewer:${hashIp(IP, "test-pepper")}` });
    expect((await h.start("/", { remoteAddress: "203.0.113.11" })).statusCode).toBe(302);
  });

  it("counts only new WorkOS sign-ins against the limit, not redirects or the session shortcut", async () => {
    const h = await setup(); const { cookie } = await signIn(h);
    const noNonce = () => h.request({ method: "GET", url: `/v1/view/start?${new URLSearchParams({ site: "orgsite", path: "/" })}` });
    for (let i = 0; i < VIEWER_STARTS_PER_HOUR + 5; i++) {
      expect((await h.start("/", { headers: { cookie } })).statusCode).toBe(501);
      expect((await noNonce()).statusCode).toBe(302);
    }
    expect(h.db.prepare("SELECT count FROM rate_limits WHERE action = 'viewer_start'").get()).toEqual({ count: 1 });
  });

  it("uses unprefixed host-only cookies on loopback HTTP", async () => {
    const h = await setup({ publicBaseUrl: "http://localhost:8788",
      workos: { apiKey: "sk_test", clientId: "client_test", redirectUri: "http://localhost:8788/v1/auth/workos/callback" } });
    const start = await h.start();
    expect(cookies(start)[0]).toMatch(/^shareplan_view_flow_state_1=/);
    expect(cookies(start)[0]).not.toContain("Secure");
    const callback = await h.callback(cookiePair(start));
    expect(callback.statusCode).toBe(302);
    expect(cookies(callback).find((c) => c.startsWith("shareplan_viewer="))).toContain("SameSite=Lax");
    expect(h.workos.authorize.mock.calls[0]![0].redirectUri).toBe(`http://localhost:8788${VIEW_CALLBACK_PATH}`);
  });

  it("returns a private 502 if WorkOS cannot start sign-in", async () => {
    const h = await setup(); h.workos.authorize.mockRejectedValueOnce(new Error("unavailable"));
    const res = await h.start(); expect(res.statusCode).toBe(502); privateHeaders(res);
  });
});

describe("viewer callback", () => {
  it("creates only a viewer session, extracts sid, discards tokens, and hands off to the site host", async () => {
    const h = await setup();
    const before = h.db.prepare("SELECT * FROM users").all();
    const { completed, cookie } = await signIn(h);
    const token = cookie.split("=")[1]!;
    expect(sessions(h)).toEqual([{ token_hash: hashApiKey(token), workos_user_id: "user_workos",
      email: "Viewer<test>@example.com", workos_org_id: ORG, workos_session_id: "session_workos",
      auth_time: NOW / 1000, created_at: NOW, expires_at: NOW + EIGHT_HOURS, revoked_at: null }]);
    expect(h.db.prepare("SELECT * FROM users").all()).toEqual(before);
    expect(h.db.prepare("SELECT * FROM viewer_auth_flows").all()).toHaveLength(0);
    expect(JSON.stringify(sessions(h))).not.toContain("signature");
    expect(JSON.stringify(sessions(h))).not.toContain("verifier_");
    expect(h.workos.authenticate).toHaveBeenCalledWith({ clientId: "client_test", code: "auth_code", codeVerifier: "verifier_1", ipAddress: IP, userAgent: "lightMyRequest" });
    const header = cookies(completed).find((c) => c.startsWith(`${VIEW_COOKIE}=`))!;
    for (const value of ["Max-Age=28800", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(header).toContain(value);
    expect(header).not.toContain("Domain="); privateHeaders(completed);
    // The apex viewer cookie is not a site cookie: the site host ignores it.
    const site = await h.request({ method: "GET", url: "/", headers: { host: "orgsite.shareplan.localhost", cookie } });
    expect(site.statusCode).toBe(401);
  });

  const failures: [string, (h: Awaited<ReturnType<typeof setup>>) => void][] = [
    ["wrong response org", (h) => { h.workos.response.organizationId = "org_other"; }],
    ["missing response org", (h) => { delete h.workos.response.organizationId; }],
    ["wrong token org", (h) => { h.workos.claims.org_id = "org_other"; }],
    ["missing token org", (h) => { delete h.workos.claims.org_id; }],
    ["MagicAuth", (h) => { h.workos.response.authenticationMethod = "MagicAuth"; }],
    ["unverified email", (h) => { h.workos.response.user.emailVerified = false; }],
    ["impersonation", (h) => { h.workos.response.impersonator = { email: "admin@example.com", reason: null }; }],
    ["stale auth_time", (h) => { h.workos.claims.auth_time = NOW / 1000 - 61; }],
    ["missing auth_time", (h) => { delete h.workos.claims.auth_time; }],
    ["string auth_time", (h) => { h.workos.claims.auth_time = String(NOW / 1000); }],
    ["wrong sub", (h) => { h.workos.claims.sub = "user_other"; }],
    ["missing sub", (h) => { delete h.workos.claims.sub; }],
    ["missing sid", (h) => { delete h.workos.claims.sid; }],
    ["empty sid", (h) => { h.workos.claims.sid = ""; }],
  ];
  it.each(failures)("rejects %s with the same generic 403", async (_name, change) => {
    const h = await setup(); const started = await h.start(); change(h);
    const res = await h.callback(cookiePair(started));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: "viewer_signin_failed", message: "Viewer sign-in failed. Open the site and try again." } });
    expect(sessions(h)).toHaveLength(0);
    expect(cookies(res).some((c) => c.startsWith(`${VIEW_COOKIE}=`))).toBe(false);
    privateHeaders(res);
  });

  it("accepts the skew boundary and expires at auth_time + 8 hours, not callback + 8 hours", async () => {
    const h = await setup(); const started = await h.start();
    h.workos.claims.auth_time = NOW / 1000 - 60;
    vi.setSystemTime(NOW + 120_000);
    const res = await h.callback(cookiePair(started));
    expect(res.statusCode).toBe(302);
    expect(sessions(h)[0]!.expires_at).toBe(NOW - 60_000 + EIGHT_HOURS);
    expect(cookies(res).find((c) => c.startsWith(`${VIEW_COOKIE}=`))).toContain("Max-Age=28620");
    const token = cookiePair(res, VIEW_COOKIE).split("=")[1]!;
    expect(getViewerSession(h.db, token, NOW - 60_000 + EIGHT_HOURS)).toBeNull();
  });

  it("caps a future auth_time at now when computing expiry", async () => {
    const h = await setup(); h.workos.claims.auth_time = NOW / 1000 + 60;
    await signIn(h); expect(sessions(h)[0]!.expires_at).toBe(NOW + EIGHT_HOURS);
  });

  it("consumes state once, including concurrent callbacks", async () => {
    const h = await setup(); const started = await h.start(); const cookie = cookiePair(started);
    const results = await Promise.all([h.callback(cookie), h.callback(cookie)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([302, 403]);
    expect((await h.callback(cookie)).statusCode).toBe(403);
    expect(h.workos.authenticate).toHaveBeenCalledTimes(1);
    expect(sessions(h)).toHaveLength(1);
  });

  it("requires state and its matching nonce without consuming another tab's flow", async () => {
    const h = await setup(); const a = await h.start(); const b = await h.start();
    expect(cookiePair(a).split("=")[0]).not.toBe(cookiePair(b).split("=")[0]);
    expect((await h.callback()).statusCode).toBe(403);
    const wrong = `${cookiePair(a).split("=")[0]}=${"A".repeat(43)}`;
    expect((await h.callback(wrong)).statusCode).toBe(403);
    expect((await h.callback(cookiePair(a), "made_up")).statusCode).toBe(403);
    expect(h.workos.authenticate).not.toHaveBeenCalled();
    expect((await h.callback(cookiePair(b), "state_2")).statusCode).toBe(302);
    expect((await h.callback(cookiePair(a))).statusCode).toBe(302);
    expect(sessions(h)).toHaveLength(2);
  });

  it("rejects an expired flow before calling WorkOS", async () => {
    const h = await setup(); const started = await h.start(); vi.setSystemTime(NOW + 600_000);
    expect((await h.callback(cookiePair(started))).statusCode).toBe(403);
    expect(h.workos.authenticate).not.toHaveBeenCalled();
  });

  it("handles cancellation and exchange errors as generic 403 and burns the flow", async () => {
    const h = await setup(); const first = await h.start();
    const res = await h.request({ method: "GET", url: `${VIEW_CALLBACK_PATH}?error=access_denied&state=state_1`, headers: { cookie: cookiePair(first) } });
    expect(res.statusCode).toBe(403); expect(h.workos.authenticate).not.toHaveBeenCalled();
    expect((await h.callback(cookiePair(first))).statusCode).toBe(403);
    const second = await h.start(); h.workos.authenticate.mockRejectedValueOnce(new Error("secret exchange detail"));
    const failed = await h.callback(cookiePair(second), "state_2");
    expect(failed.statusCode).toBe(403); expect(failed.body).not.toContain("secret exchange detail");
    expect(sessions(h)).toHaveLength(0);
  });

  it.each(["", undefined])("rejects a callback with code %j before calling WorkOS", async (code) => {
    const h = await setup(); const started = await h.start();
    const params = new URLSearchParams({ state: "state_1" }); if (code !== undefined) params.set("code", code);
    const res = await h.request({ method: "GET", url: `${VIEW_CALLBACK_PATH}?${params}`, headers: { cookie: cookiePair(started) } });
    expect(res.statusCode).toBe(403); expect(h.workos.authenticate).not.toHaveBeenCalled();
    expect(sessions(h)).toHaveLength(0);
  });

  it("revokes the session a new sign-in replaces in the same browser", async () => {
    const h = await setup(); const first = await signIn(h);
    const started = await h.start("/", { headers: { cookie: "x=1" } });
    const res = await h.callback(`${cookiePair(started)}; ${first.cookie}`, "state_2");
    expect(res.statusCode).toBe(501);
    const rows = sessions(h);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.token_hash === hashApiKey(first.cookie.split("=")[1]!))!.revoked_at).toBe(NOW);
    expect(rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
  });

  it("revokes viewer sessions for a deleted org's WorkOS link", async () => {
    const h = await setup(); await signIn(h);
    expect(deleteOrg(h.db, h.org.id, NOW)).not.toBeNull();
    expect(sessions(h)[0]!.revoked_at).toBe(NOW);
  });

  it.each(["", "garbage", "e30.bnVsbA.sig", "e30.W10.sig", "e30.bm90anNvbg.sig"])("rejects malformed exchanged access token %j", async (token) => {
    const h = await setup(); const started = await h.start();
    h.workos.authenticate.mockResolvedValueOnce({ ...h.workos.response, accessToken: token });
    expect((await h.callback(cookiePair(started))).statusCode).toBe(403);
    expect(sessions(h)).toHaveLength(0);
  });

  it.each(["relink", "detach", "republish"])("rechecks the audience after exchange against %s", async (change) => {
    const h = await setup(); const started = await h.start();
    h.workos.authenticate.mockImplementationOnce(async () => {
      if (change === "relink") updateOrg(h.db, h.org.id, { workos_organization_id: "org_other" }, NOW);
      else if (change === "detach") setUserOrg(h.db, h.user, null, null, NOW);
      else h.db.exec("UPDATE sites SET current_version_id = 'version_old_binary'");
      return h.workos.response;
    });
    expect((await h.callback(cookiePair(started))).statusCode).toBe(403);
    expect(sessions(h)).toHaveLength(0);
  });

  it("uses a live apex session only for its org and refuses revoked/expired sessions", async () => {
    const h = await setup(); const { cookie } = await signIn(h);
    const shortcut = await h.start("/", { headers: { cookie } });
    expect(shortcut.statusCode).toBe(302); privateHeaders(shortcut);
    expect(h.workos.authorize).toHaveBeenCalledTimes(1);
    h.db.exec("UPDATE viewer_sessions SET workos_org_id = 'org_other'");
    expect((await h.start("/", { headers: { cookie } })).statusCode).toBe(302);
    h.db.prepare("UPDATE viewer_sessions SET workos_org_id = ?, revoked_at = ?").run(ORG, NOW);
    expect((await h.start("/", { headers: { cookie } })).statusCode).toBe(302);
    h.db.prepare("UPDATE viewer_sessions SET revoked_at = NULL, expires_at = ?").run(NOW);
    expect((await h.start("/", { headers: { cookie } })).statusCode).toBe(302);
  });
});

describe("viewer page and logout", () => {
  it("renders the sign-out form with same-origin referrers, accepts its form body and revokes before the WorkOS interstitial", async () => {
    const h = await setup(); const { cookie } = await signIn(h);
    const page = await h.request({ method: "GET", url: "/v1/view/", headers: { cookie } });
    expect(page.statusCode).toBe(200); expect(page.body).toContain("Signed in as Viewer&lt;test&gt;@example.com");
    expect(page.body).toContain('<form method="post" action="/v1/view/logout">');
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    const res = await h.request({ method: "POST", url: "/v1/view/logout", headers: {
      cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, payload: "" });
    expect(res.statusCode).toBe(200); expect(res.headers.location).toBeUndefined();
    expect(res.body).toContain('http-equiv="refresh"'); expect(res.body).toContain("Continue to sign out");
    expect(res.body).toContain("https://auth.test/logout?"); expect(res.body).toContain("&amp;return_to=");
    expect(h.workos.logout).toHaveBeenCalledWith({ sessionId: "session_workos", returnTo: `${BASE}/` });
    expect(sessions(h)[0]!.revoked_at).toBe(NOW); privateHeaders(res);
    expect(cookies(res)[0]).toContain(`${VIEW_COOKIE}=`); expect(cookies(res)[0]).toContain("Expires=Thu, 01 Jan 1970");
    const after = await h.request({ method: "GET", url: "/v1/view/", headers: { cookie } });
    expect(after.body).toContain("You are not signed in");
  });

  it.each([undefined, "null", "https://attacker.test", "https://evil.shareplan.localhost", `${BASE}/`])("rejects logout origin %s without revoking", async (origin) => {
    const h = await setup(); const { cookie } = await signIn(h);
    const res = await h.request({ method: "POST", url: "/v1/view/logout", headers: { cookie, ...(origin ? { origin } : {}) } });
    expect(res.statusCode).toBe(403); expect(sessions(h)[0]!.revoked_at).toBeNull();
    expect(h.workos.logout).not.toHaveBeenCalled(); privateHeaders(res);
  });

  it("handles an unsigned-in logout idempotently and links the viewer page from the apex and docs", async () => {
    const h = await setup();
    const page = await h.request({ method: "GET", url: "/v1/view/" }); expect(page.body).toContain("You are not signed in");
    const logout = await h.request({ method: "POST", url: "/v1/view/logout", headers: { origin: BASE } });
    expect(logout.statusCode).toBe(200); expect(h.workos.logout).not.toHaveBeenCalled();
    for (const url of ["/", "/docs/agents"]) expect((await h.request({ method: "GET", url })).body).toContain("/v1/view/");
  });
});

describe("viewer database lifecycle", () => {
  it("adds the tables idempotently to a slice-3 database without changing rows or user_version", async () => {
    const h = await setup(); const before = getSite(h.db, "orgsite");
    h.db.exec("DROP TABLE viewer_auth_flows; DROP TABLE viewer_sessions");
    upgrade(h.db); upgrade(h.db);
    expect(h.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(getSite(h.db, "orgsite")).toEqual(before);
    await signIn(h); expect(sessions(h)).toHaveLength(1);
  });

  it.each([null, "org_other"])("revokes sessions for only the old WorkOS org on link change to %s", async (next) => {
    const h = await setup(); await signIn(h);
    const previous = sessions(h)[0]!;
    h.db.prepare(`INSERT INTO viewer_sessions SELECT 'other_hash', workos_user_id, email, 'org_unrelated',
      workos_session_id, auth_time, created_at, expires_at, revoked_at FROM viewer_sessions`).run();
    updateOrg(h.db, h.org.id, { workos_organization_id: ORG }, NOW + 1);
    expect(sessions(h).find((s) => s.token_hash === previous.token_hash)!.revoked_at).toBeNull();
    updateOrg(h.db, h.org.id, { workos_organization_id: next }, NOW + 2);
    expect(sessions(h).find((s) => s.token_hash === previous.token_hash)!.revoked_at).toBe(NOW + 2);
    expect(sessions(h).find((s) => s.token_hash === "other_hash")!.revoked_at).toBeNull();
    expect(getSite(h.db, "orgsite")!.audience_org_id).toBeNull();
  });

  it("the reaper prunes expired flows, expired sessions and revoked sessions, preserving live rows", async () => {
    const h = await setup(); await signIn(h); const started = await h.start();
    expect(started.statusCode).toBe(302);
    h.db.prepare(`INSERT INTO viewer_sessions SELECT 'revoked_hash', workos_user_id, email, workos_org_id,
      workos_session_id, auth_time, created_at, expires_at, ? FROM viewer_sessions`).run(NOW);
    h.db.prepare(`INSERT INTO viewer_sessions SELECT 'expired_hash', workos_user_id, email, workos_org_id,
      workos_session_id, auth_time, created_at, ?, NULL FROM viewer_sessions LIMIT 1`).run(NOW + 600_000);
    await reapExpiredSites({ config: h.config, db: h.db, s3: h.s3.client }, NOW + 600_000);
    expect(h.db.prepare("SELECT * FROM viewer_auth_flows").all()).toHaveLength(0);
    expect(sessions(h)).toHaveLength(1);
    expect(sessions(h)[0]!.token_hash).not.toBe("expired_hash");
    expect(sessions(h)[0]!.token_hash).not.toBe("revoked_hash");
  });
});
