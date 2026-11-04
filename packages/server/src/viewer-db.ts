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

export function revokeViewerSession(db: DatabaseSync, tokenHash: string, now = Date.now()): void {
  // Slice 5 checks the parent viewer session on every site-cookie request;
  // revoking it invalidates all of its site sessions immediately. Its FK will
  // also cascade when the reaper deletes this row.
  db.prepare(`UPDATE viewer_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .run(now, tokenHash);
}

export function pruneViewerAuth(db: DatabaseSync, now = Date.now()): void {
  db.prepare("DELETE FROM viewer_auth_flows WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM viewer_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
}
