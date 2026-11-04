import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyReply, FastifyRequest } from "fastify";
import { extractBearer, requireAccount } from "./auth.js";
import type { Config } from "./config.js";
import { getSite, hashApiKey, honouredAudience, isExpired, transaction, type SiteAudience, type SiteRow } from "./db.js";
import {
  activateSiteSession, consumeSiteGrant, getLiveSiteSession, getViewerSessionByHash,
} from "./viewer-db.js";
import { browserViewingEnabled, SITE_SESSION_PATH, viewerCookieName } from "./viewer.js";

const NONCE_SECONDS = 10 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The uploaded-HTML policy, shared by every site. */
export const SITE_HTML_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
export const SITE_SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox";
/** Org sites send a CSP on every response, so no upload type can register a worker. */
export const ORG_HTML_CSP = `${SITE_HTML_CSP}; worker-src 'none'`;
export const ORG_SVG_CSP = `${SITE_SVG_CSP}; worker-src 'none'`;

/**
 * Headers on every response from an org site, redirects and errors included.
 * No CORS headers are ever set. Content serving swaps in ORG_SVG_CSP for SVG.
 */
export function setOrgSiteHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Cookie, Authorization");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  reply.header("Content-Security-Policy", ORG_HTML_CSP);
}

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

/**
 * Sibling sites are same-site, so SameSite cookies don't keep them out. From
 * another site (same-site or cross-site), only a top-level document navigation
 * may continue; fetches, scripts, images and frames get a 404 before any
 * cookie is read. Same-origin and user-initiated (none) requests continue, as
 * do clients that send no fetch metadata at all (agents, curl).
 */
export function fetchMetadataAllows(req: FastifyRequest): boolean {
  const site = header(req, "sec-fetch-site");
  if (site !== "same-site" && site !== "cross-site") return true;
  return header(req, "sec-fetch-mode") === "navigate" && header(req, "sec-fetch-dest") === "document";
}

/** A top-level document navigation, or a client without fetch metadata asking for HTML. */
function isDocumentNavigation(req: FastifyRequest): boolean {
  const mode = header(req, "sec-fetch-mode");
  const dest = header(req, "sec-fetch-dest");
  if (mode === undefined && dest === undefined) return (header(req, "accept") ?? "").includes("text/html");
  return mode === "navigate" && dest === "document";
}

function siteCookieOptions(config: Config) {
  return {
    path: "/", httpOnly: true, sameSite: "lax" as const,
    secure: new URL(config.publicBaseUrl).protocol === "https:",
  };
}

export const siteCookieName = (config: Config) => viewerCookieName(config, "shareplan_site");
/**
 * Site nonces live in one cookie per pending sign-in, `<prefix>shareplan_site_nonce_<slot>`,
 * so two first visits that race (neither yet holding a nonce) don't overwrite each other.
 */
export const siteNonceCookiePrefix = (config: Config) => viewerCookieName(config, "shareplan_site_nonce_");
const NONCE_SLOT_RE = /^[a-f0-9]{8}$/;
const MAX_NONCES = 8;

/** This browser's site nonces on this host, as [cookie name, value], oldest names first. */
function siteNonces(config: Config, req: FastifyRequest): [string, string][] {
  const prefix = siteNonceCookiePrefix(config);
  return Object.entries(req.cookies)
    .filter((entry): entry is [string, string] => entry[0].startsWith(prefix) &&
      NONCE_SLOT_RE.test(entry[0].slice(prefix.length)) && typeof entry[1] === "string" && TOKEN_RE.test(entry[1]))
    .slice(0, MAX_NONCES);
}

function error(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ error: { code, message } });
}

/**
 * Access control for a site with an honoured org audience. Resolves to true
 * when the caller may read the content (the caller then serves it), or false
 * once a response has been sent. Order: the handoff endpoint, the owner's
 * bearer key, the fetch-metadata guard, the site cookie, then a sign-in
 * redirect for document navigations, else 401.
 */
