import type { FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { findApiKeyByToken, type ApiKeyRow } from "./db.js";

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

export function requireAdmin(
  adminToken: string | null,
  req: FastifyRequest,
): void {
  if (!adminToken) {
    throw new AuthError(503, "admin_disabled", "admin token not configured");
  }
  const token = extractBearer(req);
  if (!token || token !== adminToken) {
    // Also accept X-Admin-Token
    const header = req.headers["x-admin-token"];
    const fromHeader = typeof header === "string" ? header : null;
    if (fromHeader !== adminToken && token !== adminToken) {
      throw new AuthError(401, "unauthorized", "invalid admin token");
    }
  }
}
