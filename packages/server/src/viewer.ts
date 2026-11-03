import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isHostLabel, RESERVED_HOST_LABELS } from "@shareplan/core";
import type { WorkOSAuthClient } from "./app.js";
import { claimRedirectPage, escapeHtml, setAuthPageHeaders } from "./auth-pages.js";
import type { Config } from "./config.js";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { getSite, getSiteByIdOrSlug, hashApiKey, honouredAudience, isExpired, type SiteRow } from "./db.js";
import { HttpError } from "./errors.js";
import { hashIp, requestIp } from "./ip.js";
import { consumeRate } from "./rate-limit.js";
import { siteUrl } from "./site-url.js";
import {
  consumeViewerAuthFlow, getViewerSession, getViewerSessionByHash, insertSiteGrant,
  insertViewerAuthFlow, insertViewerSession, revokeViewerSession, revokeViewerSessions,
  type ViewerSession,
} from "./viewer-db.js";

export const VIEW_CALLBACK_PATH = "/v1/auth/workos/view/callback";
/** The site-host redemption endpoint; only intercepted on org sites. */
export const SITE_SESSION_PATH = "/__shareplan/session";
const GRANT_SECONDS = 60;
const FLOW_SECONDS = 10 * 60;
const SESSION_SECONDS = 8 * 60 * 60;
/** New WorkOS sign-ins per hashed IP per hour; offices share NAT addresses. */
export const VIEWER_STARTS_PER_HOUR = 120;
const STATE_RE = /^[A-Za-z0-9_-]{1,256}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Shared with slice 5's redemption and site-cookie checks; path mode is off. */
export function browserViewingEnabled(config: Config): boolean {
  const base = new URL(config.publicBaseUrl);
  return config.workos !== null && Boolean(config.siteHostSuffix) &&
    (base.protocol === "https:" ||
      (base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)));
}

export function viewerCookieName(config: Config, name = "shareplan_viewer"): string {
  return new URL(config.publicBaseUrl).protocol === "https:" ? `__Host-${name}` : name;
}

/** Validate decoded forms too: encoded slashes/backslashes must not become a host. */
export function validViewerReturnPath(target: string): boolean {
  if (target.length === 0 || target.length > 1024) return false;
  // Only the path decides where the redirect lands. The query is returned as
  // given and may legitimately carry an encoded URL (`?next=https%3A%2F%2F…`).
  const q = target.indexOf("?");
  const query = q < 0 ? "" : target.slice(q);
  if (/[#\x00-\x1f\x7f]/.test(query)) return false;
  let decoded = q < 0 ? target : target.slice(0, q);
  for (;;) {
    if (!decoded.startsWith("/") || decoded.includes("//") || /[\\\x00-\x1f\x7f]/.test(decoded)) return false;
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
      try { return decodeURIComponent(part); } catch { return "\x00"; }
    });
    if (next === decoded) return true;
    decoded = next;
  }
}

export interface ViewerGrantInput {
  session: ViewerSession;
  site: SiteRow;
  returnPath: string;
  /** SHA-256 of the site-host nonce, never the nonce itself. */
  siteNonceHash: string;
}

/**
 * The apex half of the site handoff. Rechecks the viewer session and the
 * site's honoured audience, then mints a random 32-byte code, stored only as
 * a hash, valid for 60 seconds, single use, and bound to this viewer session,
 * this site and the site-host nonce hash. The redirect host comes from the
 * database row, never from the request.
 */
export function mintViewerGrant(
  db: DatabaseSync, config: Config, reply: FastifyReply, input: ViewerGrantInput,
): FastifyReply {
  const now = Date.now();
  const session = getViewerSessionByHash(db, input.session.token_hash, now);
  const site = getSite(db, input.site.id);
  if (!session || !site || isExpired(site, now) ||
      honouredAudience(db, site)?.workosOrgId !== session.workos_org_id) {
    return reply.code(403).send({
      error: { code: "viewer_signin_failed", message: "Viewer sign-in failed. Open the site and try again." },
    });
  }
  const code = randomBytes(32).toString("base64url");
  insertSiteGrant(db, {
    code_hash: hashApiKey(code), code_expires_at: now + GRANT_SECONDS * 1000,
    viewer_token_hash: session.token_hash, site_id: site.id,
    nonce_hash: input.siteNonceHash, return_path: input.returnPath,
    created_at: now, expires_at: session.expires_at,
  });
  const location = new URL(`${SITE_SESSION_PATH}?code=${code}`, siteUrl(config, site.id));
  return reply.redirect(location.href, 302);
}

/** Operator revoke: exactly one of email, WorkOS user id or WorkOS org id. */
const revokeViewersSchema = z.object({
  email: z.string().min(1).max(320).optional(),
  workosUserId: z.string().min(1).max(256).optional(),
  /** The WorkOS organization id (org_...) the viewer sessions are bound to. */
  orgId: z.string().regex(/^org_[0-9A-Za-z]{1,64}$/, "orgId must be a WorkOS organization id (org_...)").optional(),
}).strict().refine(
  (body) => [body.email, body.workosUserId, body.orgId].filter((v) => v !== undefined).length === 1,
  "pass exactly one of email, workosUserId, orgId",
);

