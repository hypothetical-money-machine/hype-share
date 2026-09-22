import type { CreateSiteRequest, SiteListItem, SiteResponse } from "@shareplan/core";
import type { CliConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  cfg: CliConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { code: "invalid_json", message: text.slice(0, 200) } };
    }
  }

  if (!res.ok) {
    const err = data as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      res.status,
      err?.error?.code ?? "http_error",
      err?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return data as T;
}

export function createSite(cfg: CliConfig, body: CreateSiteRequest): Promise<SiteResponse> {
  return request(cfg, "POST", "/api/v1/sites", body);
}

export function updateSite(
  cfg: CliConfig,
  id: string,
  body: CreateSiteRequest,
): Promise<SiteResponse> {
  return request(cfg, "PUT", `/api/v1/sites/${encodeURIComponent(id)}`, body);
}

export function listSites(cfg: CliConfig): Promise<{ sites: SiteListItem[] }> {
  return request(cfg, "GET", "/api/v1/sites");
}

export function getSite(cfg: CliConfig, id: string): Promise<SiteResponse> {
  return request(cfg, "GET", `/api/v1/sites/${encodeURIComponent(id)}`);
}

export function deleteSite(cfg: CliConfig, id: string): Promise<void> {
  return request(cfg, "DELETE", `/api/v1/sites/${encodeURIComponent(id)}`);
}

/** Mirrors the server's OrgRole and OrgTier (tiers.ts in @shareplan/server). */
export type OrgRole = "admin" | "member";
export type OrgTier = "free--" | "free-" | "free" | "unlock" | "paid";

export interface OrgPublic {
  id: string;
  name: string;
  tier: string | null;
}

export interface OrgMembership extends OrgPublic {
  role: string;
}

