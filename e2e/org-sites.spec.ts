import type { BrowserContext, Page } from "@playwright/test";
import { createApiKeyRecord, createOrg, createUser, setUserOrg } from "../packages/server/src/db.js";
import { AUTHKIT_ORIGIN, identity } from "./fake-authkit.js";
import { APEX, expect, test, type Harness } from "./fixtures.js";

const WORKOS_ORG = "org_e2e_skyslope";
const MEMBER_KEY = "sp_e2e_org_member";
const SITE_COOKIE = "__Host-shareplan_site";
const NONCE_COOKIE = "__Host-shareplan_site_nonce";
const VIEW_COOKIE = "__Host-shareplan_viewer";

/** A shareplan org linked to WorkOS, one member key, and a publisher for org sites. */
function linkOrg(harness: Harness) {
  const org = createOrg(harness.db, {
    name: "SkySlope", compTier: "paid", joinToken: "org_e2e_join", workosOrganizationId: WORKOS_ORG,
  });
  const user = createUser(harness.db, { tier: "free--" });
  setUserOrg(harness.db, user, org, "member", Date.now());
  createApiKeyRecord(harness.db, { name: "org-member", token: MEMBER_KEY, userId: user.id });
  return async (title: string) => {
    const response = await harness.app.inject({
      method: "POST", url: "/api/v1/sites",
      headers: { host: new URL(APEX).host, authorization: `Bearer ${MEMBER_KEY}` },
      payload: { visibility: "org", files: [
        { path: "index.html", content: `<!doctype html><title>${title}</title><h1>${title} home</h1>` },
        { path: "report.html", content: `<!doctype html><title>${title}</title><h1>${title} report</h1>` },
        { path: "docs/index.html", content: `<!doctype html><title>${title}</title><h1>${title} docs</h1>` },
      ] },
    });
    expect(response.statusCode, response.body).toBe(201);
    const site = response.json<{ id: string; url: string; visibility: string }>();
    expect(site.visibility).toBe("org");
    return site;
  };
}

function sso(organizationId = WORKOS_ORG) {
  return identity({ authenticationMethod: "SSO", organizationId, user: { id: "user_sso", email: "member@skyslope.example" } });
}

async function signIn(page: Page, harness: Harness, url: string, heading: string) {
  harness.authkit.setNextIdentity(sso());
  await page.goto(url);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  expect(page.url()).toBe(url);
}

async function cookie(context: BrowserContext, url: string, name: string) {
  return (await context.cookies(url)).find(c => c.name === name);
}

