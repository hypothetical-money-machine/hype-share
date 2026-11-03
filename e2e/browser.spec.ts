import { getUser } from "../packages/server/src/db.js";
import { AUTHKIT_ORIGIN, identity } from "./fake-authkit.js";
import { APEX, OWNER_TOKEN, expect, test } from "./fixtures.js";

test("claims an account through the confirmation interstitial and fake AuthKit", async ({ page, context, harness }) => {
  await page.goto(APEX);
  const registered = await page.evaluate(async () => {
    const response = await fetch("/api/v1/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "browser-agent" }),
    });
    if (response.status !== 201) throw new Error(`Registration returned ${response.status}`);
    return response.json() as Promise<{ userId: string; claimUrl: string }>;
  });
  const signedIn = identity({ user: { id: "user_claim_e2e", email: "claim@example.test" } });
  harness.authkit.setNextIdentity(signedIn);
  const confirmation = await page.goto(registered.claimUrl);
  expect(confirmation!.headers()["content-security-policy"]).toContain("form-action 'self'");
  await expect(page.getByRole("heading", { name: "Claim this agent account?" })).toBeVisible();
  expect(await context.cookies(APEX)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "__Host-shareplan_claim_confirm", domain: "shareplan.localhost", secure: true, httpOnly: true, sameSite: "Strict", path: "/" }),
  ]));

  const interstitialPromise = page.waitForResponse(response => response.request().method() === "POST" && response.url() === registered.claimUrl);
  const authkitPromise = page.waitForResponse(response => response.url().startsWith(`${AUTHKIT_ORIGIN}/authorize?`));
  const callbackPromise = page.waitForResponse(response => response.url().startsWith(`${APEX}/v1/auth/workos/callback?`));
  await page.getByRole("button", { name: "Continue to sign in" }).click();
  const [interstitial, authorization, callback] = await Promise.all([interstitialPromise, authkitPromise, callbackPromise]);
  expect(interstitial.status()).toBe(200);
  expect(interstitial.headers().location).toBeUndefined();
  expect(interstitial.headers()["content-security-policy"]).toContain("form-action 'none'");
  expect(authorization.status()).toBe(302);
  expect(callback.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Account claimed", exact: true })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(APEX);
  expect(new URL(page.url()).port).toBe("");
  expect(harness.authkit.authorizationParams).toEqual([
    expect.objectContaining({ client_id: "client_e2e", provider: "authkit", screen_hint: "sign-up", redirect_uri: `${APEX}/v1/auth/workos/callback`, code_challenge_method: "S256" }),
  ]);
  expect(harness.authkit.authenticationCalls).toHaveLength(1);
  expect(getUser(harness.db, registered.userId)).toMatchObject({
    tier: "free", email: signedIn.user.email, workos_user_id: signedIn.user.id,
    claim_token_hash: null, claimed_at: expect.any(Number),
  });
  // The callback is a real cross-site top-level GET; the Lax nonce survives it.
  expect(harness.requests.find(request => request.path === "/v1/auth/workos/callback")).toMatchObject({
    host: "shareplan.localhost", fetchSite: "cross-site", fetchMode: "navigate", fetchDest: "document",
    cookie: expect.stringContaining("__Host-shareplan_claim_callback="),
  });
  expect((await context.cookies(APEX)).filter(cookie => cookie.name.includes("claim"))).toEqual([]);
});

