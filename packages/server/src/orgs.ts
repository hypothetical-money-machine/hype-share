import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createApiKey, type SiteListItem } from "@shareplan/core";
import type { Config } from "./config.js";
import {
  assertOrgHasRoom,
  countOrgMembers,
  countOrgSites,
  createOrg,
  createOrgMember,
  deleteOrg,
  findOrgByJoinToken,
  getOrg,
  getUser,
  listOrgMembers,
  listOrgs,
  listSitesForOrg,
  removeOrgMember,
  revokeOrgMemberKey,
  setOrgJoinToken,
  setOrgMemberRole,
  setUserOrg,
  updateOrg,
  type OrgMemberRow,
  type OrgPatch,
  type OrgRow,
  type SiteRow,
} from "./db.js";
import { requireAccount, requireAdmin, requireOrgAdmin, type Account } from "./auth.js";
import { HttpError } from "./errors.js";
import { consumeRate } from "./rate-limit.js";
import {
  effectiveTier,
  isOrgTier,
  orgTier,
  policyFor,
  TIER_RANK,
  type OrgRole,
  type OrgTier,
} from "./tiers.js";

/** "org_" + 32 random bytes as base64url (43 chars). Only its hash is stored. */
export const ORG_TOKEN_RE = /^org_[A-Za-z0-9_-]{43}$/;
export const ORG_JOINS_PER_HOUR = 10;

export function createOrgToken(): string {
  return `org_${randomBytes(32).toString("base64url")}`;
}

const roleSchema = z.enum(["admin", "member"]);

export const createKeySchema = z.object({
  name: z.string().min(1).max(100).default("default"),
});

const mintKeySchema = createKeySchema.extend({
  role: roleSchema.default("member"),
});

const removeMemberQuerySchema = z.object({
  revokeKeys: z.enum(["true", "false"]).default("false"),
});

const joinSchema = z.object({
  orgToken: z.string().regex(ORG_TOKEN_RE, "orgToken must be an organization join token"),
});

const joinTokenSchema = z.object({
  disable: z.boolean().default(false),
});

const setRoleSchema = z.object({ role: roleSchema });

const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  compTier: z.string().nullable().default(null),
  maxMembers: z.number().int().min(1).max(10000).default(100),
  publishPerHour: z.number().int().min(1).nullable().default(null),
});

const updateOrgSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    compTier: z.string().nullable().optional(),
    maxMembers: z.number().int().min(1).max(10000).optional(),
    publishPerHour: z.number().int().min(1).nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "at least one of name, compTier, maxMembers, publishPerHour is required",
  });

const setUserOrgSchema = z.object({
  orgId: z.string().min(1).nullable(),
  role: roleSchema.default("member"),
});

export interface OrgRouteDeps {
  config: Config;
  db: DatabaseSync;
  toListItem: (row: SiteRow) => SiteListItem;
}

/**
 * The pooled org publish bucket, or null when the member publishes on their
 * own plan: no org, an ops user, a tier-less org, or an own tier above the
 * org's.
 */
export function orgPublishPool(account: Account): { orgId: string; limit: number } | null {
  const org = account.org;
  if (org === null || account.user.tier === "ops") return null;
  const t = orgTier(org);
  if (t === null || TIER_RANK[t] < TIER_RANK[account.user.tier]) return null;
  return { orgId: org.id, limit: org.publish_per_hour ?? policyFor(t).publishPerHour };
}

export interface OrgPublic {
  id: string;
  name: string;
  tier: OrgTier | null;
}

export function orgPublic(org: OrgRow): OrgPublic {
  return { id: org.id, name: org.name, tier: orgTier(org) };
}