test("an org member signs in with SSO through the site handoff", async ({ page, context, harness }) => {
  const publishOrg = linkOrg(harness);
  const site = await publishOrg("Org A");
  const target = `${site.url}report.html?tab=2`;
  const host = new URL(site.url).host;
  // Follow a link from a sibling site, as from a shared index page.
  const sibling = await harness.publish(`<!doctype html><a href="${target}">Open the report</a>`);
  await page.goto(sibling.url);
  const before = harness.requests.length;
  harness.authkit.setNextIdentity(sso());
  const finalResponse = page.waitForResponse(r => r.url() === target && r.status() === 200);
  await page.getByRole("link", { name: "Open the report" }).click();
  await expect(page.getByRole("heading", { name: "Org A report" })).toBeVisible();
  expect(page.url()).toBe(target);

  // The whole redirect chain, as the server saw it over TLS.
  const chain = harness.requests.slice(before).map(r => ({ host: r.host, path: r.path, status: r.status, fetchSite: r.fetchSite }));
  expect(chain).toEqual([
    { host, path: "/report.html", status: 302, fetchSite: "same-site" },
    { host: "shareplan.localhost", path: "/v1/view/start", status: 302, fetchSite: "same-site" },
    { host: new URL(AUTHKIT_ORIGIN).host, path: "/authorize", status: 302, fetchSite: "cross-site" },
    { host: "shareplan.localhost", path: "/v1/auth/workos/view/callback", status: 302, fetchSite: "cross-site" },
    { host, path: "/__shareplan/session", status: 302, fetchSite: "cross-site" },
    { host, path: "/report.html", status: 200, fetchSite: "cross-site" },
  ]);
  const redemption = harness.requests.find(r => r.path === "/__shareplan/session")!;
  expect(redemption).toMatchObject({ fetchMode: "navigate", fetchDest: "document", cookie: expect.stringContaining(`${NONCE_COOKIE}=`) });
  expect(redemption.cookie).not.toContain(SITE_COOKIE + "=");
  expect(harness.requests.at(-1)!.cookie).toContain(`${SITE_COOKIE}=`);
  // AuthKit was asked for a fresh sign-in to the linked WorkOS org.
  expect(harness.authkit.authorizationParams).toEqual([expect.objectContaining({
    organization_id: WORKOS_ORG, max_age: "0", redirect_uri: `${APEX}/v1/auth/workos/view/callback`,
  })]);

  // Host-only cookies: the site cookie stays on the site, the viewer cookie on the apex.
  expect(await cookie(context, site.url, SITE_COOKIE)).toMatchObject({
    domain: new URL(site.url).hostname, secure: true, httpOnly: true, sameSite: "Lax", path: "/",
  });
  expect(await cookie(context, site.url, NONCE_COOKIE)).toMatchObject({ domain: new URL(site.url).hostname, secure: true, httpOnly: true });
  expect(await cookie(context, APEX, VIEW_COOKIE)).toMatchObject({ domain: "shareplan.localhost", secure: true, httpOnly: true });
  // What the browser actually sent (context.cookies(url) domain-matches loosely).
  await page.goto(`${APEX}/v1/view/`);
  await expect(page.getByText("Signed in as member@skyslope.example")).toBeVisible();
  await page.goto(target);
  for (const r of harness.requests) {
    if (r.host === host) expect(r.cookie).not.toContain(`${VIEW_COOKIE}=`);
    if (r.host === "shareplan.localhost") expect(r.cookie).not.toMatch(/__Host-shareplan_site(_nonce)?=/);
  }
  expect(harness.requests.filter(r => r.host === host).at(-1)).toMatchObject({ status: 200, cookie: expect.stringContaining(`${SITE_COOKIE}=`) });
  expect(await page.evaluate(() => document.cookie)).toBe("");

  const headers = (await finalResponse).headers();
  expect(headers).toMatchObject({
    "cache-control": "private, no-store", "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin", "x-frame-options": "DENY", vary: "Cookie, Authorization",
  });
  expect(headers["content-security-policy"]).toContain("worker-src 'none'");
  expect(await page.evaluate(async () => (await fetch("/")).status)).toBe(200);
});

test("site A's cookie is rejected on site B, and B reuses the apex session", async ({ page, context, harness }) => {
  const publishOrg = linkOrg(harness);
  const siteA = await publishOrg("Org A");
  const siteB = await publishOrg("Org B");
  await signIn(page, harness, siteA.url, "Org A home");
  const aCookie = (await cookie(context, siteA.url, SITE_COOKIE))!;

  const before = harness.requests.length;
  await page.goto(siteB.url);
  await expect(page.getByRole("heading", { name: "Org B home" })).toBeVisible();
  // The browser never sent A's host-only cookie to B; B went through the apex
  // and straight to its own grant, with no second trip to AuthKit.
  const bFirst = harness.requests[before]!;
  expect(bFirst).toMatchObject({ host: new URL(siteB.url).host, status: 302 });
  expect(bFirst.cookie).not.toContain(SITE_COOKIE);
  expect(harness.authkit.authorizationCalls).toHaveLength(1);
  expect(harness.requests.slice(before).some(r => r.host === new URL(AUTHKIT_ORIGIN).host)).toBe(false);
  const bCookie = (await cookie(context, siteB.url, SITE_COOKIE))!;
  expect(bCookie.value).not.toBe(aCookie.value);

  // Plant A's cookie value on B's host: the server refuses it for B.
  await context.addCookies([{ name: SITE_COOKIE, value: aCookie.value, url: siteB.url, secure: true, httpOnly: true, sameSite: "Lax" }]);
  expect(await page.evaluate(async () => (await fetch("/")).status)).toBe(401);
  await context.addCookies([{ name: SITE_COOKIE, value: bCookie.value, url: siteB.url, secure: true, httpOnly: true, sameSite: "Lax" }]);
  expect(await page.evaluate(async () => (await fetch("/")).status)).toBe(200);
});

