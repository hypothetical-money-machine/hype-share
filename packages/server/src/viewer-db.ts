import type { DatabaseSync } from "node:sqlite";
import { hashApiKey } from "./db.js";

export interface ViewerAuthFlow {
  state_hash: string;
  browser_nonce_hash: string;
  code_verifier: string;
  workos_org_id: string;
  site_id: string;
  return_path: string;
  site_nonce_hash: string;
  created_at: number;
  expires_at: number;
}

export interface ViewerSession {
  token_hash: string;
  workos_user_id: string;
  email: string;
  workos_org_id: string;
  workos_session_id: string;
  /** Unix seconds from the server-side WorkOS exchange, never a browser token. */
  auth_time: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export function insertViewerAuthFlow(db: DatabaseSync, flow: ViewerAuthFlow): void {
  db.prepare(`INSERT INTO viewer_auth_flows
    (state_hash, browser_nonce_hash, code_verifier, workos_org_id, site_id,
     return_path, site_nonce_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(flow.state_hash, flow.browser_nonce_hash, flow.code_verifier,
      flow.workos_org_id, flow.site_id, flow.return_path, flow.site_nonce_hash,
      flow.created_at, flow.expires_at);
}

/** Consume before exchanging the code, so concurrent callbacks cannot reuse it. */
export function consumeViewerAuthFlow(
  db: DatabaseSync, state: string, browserNonce: string, now = Date.now(),
): ViewerAuthFlow | null {
  return db.prepare(`DELETE FROM viewer_auth_flows
    WHERE state_hash = ? AND browser_nonce_hash = ? AND expires_at > ? RETURNING *`)
    .get(hashApiKey(state), hashApiKey(browserNonce), now) as unknown as ViewerAuthFlow | undefined ?? null;
}

export function insertViewerSession(db: DatabaseSync, session: ViewerSession): void {
  db.prepare(`INSERT INTO viewer_sessions
    (token_hash, workos_user_id, email, workos_org_id, workos_session_id,
     auth_time, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(session.token_hash, session.workos_user_id, session.email,
      session.workos_org_id, session.workos_session_id, session.auth_time,
      session.created_at, session.expires_at, session.revoked_at);
}

export function getViewerSession(
  db: DatabaseSync, token: string | undefined, now = Date.now(),
): ViewerSession | null {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare(`SELECT * FROM viewer_sessions
    WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL`)
    .get(hashApiKey(token), now) as unknown as ViewerSession | undefined ?? null;
}

/** A live (unexpired, unrevoked) viewer session by its stored hash. */
export function getViewerSessionByHash(
  db: DatabaseSync, tokenHash: string, now = Date.now(),
): ViewerSession | null {
  return db.prepare(`SELECT * FROM viewer_sessions
    WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL`)
    .get(tokenHash, now) as unknown as ViewerSession | undefined ?? null;
}

export function revokeViewerSession(db: DatabaseSync, tokenHash: string, now = Date.now()): void {
  // Every site-cookie request joins the parent viewer session, so revoking it
  // invalidates all of its site sessions immediately. Its FK also cascades
  // when the reaper deletes this row.
  db.prepare(`UPDATE viewer_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .run(now, tokenHash);
}

export type ViewerRevokeFilter =
  | { email: string } | { workosUserId: string } | { workosOrgId: string };

/** Operator revoke. Takes effect on the next site request. Returns the count. */
export function revokeViewerSessions(
  db: DatabaseSync, filter: ViewerRevokeFilter, now = Date.now(),
): number {
  const [where, value] =
    "email" in filter ? ["email = ? COLLATE NOCASE", filter.email]
    : "workosUserId" in filter ? ["workos_user_id = ?", filter.workosUserId]
    : ["workos_org_id = ?", filter.workosOrgId];
  const result = db.prepare(`UPDATE viewer_sessions SET revoked_at = ?
    WHERE revoked_at IS NULL AND expires_at > ? AND ${where}`).run(now, now, value);
  return Number(result.changes ?? 0);
}

export interface SiteSession {
  code_hash: string;
  code_expires_at: number;
  used_at: number | null;
  token_hash: string | null;
  viewer_token_hash: string;
  site_id: string;
  nonce_hash: string;
  return_path: string;
  created_at: number;
  expires_at: number;
}

export function insertSiteGrant(
  db: DatabaseSync,
  grant: Omit<SiteSession, "used_at" | "token_hash">,
): void {
  db.prepare(`INSERT INTO site_sessions
    (code_hash, code_expires_at, used_at, token_hash, viewer_token_hash, site_id,
     nonce_hash, return_path, created_at, expires_at)
    VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(grant.code_hash, grant.code_expires_at, grant.viewer_token_hash, grant.site_id,
      grant.nonce_hash, grant.return_path, grant.created_at, grant.expires_at);
}

/**
 * Burn a grant code: unused, unexpired, for this site, presented with the
 * nonce whose hash it was bound to. One UPDATE, so two redemptions can never
 * both succeed. The caller must still recheck the viewer and the audience.
 */
export function consumeSiteGrant(
  db: DatabaseSync, code: string, siteId: string, nonce: string, now = Date.now(),
): SiteSession | null {
  return db.prepare(`UPDATE site_sessions SET used_at = ?
    WHERE code_hash = ? AND used_at IS NULL AND code_expires_at > ?
      AND site_id = ? AND nonce_hash = ?
    RETURNING *`)
    .get(now, hashApiKey(code), now, siteId, hashApiKey(nonce)) as unknown as SiteSession | undefined ?? null;
}

/** Attach the site cookie's hash to a consumed grant. */
export function activateSiteSession(
  db: DatabaseSync, codeHash: string, tokenHash: string, expiresAt: number,
): void {
  db.prepare(`UPDATE site_sessions SET token_hash = ?, expires_at = ? WHERE code_hash = ?`)
    .run(tokenHash, expiresAt, codeHash);
}

/**
 * The live site session behind a site cookie, for this site only, joined to
 * its live viewer session. The caller compares the viewer's WorkOS org with
 * the site's honoured audience.
 */
export function getLiveSiteSession(
  db: DatabaseSync, token: string | undefined, siteId: string, now = Date.now(),
): (SiteSession & { workos_org_id: string }) | null {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare(`SELECT s.*, v.workos_org_id FROM site_sessions s
    JOIN viewer_sessions v ON v.token_hash = s.viewer_token_hash
    WHERE s.token_hash = ? AND s.site_id = ? AND s.expires_at > ?
      AND v.expires_at > ? AND v.revoked_at IS NULL`)
    .get(hashApiKey(token), siteId, now, now) as unknown as
      (SiteSession & { workos_org_id: string }) | undefined ?? null;
}

export function pruneViewerAuth(db: DatabaseSync, now = Date.now()): void {
  db.prepare("DELETE FROM viewer_auth_flows WHERE expires_at <= ?").run(now);
  // Unredeemed codes go once they expire; redeemed ones at the session's end.
  db.prepare(`DELETE FROM site_sessions
    WHERE expires_at <= ? OR (token_hash IS NULL AND code_expires_at <= ?)`).run(now, now);
  // Cascades to the site sessions of expired and revoked viewers.
  db.prepare("DELETE FROM viewer_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
}
