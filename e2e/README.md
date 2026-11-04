# Opt-in browser tests

Run from the repository root (Node >=22.11, OpenSSL on PATH, and Chromium's
system libraries already installed):

```sh
npm ci
npm run test:e2e
```

Playwright is pinned to 1.64.1, which uses the existing Chromium **1248** cache
at `~/.cache/ms-playwright/chromium-1248`. If it is missing, prepare it once with
`npx playwright install chromium` (a download; do this before an offline run).
The tests select the full Chromium build with `channel: "chromium"`.
No Docker, sudo, system DNS edits, privileged ports, WorkOS account, env file,
or S3 service is needed. After dependencies/browser provisioning, the suite only
contacts loopback. It is excluded from `npm test` and CI; `npm run typecheck`
does check the harness. `test:e2e` builds core before importing server sources.

## Topology and isolation

Each test gets an in-memory SQLite database, the existing
`packages/server/src/testing/fake-s3.ts`, an injected fake WorkOS client, a new
browser context, and a Node HTTPS listener bound to `127.0.0.1` on a random
unprivileged port. OpenSSL creates a temporary one-day self-signed certificate;
only that context ignores certificate errors. Teardown closes connections and
removes the certificate and temporary directory.

Chromium's `--host-resolver-rules` maps these **portless** URLs to that listener:

- Apex: `https://shareplan.localhost`
- Sites: `https://<id>.shareplan.localhost`
- Fake AuthKit: `https://authkit.shareplan-test.localhost` (a different site)

The apex equals the site suffix, as in production. Mapping changes the socket
destination, while URL, TLS, Host, Origin, and cookie semantics retain HTTPS's
default port 443. Browser tests assert portless URLs/Host/Origin, a same-site
sibling POST (including the apex Strict cookie), and a cross-site AuthKit callback
(including its Lax cookie). No local listener needs port 443. Browser requests
are restricted to these HTTPS origins; other DNS lookups fail closed, proxy use
is disabled, and service workers are blocked. The HTTPS listener passes real
requests into Fastify's public `app.routing`, without rewriting Host or headers.
Only setup publishing uses `inject`; all claimed browser behavior uses TLS.

`FakeAuthKit` records both SDK options (`authorizationCalls`) and encoded URL
parameters (`authorizationParams`, including `organization_id` and `max_age`
when supplied). Its separate origin redirects to the requested callback with
state and a single-use code; the server-side exchange checks the PKCE verifier.
Call `authkit.setNextIdentity(identity(...))` before **each** sign-in. You can
control the user/email verification, method, organization, impersonator, and
access token. `identity(overrides, claims)` builds an unsigned JWT containing
`sid`, `org_id`, `sub`, and `auth_time`; `unsignedJwt()` permits arbitrary claims.
This fake deliberately does not validate real WorkOS/IdP behavior or signatures.

The current tests exercise the actual claim confirmation → 200 interstitial →
fake AuthKit 302 → callback, owner login/logout with the exact-origin guard,
host-only cookies, and the uploaded-site `connect-src 'self'` policy.
Two **test-only transport endpoints** exist because main has no site sessions
and its site CSP would block a malicious logout form before the owner guard:
`/__e2e/set-cookie` issues a Secure/HttpOnly/host-only `__Host-` cookie;
`/__e2e/attacker` serves a sibling-origin form without CSP. They are served only
by the harness on site hosts; no application behavior changes. The cookie test
uses real published HTML/CSP for the credentialed sibling fetch and observes its
`securitypolicyviolation` event and absence of a network request.

`org-sites.spec.ts` covers org-site viewing (PLAN.md, Org-private viewing):
a full SSO sign-in from a sibling-site link through `/v1/view/start`, fake
AuthKit, the view callback and `/__shareplan/session`; host-only site and
viewer cookies; site A's cookie refused on site B while B reuses the apex
session; a sibling's `fetch`, `<script src>` and `<iframe>` refused with 404
although the browser sent the Lax cookie; two tabs held at AuthKit at once
(`authkit.authorizeGate`, because Playwright routes skip redirect hops) sharing
one nonce and both redeeming; a real sign-out through `/v1/view/` and the fake
AuthKit logout; and a viewer from another WorkOS organization getting 403.
`harness.requests[i].status` is the status the server sent.

## Adding a slice's browser test

Add another `*.spec.ts` here and import `test`/`expect` from `./fixtures.js`:

```ts
import { identity } from "./fake-authkit.js";
import { test, expect } from "./fixtures.js";

test("new sign-in behavior", async ({ page, harness }) => {
  harness.authkit.setNextIdentity(identity(
    { authenticationMethod: "SSO", organizationId: "org_linked" },
    { auth_time: Math.floor(Date.now() / 1000), org_id: "org_linked" },
  ));
  // Arrange the linked org/site with harness.db or harness.app.inject().
  // Navigate the browser through the real viewer routes, then assert the page,
  // context.cookies(), and harness.requests (Origin, Sec-Fetch-*, cookies).
  expect(harness.config.siteHostSuffix).toBe("shareplan.localhost");
});
```

`harness.publish(html?)` publishes a public site with an ops key and returns its
portless URL. Future org tests should publish through the appropriate member
key. The fake implements `getLogoutUrl` (served at `/logout`, recorded in
`logoutCalls`) and `organizations.getOrganization`. Extend its typed client if a
slice adds SDK methods; keep all fake endpoints on the separate AuthKit origin.
Prefer locators and awaited responses over sleeps. Run a focused case with
`npm run test:e2e -- --grep 'new sign-in'`, then the suite twice.

Failures attach a local Playwright trace under `test-results/e2e/`:
`npx playwright show-trace <path-to-trace.zip>`. Traces can include test cookies,
codes and identities; they are ignored by git. Nothing is published by the runner.
