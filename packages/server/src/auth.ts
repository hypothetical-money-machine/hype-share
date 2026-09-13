import type { FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import {
  findApiKeyByToken,
  getUser,
  hashApiKey,
  type ApiKeyRow,
  type UserRow,
} from "./db.js";

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

export function requireAccount(
  db: DatabaseSync,
  req: FastifyRequest,
): { key: ApiKeyRow; user: UserRow } {
  const key = requireApiKey(db, req);
  const user = getUser(db, key.user_id);
  if (!user) {
    throw new AuthError(401, "unauthorized", "invalid API key");
  }
  return { key, user };
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