export interface OrgAdmin extends OrgPublic {
  compTier: string | null;
  billingTier: string | null;
  stripeCustomerId: string | null;
  maxMembers: number;
  memberCount: number;
  /** Effective pooled publish limit; null when the org holds no tier. */
  publishPerHour: number | null;
  joinEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrgAdminSummary extends OrgAdmin {
  siteCount: number;
  permanentSites: number;
}

export interface OrgMember {
  userId: string;
  role: string;
  tier: string;
  effectiveTier: string;
  email: string | null;
  claimedAt: string | null;
  createdAt: string;
  keys: { id: string; name: string; createdAt: string }[];
  sites: number;
}

/** The register shape plus the org fields; returned by every key mint. */
export interface RegisterResponse {
  userId: string;
  keyId: string;
  name: string;
  token: string;
  tier: string;
  effectiveTier: string;
  org: OrgMembership | null;
  claimUrl: string;
  createdAt: string;
}

export interface MintedKey extends RegisterResponse {
  org: OrgMembership;
}

export interface MeResponse {
  userId: string;
  tier: string;
  effectiveTier: string;
  email: string | null;
  claimed: boolean;
  key: { id: string; name: string };
  org: OrgMembership | null;
}

export interface OrgSiteListItem extends SiteListItem {
  ownerUserId: string;
}

export interface ClampCounts {
  users: number;
  sites: number;
  /** Members whose own tier the server did not recognise; their sites were left alone. */
  skipped: number;
}

export function registerAccount(
  baseUrl: string,
  name = "default",
  orgToken?: string,
): Promise<RegisterResponse> {
  return request(
    { url: baseUrl.replace(/\/$/, ""), token: "" },
    "POST",
    "/api/v1/register",
    { name, ...(orgToken ? { orgToken } : {}) },
  );
}

export function touchSite(cfg: CliConfig, id: string): Promise<SiteResponse> {
  return request(cfg, "POST", `/api/v1/sites/${encodeURIComponent(id)}/touch`);
}

export function getMe(cfg: CliConfig): Promise<MeResponse> {
  return request(cfg, "GET", "/api/v1/me");
}

export function joinOrg(
  cfg: CliConfig,
  orgToken: string,
): Promise<{ org: OrgPublic; role: string; tier: string; effectiveTier: string }> {
  return request(cfg, "POST", "/api/v1/org/join", { orgToken });
}

export function listOrgMembers(
  cfg: CliConfig,
): Promise<{ org: OrgPublic; members: OrgMember[] }> {
  return request(cfg, "GET", "/api/v1/org/members");
}

export function createOrgKey(
  cfg: CliConfig,
  name: string,
  role: OrgRole,
): Promise<MintedKey> {
  return request(cfg, "POST", "/api/v1/org/keys", { name, role });
}

export function setOrgMemberRole(
  cfg: CliConfig,
  userId: string,
  role: OrgRole,
): Promise<OrgMember> {
  return request(cfg, "PUT", `/api/v1/org/members/${encodeURIComponent(userId)}`, { role });
}

export interface RemovedMember {
  userId: string;
  clampedSites: number;
  revokedKeys: number;
}

/** One request: the server detaches, clamps, and (when asked) revokes the member's keys last. */
export function removeOrgMember(
  cfg: CliConfig,
  userId: string,
  revokeKeys: boolean,
): Promise<RemovedMember> {
  const query = revokeKeys ? "?revokeKeys=true" : "";
  return request(cfg, "DELETE", `/api/v1/org/members/${encodeURIComponent(userId)}${query}`);
}

export function revokeOrgKey(cfg: CliConfig, keyId: string): Promise<void> {
  return request(cfg, "DELETE", `/api/v1/org/keys/${encodeURIComponent(keyId)}`);
}

export function rotateOrgJoinToken(
  cfg: CliConfig,
  disable = false,
): Promise<{ joinToken: string | null }> {
  return request(cfg, "POST", "/api/v1/org/join-token", { disable });
}

export function listOrgSites(cfg: CliConfig): Promise<{ sites: OrgSiteListItem[] }> {
  return request(cfg, "GET", "/api/v1/org/sites");
}

export interface AdminKeyInfo {
  id: string;
  name: string;
  userId: string;
  orgId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

function adminCfg(baseUrl: string, adminToken: string): CliConfig {
  return { url: baseUrl.replace(/\/$/, ""), token: adminToken };
}

export function createKey(
  baseUrl: string,
  adminToken: string,
  name: string,
): Promise<{ id: string; name: string; token: string; createdAt: string }> {
  return request(adminCfg(baseUrl, adminToken), "POST", "/api/v1/admin/keys", {
    name,
  });
}

export function listKeys(
  baseUrl: string,
  adminToken: string,
): Promise<{ keys: AdminKeyInfo[] }> {
  return request(adminCfg(baseUrl, adminToken), "GET", "/api/v1/admin/keys");
}

export function revokeKey(
  baseUrl: string,
  adminToken: string,
  id: string,
): Promise<void> {
  return request(
    adminCfg(baseUrl, adminToken),
    "DELETE",
    `/api/v1/admin/keys/${encodeURIComponent(id)}`,
  );
}

export interface CreateOrgBody {
  name: string;
  compTier?: OrgTier | null;
  maxMembers?: number;
  publishPerHour?: number | null;
}

export interface UpdateOrgBody {
  name?: string;
  compTier?: OrgTier | null;
  maxMembers?: number;
  publishPerHour?: number | null;
}

export function createOrg(
  baseUrl: string,
  adminToken: string,
  body: CreateOrgBody,
): Promise<{ org: OrgAdmin; joinToken: string }> {
  return request(adminCfg(baseUrl, adminToken), "POST", "/api/v1/admin/orgs", body);
}

export function listOrgs(
  baseUrl: string,
  adminToken: string,
): Promise<{ orgs: OrgAdminSummary[] }> {
  return request(adminCfg(baseUrl, adminToken), "GET", "/api/v1/admin/orgs");
}

export function getOrg(
  baseUrl: string,
  adminToken: string,
  id: string,
): Promise<{ org: OrgAdmin; members: OrgMember[]; siteCount: number; permanentSites: number }> {
  return request(
    adminCfg(baseUrl, adminToken),
    "GET",
    `/api/v1/admin/orgs/${encodeURIComponent(id)}`,
  );
}

export function updateOrg(
  baseUrl: string,
  adminToken: string,
  id: string,
  patch: UpdateOrgBody,
): Promise<{ org: OrgAdmin; clamped: ClampCounts }> {
  return request(
    adminCfg(baseUrl, adminToken),
    "PUT",
    `/api/v1/admin/orgs/${encodeURIComponent(id)}`,
    patch,
  );
}

export function deleteOrg(
  baseUrl: string,
  adminToken: string,
  id: string,
): Promise<{ clamped: ClampCounts }> {
  return request(
    adminCfg(baseUrl, adminToken),
    "DELETE",
    `/api/v1/admin/orgs/${encodeURIComponent(id)}`,
  );
}

export function rotateOrgJoinTokenAdmin(
  baseUrl: string,
  adminToken: string,
  id: string,
  disable = false,
): Promise<{ joinToken: string | null }> {
  return request(
    adminCfg(baseUrl, adminToken),
    "POST",
    `/api/v1/admin/orgs/${encodeURIComponent(id)}/join-token`,
    { disable },
  );
}

export function createOrgKeyAdmin(
  baseUrl: string,
  adminToken: string,
  id: string,
  name: string,
  role: OrgRole,
): Promise<MintedKey> {
  return request(
    adminCfg(baseUrl, adminToken),
    "POST",
    `/api/v1/admin/orgs/${encodeURIComponent(id)}/keys`,
    { name, role },
  );
}

export function setUserOrg(
  baseUrl: string,
  adminToken: string,
  userId: string,
  orgId: string | null,
  role?: OrgRole,
): Promise<{
  userId: string;
  orgId: string | null;
  role: string | null;
  tier: string;
  effectiveTier: string;
  clampedSites: number;
}> {
  return request(
    adminCfg(baseUrl, adminToken),
    "PUT",
    `/api/v1/admin/users/${encodeURIComponent(userId)}/org`,
    { orgId, role },
  );
}