/** Register / mint response: the register shape plus effectiveTier and org. */
export function mintOrgMember(
  db: DatabaseSync,
  config: Config,
  org: OrgRow,
  name: string,
  role: OrgRole,
): {
  userId: string;
  keyId: string;
  name: string;
  token: string;
  tier: string;
  effectiveTier: string;
  org: OrgPublic & { role: OrgRole };
  claimUrl: string;
  createdAt: string;
} {
  const token = createApiKey();
  const claimToken = randomBytes(16).toString("base64url");
  const { user, key } = createOrgMember(db, { org, name, token, role, claimToken });
  return {
    userId: user.id,
    keyId: key.id,
    name: key.name,
    token,
    tier: user.tier,
    effectiveTier: effectiveTier(user.tier, orgTier(org)),
    org: { ...orgPublic(org), role },
    claimUrl: `${config.publicBaseUrl}/claim/${claimToken}`,
    createdAt: iso(key.created_at),
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseOrgTier(value: string | null): OrgTier | null {
  if (value === null) return null;
  if (value === "ops") {
    throw new HttpError(400, "invalid_tier", "an organization cannot hold the ops tier");
  }
  if (!isOrgTier(value)) {
    throw new HttpError(400, "invalid_tier", `unknown tier: ${value}`);
  }
  return value;
}

function orgAdminView(db: DatabaseSync, org: OrgRow) {
  const tier = orgTier(org);
  return {
    ...orgPublic(org),
    compTier: org.comp_tier,
    billingTier: org.billing_tier,
    stripeCustomerId: org.stripe_customer_id,
    maxMembers: org.max_members,
    memberCount: countOrgMembers(db, org.id),
    publishPerHour: tier === null ? null : (org.publish_per_hour ?? policyFor(tier).publishPerHour),
    joinEnabled: org.join_token_hash !== null,
    createdAt: iso(org.created_at),
    updatedAt: iso(org.updated_at),
  };
}

function orgAdminViewWithSites(db: DatabaseSync, org: OrgRow) {
  const sites = countOrgSites(db, org.id);
  return { ...orgAdminView(db, org), siteCount: sites.total, permanentSites: sites.permanent };
}

function memberView(member: OrgMemberRow, org: OrgRow) {
  return {
    userId: member.id,
    role: member.org_role,
    tier: member.tier,
    effectiveTier: effectiveTier(member.tier, orgTier(org)),
    email: member.email,
    claimedAt: member.claimed_at === null ? null : iso(member.claimed_at),
    createdAt: iso(member.created_at),
    keys: member.keys.map((k) => ({ id: k.id, name: k.name, createdAt: iso(k.created_at) })),
    sites: member.sites,
  };
}

function memberList(db: DatabaseSync, org: OrgRow) {
  return listOrgMembers(db, org.id).map((m) => memberView(m, org));
}

function requireOrg(db: DatabaseSync, id: string): OrgRow {
  const org = getOrg(db, id);
  if (org === null) throw new HttpError(404, "not_found", "organization not found");
  return org;
}

/**
 * The org's daily register bucket, shared by token registration and admin
 * minting. A full org is refused before the bucket is charged so the attempt
 * costs no slot; createOrgMember repeats the check inside its transaction.
 */
export function consumeOrgRegister(db: DatabaseSync, config: Config, org: OrgRow): void {
  assertOrgHasRoom(db, org);
  if (!consumeRate(db, `org:${org.id}`, "register", config.orgRegisterPerDay)) {
    throw new HttpError(429, "rate_limited", "too many registrations for this organization");
  }
}

export function registerOrgRoutes(app: FastifyInstance, deps: OrgRouteDeps): void {
  const { config, db } = deps;

  // --- Member routes (any key) ---
  app.get("/api/v1/me", async (req, reply) => {
    const account = requireAccount(db, req);
    return reply.send({
      userId: account.user.id,
      tier: account.user.tier,
      effectiveTier: account.tier,
      email: account.user.email,
      claimed: account.user.claimed_at !== null,
      key: { id: account.key.id, name: account.key.name },
      org:
        account.org === null
          ? null
          : { ...orgPublic(account.org), role: account.user.org_role },
    });
  });

  app.post("/api/v1/org/join", async (req, reply) => {
    const account = requireAccount(db, req);
    const body = joinSchema.parse(req.body ?? {});
    if (account.user.tier === "ops") {
      throw new HttpError(400, "invalid_tier", "operator accounts do not join organizations");
    }
    if (account.user.org_id !== null) {
      throw new HttpError(409, "already_in_org", "this account already belongs to an organization");
    }
    // Spent before the lookup so a guessed token costs the same as a valid one.
    if (!consumeRate(db, `user:${account.user.id}`, "org_join", ORG_JOINS_PER_HOUR)) {
      throw new HttpError(429, "rate_limited", "too many join attempts");
    }
    const org = findOrgByJoinToken(db, body.orgToken);
    if (org === null) {
      throw new HttpError(401, "invalid_org_token", "invalid organization join token");
    }
    const result = setUserOrg(db, account.user, org, "member", Date.now());
    return reply.send({
      org: orgPublic(org),
      role: "member",
      tier: account.user.tier,
      effectiveTier: result.effectiveTier,
    });
  });

  // --- Org-admin routes (the org comes from the caller's row) ---
  app.get("/api/v1/org/members", async (req, reply) => {
    const account = requireOrgAdmin(db, req);
    return reply.send({ org: orgPublic(account.org), members: memberList(db, account.org) });
  });

  app.post("/api/v1/org/keys", async (req, reply) => {
    const account = requireOrgAdmin(db, req);
    const body = mintKeySchema.parse(req.body ?? {});
    consumeOrgRegister(db, config, account.org);
    return reply.status(201).send(mintOrgMember(db, config, account.org, body.name, body.role));
  });

  app.put("/api/v1/org/members/:userId", async (req, reply) => {
    const account = requireOrgAdmin(db, req);
    const { userId } = req.params as { userId: string };
    const body = setRoleSchema.parse(req.body ?? {});
    if (!setOrgMemberRole(db, account.org.id, userId, body.role)) {
      throw new HttpError(404, "member_not_found", "member not found");
    }
    const member = listOrgMembers(db, account.org.id).find((m) => m.id === userId)!;
    return reply.send(memberView(member, account.org));
  });

  app.delete("/api/v1/org/members/:userId", async (req, reply) => {
    const account = requireOrgAdmin(db, req);
    const { userId } = req.params as { userId: string };
    const query = removeMemberQuerySchema.parse(req.query ?? {});
    const result = removeOrgMember(db, account.org.id, userId, Date.now(), {
      revokeKeys: query.revokeKeys === "true",
    });
    if (result === null) {
      throw new HttpError(404, "member_not_found", "member not found");
    }
    return reply.send({ userId, ...result });
  });

  app.delete("/api/v1/org/keys/:keyId", async (req, reply) => {
    const account = requireOrgAdmin(db, req);
    const { keyId } = req.params as { keyId: string };
    if (!revokeOrgMemberKey(db, account.org.id, keyId, Date.now())) {
      throw new HttpError(404, "not_found", "key not found or already revoked");
    }
    return reply.status(204).send();
  });

  app.post("/api/v1/org/join-token", async (req, reply) => {
    const account = requireOrgAdmin(db, req);
    const body = joinTokenSchema.parse(req.body ?? {});
    const joinToken = body.disable ? null : createOrgToken();
    setOrgJoinToken(db, account.org.id, joinToken, Date.now());
    return reply.send({ joinToken });
  });

  app.get("/api/v1/org/sites", async (req, reply) => {
    const account = requireOrgAdmin(db, req);
    const sites = listSitesForOrg(db, account.org.id).map((row) => ({
      ...deps.toListItem(row),
      ownerUserId: row.owner_user_id,
    }));
    return reply.send({ sites });
  });

  // --- Operator routes (admin token) ---
  app.post("/api/v1/admin/orgs", async (req, reply) => {
    requireAdmin(config.adminTokenHash, req);
    const body = createOrgSchema.parse(req.body ?? {});
    const compTier = parseOrgTier(body.compTier);
    const joinToken = createOrgToken();
    const org = createOrg(db, {
      name: body.name,
      compTier,
      maxMembers: body.maxMembers,
      publishPerHour: body.publishPerHour,
      joinToken,
    });
    return reply.status(201).send({ org: orgAdminView(db, org), joinToken });
  });

  app.get("/api/v1/admin/orgs", async (req, reply) => {
    requireAdmin(config.adminTokenHash, req);
    return reply.send({ orgs: listOrgs(db).map((org) => orgAdminViewWithSites(db, org)) });
  });

  app.get("/api/v1/admin/orgs/:id", async (req, reply) => {
    requireAdmin(config.adminTokenHash, req);
    const { id } = req.params as { id: string };
    const org = requireOrg(db, id);
    const { siteCount, permanentSites, ...view } = orgAdminViewWithSites(db, org);
    return reply.send({ org: view, members: memberList(db, org), siteCount, permanentSites });
  });

  app.put("/api/v1/admin/orgs/:id", async (req, reply) => {
    requireAdmin(config.adminTokenHash, req);
    const { id } = req.params as { id: string };
    const body = updateOrgSchema.parse(req.body ?? {});
    const patch: OrgPatch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.compTier !== undefined) patch.comp_tier = parseOrgTier(body.compTier);
    if (body.maxMembers !== undefined) patch.max_members = body.maxMembers;
    if (body.publishPerHour !== undefined) patch.publish_per_hour = body.publishPerHour;
    const result = updateOrg(db, id, patch, Date.now());
    if (result === null) throw new HttpError(404, "not_found", "organization not found");
    return reply.send({ org: orgAdminView(db, result.org), clamped: result.clamped });
  });

  app.delete("/api/v1/admin/orgs/:id", async (req, reply) => {
    requireAdmin(config.adminTokenHash, req);
    const { id } = req.params as { id: string };
    const clamped = deleteOrg(db, id, Date.now());
    if (clamped === null) throw new HttpError(404, "not_found", "organization not found");
    return reply.send({ clamped });
  });

  app.post("/api/v1/admin/orgs/:id/join-token", async (req, reply) => {
    requireAdmin(config.adminTokenHash, req);
    const { id } = req.params as { id: string };
    const body = joinTokenSchema.parse(req.body ?? {});
    const joinToken = body.disable ? null : createOrgToken();
    if (!setOrgJoinToken(db, id, joinToken, Date.now())) {
      throw new HttpError(404, "not_found", "organization not found");
    }
    return reply.send({ joinToken });
  });

  app.post("/api/v1/admin/orgs/:id/keys", async (req, reply) => {
    requireAdmin(config.adminTokenHash, req);
    const { id } = req.params as { id: string };
    const body = mintKeySchema.parse(req.body ?? {});
    const org = requireOrg(db, id);
    return reply.status(201).send(mintOrgMember(db, config, org, body.name, body.role));
  });

  app.put("/api/v1/admin/users/:id/org", async (req, reply) => {
    requireAdmin(config.adminTokenHash, req);
    const { id } = req.params as { id: string };
    const body = setUserOrgSchema.parse(req.body ?? {});
    const user = getUser(db, id);
    if (user === null) throw new HttpError(404, "not_found", "user not found");
    const org = body.orgId === null ? null : getOrg(db, body.orgId);
    if (body.orgId !== null && org === null) {
      throw new HttpError(400, "unknown_org", "unknown organization");
    }
    // Guards apply to an attach only; detaching an ops user is a harmless no-op.
    if (org !== null) {
      if (user.tier === "ops") {
        throw new HttpError(400, "invalid_tier", "operator accounts do not join organizations");
      }
      if (user.org_id !== null && user.org_id !== org.id) {
        throw new HttpError(
          409,
          "already_in_org",
          "user belongs to another organization; detach first",
        );
      }
    }
    const role = org === null ? null : body.role;
    const result = setUserOrg(db, user, org, role, Date.now());
    return reply.send({
      userId: user.id,
      orgId: org === null ? null : org.id,
      role,
      tier: user.tier,
      effectiveTier: result.effectiveTier,
      clampedSites: result.clampedSites,
    });
  });
}