// SDK 10.13.0's UserManagementAccessToken omits auth_time (and sub).
// These untrusted-shaped values are validated below before storing anything.
interface ViewerAccessTokenClaims {
  sid?: unknown;
  org_id?: unknown;
  sub?: unknown;
  /** Unix seconds, whereas flow/session timestamps use milliseconds. */
  auth_time?: unknown;
}

function decodeAccessToken(token: string | undefined): ViewerAccessTokenClaims {
  if (!token || token.split(".").length !== 3) throw new Error("invalid access token");
  const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) throw new Error("invalid claims");
  // No signature check: this token comes directly from the server-side code
  // exchange. Never call this with a token supplied by the browser.
  return claims as ViewerAccessTokenClaims;
}

export function registerViewerRoutes(
  app: FastifyInstance, config: Config, db: DatabaseSync, workos: WorkOSAuthClient | null,
): void {
  const base = new URL(config.publicBaseUrl);
  const secure = base.protocol === "https:";
  const cookieOptions = { path: "/", httpOnly: true, secure, sameSite: "lax" as const };
  const cookieName = viewerCookieName(config);
  const flowCookieName = (state: string) => viewerCookieName(config, `shareplan_view_flow_${state}`);
  const sessionFor = (req: FastifyRequest) => getViewerSession(db, req.cookies[cookieName]);
  const forbidden = (reply: FastifyReply) => reply.code(403).send({
    error: { code: "viewer_signin_failed", message: "Viewer sign-in failed. Open the site and try again." },
  });
  const options = {
    logLevel: "silent" as const, // Never log callback code/state, site nonce hashes or cookies.
    exposeHeadRoute: false,
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      setAuthPageHeaders(reply, false);
      if (req.headers.host?.toLowerCase() !== base.host.toLowerCase()) {
        throw new HttpError(404, "not_found", "not found");
      }
      if (!browserViewingEnabled(config) || !workos) {
        throw new HttpError(503, "viewer_unconfigured", "Viewer sign-in requires WorkOS, isolated site hosts and HTTPS (or loopback HTTP).");
      }
    },
  };

  app.get("/v1/view/start", options, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const label = query.site;
    const path = query.path ?? "/";
    const nonceHash = query.n;
    if (typeof label !== "string" || !isHostLabel(label) || RESERVED_HOST_LABELS.has(label) ||
        typeof path !== "string" || !validViewerReturnPath(path) ||
        (nonceHash !== undefined && (typeof nonceHash !== "string" || !/^[a-f0-9]{64}$/i.test(nonceHash)))) {
      throw new HttpError(400, "invalid_view_request", "Invalid viewer sign-in request.");
    }
    const site = getSiteByIdOrSlug(db, label);
    const audience = site && honouredAudience(db, site);
    if (!site || !audience || isExpired(site)) throw new HttpError(404, "not_found", "site not found");
    // Only the site host can issue the nonce; send the browser there for one.
    if (nonceHash === undefined) return reply.redirect(new URL(path, siteUrl(config, site.id)).href, 302);
    const session = sessionFor(req);
    if (session?.workos_org_id === audience.workosOrgId) {
      return mintViewerGrant(db, config, reply, { session, site, returnPath: path, siteNonceHash: nonceHash.toLowerCase() });
    }
    // Count only new WorkOS sign-ins: the redirect and the session shortcut never
    // call WorkOS, and a whole office can share one NAT address.
    const bucket = `viewer:${hashIp(requestIp(req), config.ipHashPepper ?? config.workos!.apiKey)}`;
    if (!consumeRate(db, bucket, "viewer_start", VIEWER_STARTS_PER_HOUR)) {
      throw new HttpError(429, "rate_limited", "Too many viewer sign-in attempts. Try again next hour.");
    }
    const created = Date.now();
    try {
      const authorization = await workos!.userManagement.getAuthorizationUrlWithPKCE({
        clientId: config.workos!.clientId,
        provider: "authkit",
        organizationId: audience.workosOrgId,
        redirectUri: new URL(VIEW_CALLBACK_PATH, config.workos!.redirectUri).href,
        maxAge: 0,
      });
      if (!STATE_RE.test(authorization.state)) throw new Error("invalid WorkOS state");
      const nonce = randomBytes(32).toString("base64url");
      insertViewerAuthFlow(db, {
        state_hash: hashApiKey(authorization.state), browser_nonce_hash: hashApiKey(nonce),
        code_verifier: authorization.codeVerifier, workos_org_id: audience.workosOrgId,
        site_id: site.id, return_path: path, site_nonce_hash: nonceHash.toLowerCase(),
        created_at: created, expires_at: created + FLOW_SECONDS * 1000,
      });
      reply.setCookie(flowCookieName(authorization.state), nonce, { ...cookieOptions, maxAge: FLOW_SECONDS });
      return reply.redirect(authorization.url, 302);
    } catch {
      // WorkOS exceptions may contain tokens or exchange details: don't log them.
      throw new HttpError(502, "viewer_signin_unavailable", "Could not start viewer sign-in. Try again.");
    }
  });

  app.get(VIEW_CALLBACK_PATH, options, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    if (typeof query.state !== "string" || !STATE_RE.test(query.state)) return forbidden(reply);
    const nonce = req.cookies[flowCookieName(query.state)];
    if (!nonce || !NONCE_RE.test(nonce)) return forbidden(reply);
    const flow = consumeViewerAuthFlow(db, query.state, nonce);
    if (!flow) return forbidden(reply);
    reply.clearCookie(flowCookieName(query.state), cookieOptions);
    if (query.error !== undefined || typeof query.code !== "string" || !query.code) return forbidden(reply);
    try {
      const result = await workos!.userManagement.authenticateWithCode({
        clientId: config.workos!.clientId, code: query.code, codeVerifier: flow.code_verifier,
        ipAddress: requestIp(req), userAgent: req.headers["user-agent"],
      });
      if (result.organizationId !== flow.workos_org_id || result.authenticationMethod !== "SSO" ||
          !result.user.emailVerified || result.impersonator != null) return forbidden(reply);
      const claims = decodeAccessToken(result.accessToken);
      if (claims.org_id !== flow.workos_org_id || claims.sub !== result.user.id ||
          typeof claims.sid !== "string" || !claims.sid ||
          typeof claims.auth_time !== "number" || !Number.isSafeInteger(claims.auth_time) ||
          claims.auth_time <= 0 || !Number.isSafeInteger(claims.auth_time * 1000) ||
          claims.auth_time * 1000 < flow.created_at - 60_000) return forbidden(reply);
      // Relink, detach, expiry or an old-binary publish during SSO must fail closed.
      const site = getSite(db, flow.site_id);
      if (!site || isExpired(site) || honouredAudience(db, site)?.workosOrgId !== flow.workos_org_id) return forbidden(reply);
      const now = Date.now();
      const token = randomBytes(32).toString("base64url");
      const session: ViewerSession = {
        token_hash: hashApiKey(token), workos_user_id: result.user.id, email: result.user.email,
        workos_org_id: flow.workos_org_id, workos_session_id: claims.sid, auth_time: claims.auth_time,
        created_at: now, expires_at: Math.min(now, claims.auth_time * 1000) + SESSION_SECONDS * 1000,
        revoked_at: null,
      };
      // Tokens and PKCE verifier are discarded; a viewer never gets a users row.
      insertViewerSession(db, session);
      // This cookie replaces any earlier session in this browser (e.g. another org's).
      const replaced = req.cookies[cookieName];
      if (replaced) revokeViewerSession(db, hashApiKey(replaced), now);
      reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: Math.floor((session.expires_at - now) / 1000) });
      return mintViewerGrant(db, config, reply, {
        session, site, returnPath: flow.return_path, siteNonceHash: flow.site_nonce_hash,
      });
    } catch {
      return forbidden(reply);
    }
  });

  app.get("/v1/view/", options, async (req, reply) => {
    setAuthPageHeaders(reply, true);
    // Preserve Origin on the sign-out form, exactly as the owner portal does.
    reply.header("Referrer-Policy", "same-origin");
    const session = sessionFor(req);
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Viewer sign-in · shareplan</title></head>
<body><h1>Viewer sign-in</h1>${session
      ? `<p>Signed in as ${escapeHtml(session.email)}</p><form method="post" action="/v1/view/logout"><button type="submit">Sign out</button></form>`
      : '<p>You are not signed in. Open an organization site to sign in through its identity provider.</p>'}
<p><a href="/">shareplan</a></p></body></html>`);
  });

  app.post("/v1/view/logout", { ...options, bodyLimit: 4096 }, async (req, reply) => {
    if (req.headers.origin !== base.origin) throw new HttpError(403, "invalid_origin", "Submit this form from the viewer sign-in page.");
    const session = sessionFor(req);
    if (session) revokeViewerSession(db, session.token_hash);
    reply.clearCookie(cookieName, cookieOptions);
    const url = session
      ? workos!.userManagement.getLogoutUrl({ sessionId: session.workos_session_id, returnTo: new URL("/", base).href })
      : new URL("/", base).href;
    // Finish the form POST before navigating outside its form-action 'self'.
    return claimRedirectPage(reply, url, "sign-out");
  });

  // Keep disabled-mode and auth-page headers consistent even for unknown paths.
  app.all("/v1/view/*", options, async () => { throw new HttpError(404, "not_found", "not found"); });

  // Operator revoke works whether or not browser viewing is enabled, so it can
  // be used during an incident. Takes effect on the next site request.
  app.post("/api/v1/admin/viewer-sessions/revoke", async (req, reply) => {
    requireAdmin(config.adminTokenHash, req);
    const body = revokeViewersSchema.parse(req.body ?? {});
    const revoked = revokeViewerSessions(db,
      body.email !== undefined ? { email: body.email }
      : body.workosUserId !== undefined ? { workosUserId: body.workosUserId }
      : { workosOrgId: body.orgId! });
    return reply.send({ revoked });
  });
}
