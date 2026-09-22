import type { FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import {
  findApiKeyByToken,
  getOrg,
  getUser,
  hashApiKey,
  type ApiKeyRow,
  type OrgRow,
  type UserRow,
} from "./db.js";
import { effectiveTier, orgTier, type Tier } from "./tiers.js";

export class AuthError extends Error {
  override readonly name = "AuthError";
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() || null;
}

export function requireApiKey(db: DatabaseSync, req: FastifyRequest): ApiKeyRow {
  const token = extractBearer(req);
  if (!token) {
    throw new AuthError(401, "unauthorized", "missing Authorization: Bearer token");
  }
  const key = findApiKeyByToken(db, token);
  if (!key) {
    throw new AuthError(401, "unauthorized", "invalid API key");
  }
  return key;
}

/** Resolved once per request; tier is the effective tier (own or org, whichever is higher). */
export interface Account {
  key: ApiKeyRow;
  user: UserRow;
  org: OrgRow | null;
  tier: Tier;
}

export function requireAccount(db: DatabaseSync, req: FastifyRequest): Account {
  const key = requireApiKey(db, req);
  const user = getUser(db, key.user_id);
  if (!user) {
    throw new AuthError(401, "unauthorized", "invalid API key");
  }
  const org = user.org_id === null ? null : getOrg(db, user.org_id);
  return { key, user, org, tier: effectiveTier(user.tier, orgTier(org)) };
}

/** Org-admin routes. The org comes from the caller's own row, never from the URL. */
export function requireOrgAdmin(
  db: DatabaseSync,
  req: FastifyRequest,
): Account & { org: OrgRow } {
  const account = requireAccount(db, req);
  if (account.org === null) {
    throw new AuthError(404, "no_org", "this account is not in an organization");
  }
  if (account.user.org_role !== "admin") {
    throw new AuthError(403, "org_admin_required", "organization admin role required");
  }
  return account as Account & { org: OrgRow };
}

export function requireAdmin(
  adminTokenHash: string | null,
  req: FastifyRequest,
): void {
  if (!adminTokenHash) {
    throw new AuthError(503, "admin_disabled", "admin token not configured");
  }
  const token = extractBearer(req);
  const header = req.headers["x-admin-token"];
  const fromHeader = typeof header === "string" ? header : null;
  const bearerOk = hashedTokenEquals(token, adminTokenHash);
  const headerOk = hashedTokenEquals(fromHeader, adminTokenHash);
  if (!bearerOk && !headerOk) {
    throw new AuthError(401, "unauthorized", "invalid admin token");
  }
}

function hashedTokenEquals(presented: string | null, expectedHash: string): boolean {
  const incoming = Buffer.from(hashApiKey(presented ?? ""), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  if (incoming.length !== expected.length) return false;
  return timingSafeEqual(incoming, expected);
}