test("owner login/logout sends portless Origins and rejects a same-site sibling form", async ({ page, context, harness }) => {
  const attacker = await harness.publish();
  const attackerPage = await context.newPage();
  await attackerPage.goto(`${attacker.url}__e2e/attacker`);
  // A real form POST from a sibling must fail even with the correct owner token.
  await attackerPage.evaluate(({ apex, token }) => {
    const form = document.querySelector("form")!;
    form.action = `${apex}/owner/login`;
    const input = document.createElement("input");
    input.name = "token";
    input.value = token;
    form.append(input);
  }, { apex: APEX, token: OWNER_TOKEN });
  let rejected = attackerPage.waitForResponse(response => response.request().method() === "POST" && response.url() === `${APEX}/owner/login`);
  await attackerPage.getByRole("button").click();
  expect((await rejected).status()).toBe(403);
  expect(harness.db.prepare("SELECT * FROM owner_sessions").all()).toHaveLength(0);

  await page.goto(`${APEX}/owner`);
  await expect(page).toHaveURL(`${APEX}/owner/login`);
  await page.getByLabel("Owner token").fill(OWNER_TOKEN);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${APEX}/owner`);
  await expect(page.getByRole("heading", { name: "A home for every share." })).toBeVisible();
  expect(await context.cookies(APEX)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "__Host-shareplan_owner", domain: "shareplan.localhost", httpOnly: true, secure: true, sameSite: "Strict", path: "/" }),
  ]));
  expect(harness.requests.find(request => request.path === "/owner/login" && request.origin === APEX)).toMatchObject({
    method: "POST", host: "shareplan.localhost", origin: APEX, fetchSite: "same-origin",
  });

  await attackerPage.goto(`${attacker.url}__e2e/attacker`);
  rejected = attackerPage.waitForResponse(response => response.request().method() === "POST" && response.url() === `${APEX}/owner/logout`);
  await attackerPage.getByRole("button").click();
  expect((await rejected).status()).toBe(403);
  expect(harness.requests.find(request => request.path === "/owner/logout")).toMatchObject({
    host: "shareplan.localhost", origin: new URL(attacker.url).origin, fetchSite: "same-site",
    cookie: expect.stringContaining("__Host-shareplan_owner="),
  });
  expect(harness.db.prepare("SELECT * FROM owner_sessions").all()).toHaveLength(1);

  await page.reload();
  await expect(page).toHaveURL(`${APEX}/owner`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${APEX}/owner/login`);
  expect(harness.requests.filter(request => request.path === "/owner/logout").at(-1)).toMatchObject({
    method: "POST", origin: APEX, fetchSite: "same-origin",
  });
  expect(await context.cookies(APEX)).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "__Host-shareplan_owner" })]));
  expect(harness.db.prepare("SELECT * FROM owner_sessions").all()).toHaveLength(0);
  await page.goto(`${APEX}/owner`);
  await expect(page).toHaveURL(`${APEX}/owner/login`);
});

test("host-only site cookies stay on their host and the site CSP blocks credentialed sibling fetch", async ({ page, context, harness }) => {
  const siteA = await harness.publish();
  const siteB = await harness.publish();
  for (const site of [siteA, siteB]) {
    expect(new URL(site.url).port).toBe("");
    expect(new URL(site.url).host).toBe(`${site.id}.shareplan.localhost`);
  }
  const response = await page.goto(siteA.url);
  expect(response!.headers()["content-security-policy"]).toContain("connect-src 'self'");
  await page.evaluate(async () => {
    const response = await fetch("/__e2e/set-cookie");
    if (response.status !== 204) throw new Error(`Cookie setup returned ${response.status}`);
  });
  expect(await context.cookies(siteA.url)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "__Host-e2e_scope", domain: new URL(siteA.url).hostname, secure: true, httpOnly: true, sameSite: "Lax", path: "/" }),
  ]));
  expect(await page.evaluate(() => document.cookie)).not.toContain("__Host-e2e_scope");

  await page.reload();
  expect(harness.requests.filter(request => request.host === new URL(siteA.url).host && request.path === "/").at(-1)!.cookie).toContain("__Host-e2e_scope=site-only");
  const sibling = await context.newPage();
  await sibling.goto(siteB.url);
  await sibling.goto(APEX);
  for (const host of [new URL(siteB.url).host, new URL(APEX).host]) {
    expect(harness.requests.filter(request => request.host === host && request.path === "/").at(-1)!.cookie).not.toContain("__Host-e2e_scope");
  }

  const before = harness.requests.length;
  const result = await page.evaluate(async siblingUrl => {
    const violation = new Promise<{ directive: string; blocked: string }>(resolve => {
      document.addEventListener("securitypolicyviolation", event => resolve({
        directive: event.effectiveDirective, blocked: event.blockedURI,
      }), { once: true });
    });
    let rejected = false;
    try { await fetch(siblingUrl, { credentials: "include" }); } catch { rejected = true; }
    return { rejected, violation: await violation, origin: location.origin, port: location.port };
  }, siteB.url);
  expect(result).toMatchObject({
    rejected: true, origin: new URL(siteA.url).origin, port: "",
    violation: { directive: "connect-src", blocked: siteB.url },
  });
  expect(harness.requests.slice(before).filter(request => request.host === new URL(siteB.url).host)).toEqual([]);
});