export async function authorizeOrgSite(
  config: Config, db: DatabaseSync, req: FastifyRequest, reply: FastifyReply,
  site: SiteRow, audience: SiteAudience, relPath: string,
): Promise<boolean> {
  if (header(req, "service-worker") === "script") {
    await error(reply, 404, "not_found", "file not found");
    return false;
  }
  const path = `/${relPath.replace(/^\/+/, "")}`;
  if (path === "/__shareplan" || path.startsWith("/__shareplan/")) {
    // Uploads under __shareplan/ are refused, so nothing real lives here.
    if (path !== SITE_SESSION_PATH) {
      await error(reply, 404, "not_found", "file not found");
      return false;
    }
    await redeemSiteGrant(config, db, req, reply, site);
    return false;
  }

  if (extractBearer(req) !== null) {
    // Agents: the owner's key only, exactly as for private sites.
    try {
      const { user } = requireAccount(db, req);
      if (user.id === site.owner_user_id) return true;
      await error(reply, 404, "not_found", "site not found");
    } catch {
      await error(reply, 401, "unauthorized", "private site requires API key");
    }
    return false;
  }

  if (!fetchMetadataAllows(req)) {
    await error(reply, 404, "not_found", "site not found");
    return false;
  }

  const enabled = browserViewingEnabled(config);
  if (enabled) {
    const session = getLiveSiteSession(db, req.cookies[siteCookieName(config)], site.id);
    if (session !== null && session.workos_org_id === audience.workosOrgId) return true;
  }

  if (enabled && req.method === "GET" && isDocumentNavigation(req)) {
    // Reuse an unexpired nonce so a second tab doesn't strand the first
    // tab's pending grant, and give it a fresh 10 minutes either way.
    const [name, nonce] = siteNonces(config, req)[0] ??
      [`${siteNonceCookiePrefix(config)}${randomBytes(4).toString("hex")}`, randomBytes(32).toString("base64url")];
    reply.setCookie(name, nonce, { ...siteCookieOptions(config), maxAge: NONCE_SECONDS });
    const start = new URL("/v1/view/start", config.publicBaseUrl);
    start.search = new URLSearchParams({
      site: site.id,
      // The raw request target, relative; /v1/view/start validates it again.
      path: req.url.replace(/^\/+/, "/"),
      n: hashApiKey(nonce),
    }).toString();
    await reply.redirect(start.href, 302);
    return false;
  }

  await error(reply, 401, "unauthorized", "sign in to view this site");
  return false;
}

/**
 * GET /__shareplan/session?code=… on the site host. HEAD is refused so a
 * link preview can't burn the code. The code is consumed in one step; the
 * viewer session and the audience are rechecked; then the site cookie is set
 * and the browser goes to the stored relative path before any uploaded HTML
 * runs. The nonce cookie is left to expire: another tab may still need it.
 */
async function redeemSiteGrant(
  config: Config, db: DatabaseSync, req: FastifyRequest, reply: FastifyReply, site: SiteRow,
): Promise<void> {
  if (req.method !== "GET") {
    reply.header("Allow", "GET");
    await error(reply, 405, "method_not_allowed", "use GET");
    return;
  }
  if (!fetchMetadataAllows(req)) {
    await error(reply, 404, "not_found", "site not found");
    return;
  }
  if (!browserViewingEnabled(config)) {
    await error(reply, 503, "viewer_unconfigured", "Viewer sign-in requires WorkOS, isolated site hosts and HTTPS (or loopback HTTP).");
    return;
  }
  const code = (req.query as Record<string, unknown>).code;
  const nonces = siteNonces(config, req).map(([, value]) => value);
  const invalid = () => error(reply, 400, "invalid_handoff", "This sign-in link is invalid or expired. Open the site again.");
  if (typeof code !== "string" || !TOKEN_RE.test(code) || nonces.length === 0) {
    await invalid();
    return;
  }
  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  const outcome = transaction(db, () => {
    // The grant is bound to one nonce; a wrong one never consumes it.
    let grant: ReturnType<typeof consumeSiteGrant> = null;
    for (const nonce of nonces) {
      grant = consumeSiteGrant(db, code, site.id, nonce, now);
      if (grant !== null) break;
    }
    if (grant === null) return "invalid" as const;
    const viewer = getViewerSessionByHash(db, grant.viewer_token_hash, now);
    const current = getSite(db, site.id);
    if (viewer === null || current === null || isExpired(current, now) ||
        honouredAudience(db, current)?.workosOrgId !== viewer.workos_org_id) {
      return "denied" as const;
    }
    const expiresAt = Math.min(grant.expires_at, viewer.expires_at);
    activateSiteSession(db, grant.code_hash, hashApiKey(token), expiresAt);
    return { returnPath: grant.return_path, expiresAt };
  });
  if (outcome === "invalid") {
    await invalid();
    return;
  }
  if (outcome === "denied") {
    await error(reply, 403, "viewer_signin_failed", "Viewer sign-in failed. Open the site and try again.");
    return;
  }
  reply.setCookie(siteCookieName(config), token, {
    ...siteCookieOptions(config), maxAge: Math.max(1, Math.floor((outcome.expiresAt - now) / 1000)),
  });
  // Validated at /v1/view/start: one leading slash, no "//" or "\", so relative.
  await reply.redirect(outcome.returnPath, 302);
}
