import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { AuthError } from "./auth.js";
import { hashApiKey } from "./db.js";
import { hashIp, requestIp } from "./ip.js";
import { consumeRate } from "./rate-limit.js";
import { getOwnerStats } from "./owner-stats.js";
import { dashboardPage, loginPage } from "./owner-view.js";

const SESSION_SECONDS = 8 * 60 * 60;

export function registerOwnerPortal(app: FastifyInstance, config: Config, db: DatabaseSync): void {
  const base = new URL(config.publicBaseUrl);
  const secure = base.protocol === "https:";
  const cookieName = secure ? "__Host-shareplan_owner" : "shareplan_owner_dev";
  const cookieOptions = { path: "/", httpOnly: true, secure, sameSite: "strict" as const };

  function guard(req: FastifyRequest, reply: FastifyReply): void {
    reply.headers({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
      // Same-origin form POSTs need their Origin header for the CSRF check.
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    });
    if (req.headers.host?.toLowerCase() !== base.host.toLowerCase()) {
      throw new AuthError(404, "not_found", "not found");
    }
    if (!config.adminTokenHash) {
      throw new AuthError(503, "admin_disabled", "Set SHAREPLAN_ADMIN_TOKEN to enable owner login.");
    }
    // Uploaded HTML must never share an origin with privileged browser sessions.
    if (!config.siteHostSuffix || (!secure && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) {
      throw new AuthError(503, "owner_unconfigured", "Owner login requires isolated site hosts and HTTPS (HTTP is allowed on loopback for development).");
    }
    if (req.method === "POST" && req.headers.origin !== base.origin) {
      throw new AuthError(403, "invalid_origin", "Submit this form from the owner portal.");
    }
  }

  function sessionHash(req: FastifyRequest): string | null {
    const token = req.cookies[cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = hashApiKey(token);
    const row = db.prepare(`SELECT token_hash FROM owner_sessions
      WHERE token_hash = ? AND admin_token_hash = ? AND expires_at > ?`).get(hash, config.adminTokenHash!, Date.now());
    return row ? hash : null;
  }

  // Route hooks run after the global site-host routing hook in app.ts.
  const options = { onRequest: async (req: FastifyRequest, reply: FastifyReply) => guard(req, reply) };

  app.get("/owner/login", options, async (req, reply) => {
    if (sessionHash(req)) return reply.redirect("/owner", 303);
    return reply.type("text/html; charset=utf-8").send(loginPage());
  });

  app.post("/owner/login", { ...options, bodyLimit: 4096 }, async (req, reply) => {
    const bucket = `owner:${hashIp(requestIp(req), config.ipHashPepper ?? config.adminTokenHash!)}`;
    if (!consumeRate(db, bucket, "owner_login", 10)) {
      reply.header("retry-after", String(Math.ceil((3_600_000 - Date.now() % 3_600_000) / 1000)));
      return reply.code(429).type("text/html; charset=utf-8").send(loginPage("Too many login attempts. Try again next hour."));
    }
    const body = req.body as { token?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token : "";
    if (!timingSafeEqual(Buffer.from(hashApiKey(token)), Buffer.from(config.adminTokenHash!))) {
      return reply.code(401).type("text/html; charset=utf-8").send(loginPage("That owner token did not match. Try again."));
    }
    const now = Date.now();
    const previous = sessionHash(req);
    if (previous) db.prepare("DELETE FROM owner_sessions WHERE token_hash = ?").run(previous);
    db.prepare("DELETE FROM owner_sessions WHERE expires_at <= ? OR admin_token_hash != ?").run(now, config.adminTokenHash!);
    const session = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO owner_sessions (token_hash, admin_token_hash, expires_at) VALUES (?, ?, ?)")
      .run(hashApiKey(session), config.adminTokenHash!, now + SESSION_SECONDS * 1000);
    reply.setCookie(cookieName, session, { ...cookieOptions, maxAge: SESSION_SECONDS });
    return reply.redirect("/owner", 303);
  });

  app.post("/owner/logout", { ...options, bodyLimit: 4096 }, async (req, reply) => {
    const hash = sessionHash(req);
    if (hash) db.prepare("DELETE FROM owner_sessions WHERE token_hash = ?").run(hash);
    reply.clearCookie(cookieName, cookieOptions);
    return reply.redirect("/owner/login", 303);
  });

  app.get("/owner", options, async (req, reply) => {
    if (!sessionHash(req)) return reply.redirect("/owner/login", 303);
    return reply.type("text/html; charset=utf-8").send(dashboardPage(getOwnerStats(db)));
  });

  app.get("/api/v1/admin/stats", options, async (req, reply) => {
    if (!sessionHash(req)) throw new AuthError(401, "unauthorized", "Sign in to the owner portal.");
    return reply.send(getOwnerStats(db));
  });
}