test("a sibling site's fetch, script and iframe of an org site are refused before the cookie is used", async ({ page, context, harness }) => {
  const publishOrg = linkOrg(harness);
  const site = await publishOrg("Org A");
  await signIn(page, harness, site.url, "Org A home");
  const attacker = await harness.publish();
  const attackerPage = await context.newPage();
  // A sibling page without a CSP of its own, so only the org site's defences apply.
  await attackerPage.goto(`${attacker.url}__e2e/attacker`);
  const before = harness.requests.length;
  const result = await attackerPage.evaluate(async target => {
    const outcome: Record<string, string> = {};
    try { await fetch(`${target}report.html`, { credentials: "include" }); outcome.cors = "resolved"; } catch { outcome.cors = "rejected"; }
    try {
      const r = await fetch(`${target}report.html?mode=no-cors`, { credentials: "include", mode: "no-cors" });
      outcome.noCors = r.type;
    } catch { outcome.noCors = "rejected"; }
    outcome.script = await new Promise<string>(resolve => {
      const s = document.createElement("script");
      s.src = `${target}docs/`;
      s.onload = () => resolve("loaded");
      s.onerror = () => resolve("error");
      document.body.append(s);
    });
    outcome.iframe = await new Promise<string>(resolve => {
      const f = document.createElement("iframe");
      f.src = `${target}report.html?frame=1`;
      f.onload = () => resolve("load-event");
      setTimeout(() => resolve("no-load-event"), 3000);
      document.body.append(f);
    });
    return outcome;
  }, site.url);
  // CORP blocks the opaque no-cors response too; both outcomes keep the body out.
  expect(result).toMatchObject({ cors: "rejected", script: "error" });
  expect(["opaque", "rejected"]).toContain(result.noCors);
  const probes = harness.requests.slice(before).filter(r => r.host === new URL(site.url).host);
  expect(probes.map(r => [r.fetchMode, r.fetchDest, r.status])).toEqual(expect.arrayContaining([
    ["cors", "empty", 404], ["no-cors", "empty", 404], ["no-cors", "script", 404], ["navigate", "iframe", 404],
  ]));
  for (const probe of probes) {
    expect(probe.fetchSite).toBe("same-site");
    // The browser did send the Lax cookie to its sibling; the guard refused anyway.
    expect(probe.cookie).toContain(`${SITE_COOKIE}=`);
    expect(probe.status).toBe(404);
  }
  for (const frame of attackerPage.frames()) {
    expect(await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "")).not.toContain("Org A report");
  }
});

