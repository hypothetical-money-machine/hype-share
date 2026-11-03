import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test as base } from "@playwright/test";
import { buildApp } from "../packages/server/src/app.js";
import { loadConfig } from "../packages/server/src/config.js";
import { createOpsKey, openDb } from "../packages/server/src/db.js";
import { createFakeS3 } from "../packages/server/src/testing/fake-s3.js";
import { AUTHKIT_ORIGIN, FakeAuthKit } from "./fake-authkit.js";

export const APEX = "https://shareplan.localhost";
export const OWNER_TOKEN = "e2e-owner-token-not-a-real-secret";
const PUBLISHER_TOKEN = "sp_e2e_publisher";
const SITE_HOST = /^[a-z0-9-]+\.shareplan\.localhost$/;

export interface ObservedRequest {
  host: string;
  path: string;
  method: string;
  origin: string | undefined;
  fetchSite: string | undefined;
  fetchMode: string | undefined;
  fetchDest: string | undefined;
  cookie: string;
}

async function startHarness() {
  const directory = mkdtempSync(join(tmpdir(), "shareplan-e2e-"));
  const db = openDb(":memory:");
  const s3 = createFakeS3();
  const authkit = new FakeAuthKit();
  const requests: ObservedRequest[] = [];
  const config = loadConfig({
    SHAREPLAN_DATA_DIR: directory,
    SHAREPLAN_PUBLIC_BASE_URL: APEX,
    SHAREPLAN_SITE_HOST_SUFFIX: new URL(APEX).hostname,
    SHAREPLAN_ADMIN_TOKEN: OWNER_TOKEN,
    SHAREPLAN_IP_HASH_PEPPER: "e2e-pepper",
    SHAREPLAN_REAP_INTERVAL_SEC: "0",
    WORKOS_API_KEY: "sk_test_fake_not_sent_anywhere",
    WORKOS_CLIENT_ID: "client_e2e",
    WORKOS_REDIRECT_URI: `${APEX}/v1/auth/workos/callback`,
  });
  const app = await buildApp({ config, db, s3: s3.client, workos: authkit.client, logger: false });
  const server = createServer();
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
      "-subj", "/CN=shareplan.localhost",
      "-addext", "subjectAltName=DNS:shareplan.localhost,DNS:*.shareplan.localhost,DNS:authkit.shareplan-test.localhost",
    ], { stdio: "pipe" });
    server.setSecureContext({ key: readFileSync(join(directory, "key.pem")), cert: readFileSync(join(directory, "cert.pem")) });
    createOpsKey(db, { name: "browser-test-publisher", token: PUBLISHER_TOKEN });
    await app.ready();
    server.on("request", (req, res) => {
      const host = req.headers.host ?? "";
      requests.push({
        host, path: new URL(req.url!, APEX).pathname, method: req.method!,
        origin: req.headers.origin, fetchSite: req.headers["sec-fetch-site"] as string | undefined,
        fetchMode: req.headers["sec-fetch-mode"] as string | undefined,
        fetchDest: req.headers["sec-fetch-dest"] as string | undefined,
        cookie: req.headers.cookie ?? "",
      });
      if (host === new URL(AUTHKIT_ORIGIN).host) return authkit.handle(req, res);
      if (host !== new URL(APEX).host && !SITE_HOST.test(host)) {
        res.writeHead(421).end();
        return;
      }
      // Main has no site-session endpoint yet. Issue a real host-only cookie over
      // HTTPS at the transport boundary, without replacing the site's real CSP.
      if (SITE_HOST.test(host) && req.url === "/__e2e/set-cookie") {
        res.writeHead(204, {
          "set-cookie": "__Host-e2e_scope=site-only; Secure; HttpOnly; SameSite=Lax; Path=/",
          "cache-control": "no-store",
        }).end();
        return;
      }
      // An untrusted same-site page without form-action, so the owner portal's
      // own Origin guard is exercised independently of the uploaded-site CSP.
      if (SITE_HOST.test(host) && req.url === "/__e2e/attacker") {
        res.writeHead(200, {
          "content-type": "text/html",
          "cache-control": "no-store",
          "referrer-policy": "strict-origin-when-cross-origin",
        }).end(`<!doctype html><form method="post" action="${APEX}/owner/logout"><button>Submit cross-origin form</button></form>`);
        return;
      }
      // Real TLS IncomingMessage/ServerResponse, through Fastify's public router;
      // no inject(), upstream port, proxy header rewriting, or app changes.
      app.routing(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.port <= 1024) throw new Error("Expected an unprivileged TCP port");
    const port = address.port;
    return {
      app, db, s3, authkit, config, requests, port,
      // Setup-only API calls still use the real router. Browser flows use TLS.
      async publish(html = "<!doctype html><h1>Browser test site</h1>") {
        const response = await app.inject({
          method: "POST", url: "/api/v1/sites",
          headers: { host: new URL(APEX).host, authorization: `Bearer ${PUBLISHER_TOKEN}` },
          payload: { title: "Browser test site", ttl: "1d", files: [{ path: "index.html", content: html }] },
        });
        expect(response.statusCode, response.body).toBe(201);
        return response.json<{ id: string; url: string }>();
      },
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await app.close();
        db.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export const test = base.extend<{ harness: Harness }>({
  harness: async ({}, use) => {
    const harness = await startHarness();
    try { await use(harness); } finally { await harness.close(); }
  },
  context: async ({ harness }, use, testInfo) => {
    const destination = `127.0.0.1:${harness.port}`;
    const browser = await chromium.launch({
      channel: "chromium",
      args: [
        "--no-proxy-server",
        "--disable-background-networking",
        "--disable-component-update",
        `--host-resolver-rules=MAP shareplan.localhost ${destination}, MAP *.shareplan.localhost ${destination}, MAP authkit.shareplan-test.localhost ${destination}, MAP * ~NOTFOUND`,
      ],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
    const unexpectedOrigins: string[] = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.protocol === "https:" && url.port === "" &&
          (url.origin === APEX || url.origin === AUTHKIT_ORIGIN || SITE_HOST.test(url.host))) {
        await route.continue();
      } else {
        unexpectedOrigins.push(url.origin);
        await route.abort("blockedbyclient");
      }
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    try {
      await use(context);
      expect(unexpectedOrigins, "Browser must only contact the mapped test origins").toEqual([]);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        const path = testInfo.outputPath("trace.zip");
        await context.tracing.stop({ path });
        await testInfo.attach("trace", { path, contentType: "application/zip" });
      } else {
        await context.tracing.stop();
      }
      await context.close();
      await browser.close();
    }
  },
});

export { expect } from "@playwright/test";