test("two tabs that start sign-in together share one nonce and both redeem", async ({ context, harness }) => {
  const publishOrg = linkOrg(harness);
  const site = await publishOrg("Org A");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Hold both tabs at AuthKit until each has started its own sign-in.
  harness.authkit.authorizeGate = gate;
  const tab1 = await context.newPage();
  const tab2 = await context.newPage();
  harness.authkit.setNextIdentity(sso());
  const nav1 = tab1.goto(`${site.url}report.html`);
  await expect.poll(() => harness.requests.filter(r => r.path === "/authorize").length).toBe(1);
  harness.authkit.setNextIdentity(sso());
  const nav2 = tab2.goto(`${site.url}docs/`);
  await expect.poll(() => harness.requests.filter(r => r.path === "/authorize").length).toBe(2);
  release();
  await Promise.all([nav1, nav2]);
  await expect(tab1.getByRole("heading", { name: "Org A report" })).toBeVisible();
  await expect(tab2.getByRole("heading", { name: "Org A docs" })).toBeVisible();

  const starts = harness.requests.filter(r => r.host === new URL(site.url).host && r.status === 302 && r.path !== "/__shareplan/session");
  expect(starts).toHaveLength(2);
  expect(starts[0]!.cookie).not.toContain(NONCE_COOKIE);
  expect(starts[1]!.cookie).toContain(`${NONCE_COOKIE}=`);
  const grants = harness.db.prepare("SELECT nonce_hash, token_hash, used_at, return_path FROM site_sessions ORDER BY created_at, rowid").all() as
    { nonce_hash: string; token_hash: string | null; used_at: number | null; return_path: string }[];
  expect(grants).toHaveLength(2);
  expect(grants[0]!.nonce_hash).toBe(grants[1]!.nonce_hash);
  expect(grants.map(g => g.return_path).sort()).toEqual(["/docs/", "/report.html"]);
  // Two independent sign-ins, each with its own flow cookie and viewer session.
  expect(harness.authkit.authenticationCalls).toHaveLength(2);
  expect(harness.db.prepare("SELECT COUNT(*) AS n FROM viewer_sessions").get()).toEqual({ n: 2 });
  for (const grant of grants) {
    expect(grant.used_at).not.toBeNull();
    expect(grant.token_hash).not.toBeNull();
  }
});

test("signing out through /v1/view/ ends site access on the next request", async ({ page, context, harness }) => {
  const publishOrg = linkOrg(harness);
  const site = await publishOrg("Org A");
  await signIn(page, harness, site.url, "Org A home");
  const sitePage = await context.newPage();
  await sitePage.goto(site.url);
  await expect(sitePage.getByRole("heading", { name: "Org A home" })).toBeVisible();
  expect(harness.authkit.authorizationCalls).toHaveLength(1);

  await page.goto(`${APEX}/v1/view/`);
  await expect(page.getByText("Signed in as member@skyslope.example")).toBeVisible();
  const logout = page.waitForResponse(r => r.url() === `${APEX}/v1/view/logout`);
  const authkitLogout = page.waitForResponse(r => r.url().startsWith(`${AUTHKIT_ORIGIN}/logout?`));
  await page.getByRole("button", { name: "Sign out" }).click();
  expect((await logout).status()).toBe(200);
  expect((await authkitLogout).status()).toBe(302);
  await expect(page).toHaveURL(`${APEX}/`);
  expect(harness.authkit.logoutCalls).toEqual([{ sessionId: "session_e2e", returnTo: `${APEX}/` }]);
  expect(harness.requests.find(r => r.path === "/v1/view/logout")).toMatchObject({ method: "POST", origin: APEX, fetchSite: "same-origin" });
  expect(await cookie(context, APEX, VIEW_COOKIE)).toBeUndefined();

  // The site cookie is still in the jar, but its viewer session is revoked.
  expect(await cookie(context, site.url, SITE_COOKIE)).toBeDefined();
  expect(await sitePage.evaluate(async () => (await fetch("/")).status)).toBe(401);
  // Opening the site again needs a fresh sign-in at AuthKit.
  await signIn(sitePage, harness, site.url, "Org A home");
  expect(harness.authkit.authorizationCalls).toHaveLength(2);
});

test("a viewer outside the linked WorkOS organization gets 403 and no site cookie", async ({ page, context, harness }) => {
  const publishOrg = linkOrg(harness);
  const site = await publishOrg("Org A");
  harness.authkit.setNextIdentity(sso("org_e2e_someone_else"));
  const callback = page.waitForResponse(r => r.url().startsWith(`${APEX}/v1/auth/workos/view/callback?`));
  await page.goto(site.url);
  expect((await callback).status()).toBe(403);
  await expect(page.getByText("Viewer sign-in failed")).toBeVisible();
  expect(await cookie(context, site.url, SITE_COOKIE)).toBeUndefined();
  expect(await cookie(context, APEX, VIEW_COOKIE)).toBeUndefined();
  expect(harness.requests.some(r => r.path === "/__shareplan/session")).toBe(false);
  expect(harness.db.prepare("SELECT COUNT(*) AS n FROM viewer_sessions").get()).toEqual({ n: 0 });
});
