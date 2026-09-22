#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { realpathSync, statSync } from "node:fs";
import { loadCliConfig, requireConfig, saveCliConfig } from "./config.js";
import {
  ApiError,
  createKey,
  createOrg,
  createOrgKey,
  createOrgKeyAdmin,
  createSite,
  deleteOrg,
  deleteSite,
  getMe,
  getOrg,
  getSite,
  joinOrg,
  listKeys,
  listOrgMembers,
  listOrgSites,
  listOrgs,
  listSites,
  registerAccount,
  removeOrgMember,
  revokeKey,
  revokeOrgKey,
  rotateOrgJoinToken,
  rotateOrgJoinTokenAdmin,
  setOrgMemberRole,
  setUserOrg,
  touchSite,
  updateOrg,
  updateSite,
  type ClampCounts,
  type MintedKey,
  type OrgAdmin,
  type OrgMember,
  type OrgRole,
  type OrgTier,
  type RegisterResponse,
  type RemovedMember,
  type UpdateOrgBody,
} from "./api.js";
import { collectDirectory, collectSingleFile } from "./bundle.js";
import type { CreateSiteRequest, SiteFileInput, Visibility } from "@shareplan/core";

/** Mirrors the server's visibility enum (createSiteSchema in @shareplan/server). */
const VISIBILITIES = ["public", "unlisted", "private"] as const satisfies readonly Visibility[];
/** Mirrors the server's roleSchema and ORG_TIERS (@shareplan/server). */
const ORG_ROLES = ["admin", "member"] as const satisfies readonly OrgRole[];
const ORG_TIERS = ["free--", "free-", "free", "unlock", "paid"] as const satisfies readonly OrgTier[];

const program = new Command();

program
  .name("shareplan")
  .description("Publish small HTML sites and media to shareplan")
  .version("0.1.0");

program
  .command("register")
  .description("Create a free-- agent account and save the token")
  .requiredOption("--url <url>", "shareplan base URL")
  .option("--name <name>", "key name", "default")
  .option(
    "--org-token <token>",
    "organization join token (org_...); falls back to SHAREPLAN_ORG_TOKEN, never saved",
  )
  .action(async (opts: { url: string; name: string; orgToken?: string }) => {
    const url = opts.url.replace(/\/$/, "");
    try {
      const orgToken = resolveOrgToken(opts.orgToken, process.env.SHAREPLAN_ORG_TOKEN);
      const created = await registerAccount(url, opts.name, orgToken);
      saveCliConfig({ url, token: created.token });
      console.log(created.token);
      console.error(registerLine(created));
      console.error(`claim=${created.claimUrl}`);
      console.error("Save this token; it will not be shown again.");
    } catch (e) {
      fail(e);
    }
  });

program
  .command("login")
  .description("Save server URL and API token")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--token <token>", "API token (sp_...)")
  .action((opts: { url: string; token: string }) => {
    const url = opts.url.replace(/\/$/, "");
    saveCliConfig({ url, token: opts.token });
    console.log(`Saved config for ${url}`);
  });

program
  .command("whoami")
  .description("Show current config (token redacted) and the account behind it")
  .action(async () => {
    const cfg = loadCliConfig();
    if (!cfg.url && !cfg.token) {
      console.log("Not configured.");
      return;
    }
    const token = cfg.token
      ? `${cfg.token.slice(0, 6)}…${cfg.token.slice(-4)}`
      : "(none)";
    console.log(`url:   ${cfg.url ?? "(none)"}`);
    console.log(`token: ${token}`);
    if (!cfg.url || !cfg.token) return;
    try {
      const me = await getMe({ url: cfg.url, token: cfg.token });
      console.log(
        `user:  ${me.userId} tier=${me.tier} effective=${me.effectiveTier} claimed=${me.claimed ? "yes" : "no"}`,
      );
      console.log(
        me.org
          ? `org:   ${printable(me.org.name)} (${me.org.id}) tier=${dash(me.org.tier)} role=${me.org.role}`
          : "org:   (none)",
      );
    } catch (e) {
      console.log(`remote: unavailable (${errorCode(e)})`);
    }
  });

program
  .command("publish")
  .description("Publish a directory or file as a microsite")
  .argument("<path>", "directory or file to publish")
  .option("--title <title>", "site title")
  .option("--ttl <ttl>", "expiry (e.g. 7d, 12h) or none for no expiry (paid, ops, or a paid organization)")
  .option("--site <id>", "update existing site id (new version)")
  .option("--visibility <vis>", "public | unlisted | private (default: unlisted on create, unchanged on update)")
  .option("--note <note>", "version note")
  .option("--slug <slug>", "optional vanity slug (renames the site on update)")
  .action(async (pathArg: string, opts: PublishOptions) => {
    const cfg = requireConfig();
    let st;
    try {
      st = statSync(pathArg);
    } catch {
      console.error(`path not found: ${pathArg}`);
      process.exit(1);
    }

    const files = st.isDirectory()
      ? collectDirectory(pathArg)
      : collectSingleFile(pathArg);

    try {
      const body = buildPublishBody(files, opts);
      const site = opts.site
        ? await updateSite(cfg, opts.site, body)
        : await createSite(cfg, body);
      console.log(site.url);
      console.error(`id=${site.id} version=${site.versionId} files=${site.fileCount} bytes=${site.byteSize}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("ls")
  .description("List your sites")
  .action(async () => {
    const cfg = requireConfig();
    try {
      const { sites } = await listSites(cfg);
      if (sites.length === 0) {
        console.log("(no sites)");
        return;
      }
      for (const s of sites) {
        const title = s.title ? `  ${printable(s.title)}` : "";
        console.log(`${s.id}${title}\n  ${s.url}`);
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("info")
  .description("Show site metadata")
  .argument("<id>", "site id")
  .action(async (id: string) => {
    const cfg = requireConfig();
    try {
      const site = await getSite(cfg, id);
      console.log(JSON.stringify(site, null, 2));
    } catch (e) {
      fail(e);
    }
  });

program
  .command("touch")
  .description("Reset a site's TTL to this tier's maximum")
  .argument("<id>", "site id")
  .action(async (id: string) => {
    const cfg = requireConfig();
    try {
      const site = await touchSite(cfg, id);
      console.log(site.url);
      console.error(`id=${site.id} expires=${site.expiresAt ?? "never"}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("rm")
  .description("Delete a site")
  .argument("<id>", "site id")
  .action(async (id: string) => {
    const cfg = requireConfig();
    try {
      await deleteSite(cfg, id);
      console.log(`deleted ${id}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("create-key")
  .description("Mint an API key (requires admin token)")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .option("--name <name>", "key name", "default")
  .action(async (opts: { url: string; adminToken: string; name: string }) => {
    try {
      const key = await createKey(opts.url, opts.adminToken, opts.name);
      console.log(key.token);
      console.error(`id=${key.id} name=${printable(key.name)}`);
      console.error("Save this token; it will not be shown again.");
    } catch (e) {
      fail(e);
    }
  });

program
  .command("list-keys")
  .description("List API keys (requires admin token)")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .action(async (opts: { url: string; adminToken: string }) => {
    try {
      const { keys } = await listKeys(opts.url, opts.adminToken);
      if (keys.length === 0) {
        console.log("(no keys)");
        return;
      }
      for (const k of keys) {
        const state = k.revokedAt ? `revoked ${k.revokedAt}` : "active";
        console.log(`${k.id}  ${printable(k.name)}  ${state}  user=${k.userId} org=${dash(k.orgId)}`);
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("revoke-key")
  .description("Revoke an API key by id (requires admin token)")
  .argument("<id>", "key id")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .action(async (id: string, opts: { url: string; adminToken: string }) => {
    try {
      await revokeKey(opts.url, opts.adminToken, id);
      console.log(`revoked ${id}`);
    } catch (e) {
      fail(e);
    }
  });

// Org commands: member and org-admin actions on the saved sp_ config.

const org = program
  .command("org")
  .description("Organization commands for members and org admins (uses the saved token)");

org
  .command("show")
  .description("Show the organization this account belongs to")
  .action(async () => {
    const cfg = requireConfig();
    try {
      const me = await getMe(cfg);
      if (!me.org) {
        throw new ApiError(404, "no_org", "this account is not in an organization");
      }
      console.log(
        `${printable(me.org.name)} (${me.org.id}) tier=${dash(me.org.tier)} role=${me.org.role} effective=${me.effectiveTier}`,
      );
    } catch (e) {
      fail(e);
    }
  });

org
  .command("join")
  .description("Join an organization with a join token (existing sites come along)")
  .option("--org-token <token>", "organization join token (org_...); falls back to SHAREPLAN_ORG_TOKEN")
  .action(async (opts: { orgToken?: string }) => {
    const cfg = requireConfig();
    try {
      const orgToken = resolveOrgToken(opts.orgToken, process.env.SHAREPLAN_ORG_TOKEN);
      if (!orgToken) {
        throw new Error("missing --org-token (or set SHAREPLAN_ORG_TOKEN)");
      }
      const joined = await joinOrg(cfg, orgToken);
      console.log(`joined ${printable(joined.org.name)} (effective tier ${joined.effectiveTier})`);
    } catch (e) {
      fail(e);
    }
  });

org
  .command("members")
  .description("List organization members (org admin)")
  .action(async () => {
    const cfg = requireConfig();
    try {
      const { members } = await listOrgMembers(cfg);
      if (members.length === 0) {
        console.log("(no members)");
        return;
      }
      for (const line of memberLines(members)) console.log(line);
    } catch (e) {
      fail(e);
    }
  });

org
  .command("key")
  .description("Mint a key for a new member without sharing the join token (org admin)")
  .option("--name <name>", "key name", "default")
  .option("--role <role>", "admin | member", parseOrgRole, "member")
  .action(async (opts: { name: string; role: OrgRole }) => {
    const cfg = requireConfig();
    try {
      const minted = await createOrgKey(cfg, opts.name, opts.role);
      printMinted(minted);
    } catch (e) {
      fail(e);
    }
  });

org
  .command("set-role")
  .description("Change a member's role (org admin)")
  .argument("<userId>", "member user id")
  .argument("<role>", "admin | member", parseOrgRole)
  .action(async (userId: string, role: OrgRole) => {
    const cfg = requireConfig();
    try {
      const member = await setOrgMemberRole(cfg, userId, role);
      console.log(`updated ${member.userId} role=${member.role}`);
    } catch (e) {
      fail(e);
    }
  });

org
  .command("remove")
  .description("Remove a member; their sites are clamped to their own tier (org admin)")
  .argument("<userId>", "member user id")
  .option("--revoke-keys", "also revoke the member's active keys (in the same request)")
  .action(async (userId: string, opts: { revokeKeys?: boolean }) => {
    const cfg = requireConfig();
    try {
      const result = await removeOrgMember(cfg, userId, opts.revokeKeys === true);
      console.log(removedLine(result));
    } catch (e) {
      fail(e);
    }
  });

org
  .command("revoke-key")
  .description("Revoke a member's API key by id (org admin)")
  .argument("<keyId>", "key id")
  .action(async (keyId: string) => {
    const cfg = requireConfig();
    try {
      await revokeOrgKey(cfg, keyId);
      console.log(`revoked ${keyId}`);
    } catch (e) {
      fail(e);
    }
  });

org
  .command("rotate-token")
  .description("Issue a new join token, or disable joining (org admin)")
  .option("--disable", "disable joining instead of issuing a new token")
  .action(async (opts: { disable?: boolean }) => {
    const cfg = requireConfig();
    try {
      const { joinToken } = await rotateOrgJoinToken(cfg, opts.disable === true);
      printJoinToken(joinToken);
    } catch (e) {
      fail(e);
    }
  });

org
  .command("sites")
  .description("List every member's sites (org admin, read-only)")
  .action(async () => {
    const cfg = requireConfig();
    try {
      const { sites } = await listOrgSites(cfg);
      if (sites.length === 0) {
        console.log("(no sites)");
        return;
      }
      for (const s of sites) {
        const title = s.title ? `  ${printable(s.title)}` : "";
        console.log(`${s.id}${title}\n  ${s.url}  owner=${s.ownerUserId}`);
      }
    } catch (e) {
      fail(e);
    }
  });

// Operator commands: flat verbs that take --url and --admin-token.

interface AdminOptions {
  url: string;
  adminToken: string;
}

program
  .command("create-org")
  .description("Create an organization and print its join token (requires admin token)")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .requiredOption("--name <name>", "organization name")
  .option("--tier <tier>", `comp tier: ${ORG_TIERS.join(" | ")}`, parseOrgTier)
  .option("--max-members <n>", "member cap (default 100)", parsePositiveInt)
  .option("--publish-per-hour <n>", "pooled publish limit per hour (default: tier's limit)", parsePositiveInt)
  .action(
    async (
      opts: AdminOptions & {
        name: string;
        tier?: OrgTier;
        maxMembers?: number;
        publishPerHour?: number;
      },
    ) => {
      try {
        const created = await createOrg(opts.url, opts.adminToken, {
          name: opts.name,
          ...(opts.tier !== undefined ? { compTier: opts.tier } : {}),
          ...(opts.maxMembers !== undefined ? { maxMembers: opts.maxMembers } : {}),
          ...(opts.publishPerHour !== undefined ? { publishPerHour: opts.publishPerHour } : {}),
        });
        const o = created.org;
        console.log(created.joinToken);
        console.error(
          `id=${o.id} name=${printable(o.name)} tier=${dash(o.tier)} members=${o.memberCount}/${o.maxMembers} pool=${poolText(o)}`,
        );
        console.error(
          "Save this join token; it will not be shown again. Anyone holding it can register keys under this organization.",
        );
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command("list-orgs")
  .description("List organizations (requires admin token)")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .action(async (opts: AdminOptions) => {
    try {
      const { orgs } = await listOrgs(opts.url, opts.adminToken);
      if (orgs.length === 0) {
        console.log("(no organizations)");
        return;
      }
      const rows = orgs.map((o) => orgRow(o, o.siteCount, o.permanentSites));
      for (const line of table(rows)) console.log(line);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("show-org")
  .description("Show an organization and its members (requires admin token)")
  .argument("<org-id>", "organization id")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .action(async (orgId: string, opts: AdminOptions) => {
    try {
      const detail = await getOrg(opts.url, opts.adminToken, orgId);
      console.log(orgRow(detail.org, detail.siteCount, detail.permanentSites).join("  "));
      for (const line of memberLines(detail.members)) console.log(line);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("set-org")
  .description("Update an organization; lowering the tier clamps member sites (requires admin token)")
  .argument("<org-id>", "organization id")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .option("--tier <tier>", `comp tier: ${ORG_TIERS.join(" | ")} | none`, parseOrgTierOrNone)
  .option("--name <name>", "organization name")
  .option("--max-members <n>", "member cap", parsePositiveInt)
  .option("--publish-per-hour <n>", "pooled publish limit per hour, or none for the tier's limit", parsePositiveIntOrNone)
  .action(
    async (
      orgId: string,
      opts: AdminOptions & {
        tier?: OrgTier | "none";
        name?: string;
        maxMembers?: number;
        publishPerHour?: number | "none";
      },
    ) => {
      try {
        const patch: UpdateOrgBody = {};
        if (opts.tier !== undefined) patch.compTier = noneToNull(opts.tier);
        if (opts.name !== undefined) patch.name = opts.name;
        if (opts.maxMembers !== undefined) patch.maxMembers = opts.maxMembers;
        if (opts.publishPerHour !== undefined) patch.publishPerHour = noneToNull(opts.publishPerHour);
        if (Object.keys(patch).length === 0) {
          throw new Error("nothing to update: pass --tier, --name, --max-members, or --publish-per-hour");
        }
        const updated = await updateOrg(opts.url, opts.adminToken, orgId, patch);
        const { clamped } = updated;
        const skipped = clamped.skipped > 0 ? ` skipped=${clamped.skipped}` : "";
        console.log(
          `updated ${updated.org.id} tier=${dash(updated.org.tier)} clamped=${clamped.sites}${skipped}`,
        );
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command("delete-org")
  .description("Delete an organization; members are detached and clamped (requires admin token)")
  .argument("<org-id>", "organization id")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .action(async (orgId: string, opts: AdminOptions) => {
    try {
      const { clamped } = await deleteOrg(opts.url, opts.adminToken, orgId);
      console.log(deletedLine(orgId, clamped));
    } catch (e) {
      fail(e);
    }
  });

program
  .command("rotate-org-token")
  .description("Issue a new join token for an organization, or disable joining (requires admin token)")
  .argument("<org-id>", "organization id")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .option("--disable", "disable joining instead of issuing a new token")
  .action(async (orgId: string, opts: AdminOptions & { disable?: boolean }) => {
    try {
      const { joinToken } = await rotateOrgJoinTokenAdmin(
        opts.url,
        opts.adminToken,
        orgId,
        opts.disable === true,
      );
      printJoinToken(joinToken);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("create-org-key")
  .description("Mint a key for a new member of an organization (requires admin token)")
  .argument("<org-id>", "organization id")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .option("--name <name>", "key name", "default")
  .option("--role <role>", "admin | member", parseOrgRole, "member")
  .action(async (orgId: string, opts: AdminOptions & { name: string; role: OrgRole }) => {
    try {
      const minted = await createOrgKeyAdmin(opts.url, opts.adminToken, orgId, opts.name, opts.role);
      printMinted(minted);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("set-user-org")
  .description("Attach a user to an organization, change their role, or detach with --org none (requires admin token)")
  .argument("<user-id>", "user id")
  .requiredOption("--url <url>", "shareplan base URL")
  .requiredOption("--admin-token <token>", "admin token")
  .requiredOption("--org <org-id>", "organization id, or none to detach")
  .option("--role <role>", "admin | member (omitted keeps the current role)", parseOrgRole)
  .action(async (userId: string, opts: AdminOptions & { org: string; role?: OrgRole }) => {
    try {
      const orgId = opts.org === "none" ? null : opts.org;
      const result = await setUserOrg(opts.url, opts.adminToken, userId, orgId, opts.role);
      console.log(
        `${result.userId} org=${dash(result.orgId)} role=${dash(result.role)} effective=${result.effectiveTier} clamped=${result.clampedSites}`,
      );
    } catch (e) {
      fail(e);
    }
  });

export interface PublishOptions {
  title?: string;
  ttl?: string;
  site?: string;
  visibility?: string;
  note?: string;
  slug?: string;
}

export function buildPublishBody(
  files: SiteFileInput[],
  opts: PublishOptions,
): CreateSiteRequest {
  const body: CreateSiteRequest = {
    files,
    title: opts.title,
    note: opts.note,
    slug: opts.slug,
  };

  // "none" asks for no expiry, which the API spells as ttl: null.
  if (opts.ttl !== undefined) {
    body.ttl = opts.ttl === "none" ? null : opts.ttl;
  }

  // Only send a visibility the user actually asked for: the server defaults new sites to
  // "unlisted" and keeps the existing value on update, so a client-side default would
  // silently re-scope an already-published site (public -> unlisted, private -> unlisted).
  if (opts.visibility !== undefined) {
    if (!isVisibility(opts.visibility)) {
      throw new Error(
        `invalid --visibility "${opts.visibility}" (expected ${VISIBILITIES.join(" | ")})`,
      );
    }
    body.visibility = opts.visibility;
  }

  return body;
}

/** The flag wins over SHAREPLAN_ORG_TOKEN; an empty value counts as unset. */
export function resolveOrgToken(
  flag: string | undefined,
  env: string | undefined,
): string | undefined {
  if (flag) return flag;
  if (env) return env;
  return undefined;
}

function isVisibility(value: string): value is Visibility {
  return (VISIBILITIES as readonly string[]).includes(value);
}

function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

function isOrgTier(value: string): value is OrgTier {
  return (ORG_TIERS as readonly string[]).includes(value);
}

function parseOrgRole(value: string): OrgRole {
  if (!isOrgRole(value)) {
    throw new InvalidArgumentError(`expected ${ORG_ROLES.join(" | ")}`);
  }
  return value;
}

function parseOrgTier(value: string): OrgTier {
  if (!isOrgTier(value)) {
    throw new InvalidArgumentError(`expected ${ORG_TIERS.join(" | ")}`);
  }
  return value;
}

// Parsers return the "none" sentinel rather than null: commander turns a null parser result into "".
function parseOrgTierOrNone(value: string): OrgTier | "none" {
  return value === "none" ? value : parseOrgTier(value);
}

function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return Number(value);
}

function parsePositiveIntOrNone(value: string): number | "none" {
  return value === "none" ? value : parsePositiveInt(value);
}

function noneToNull<T>(value: T | "none"): T | null {
  return value === "none" ? null : value;
}

function dash(value: string | null | undefined): string {
  return value ?? "-";
}

function plural(count: number, noun: string, prefix?: string): string {
  const text = `${count} ${noun}${count === 1 ? "" : "s"}`;
  return prefix ? `${prefix} ${text}` : text;
}

function errorCode(e: unknown): string {
  if (e instanceof ApiError) return e.code;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Server-supplied free text (key names, site titles, org names) is chosen by other
 * principals, so control characters are replaced before it reaches the terminal.
 * Covers C0 (including ESC), DEL and C1.
 */
export function printable(s: string): string {
  return s.replace(/\p{Cc}/gu, "�");
}

export function removedLine(result: RemovedMember): string {
  const parts = [
    plural(result.clampedSites, "site", "clamped"),
    plural(result.revokedKeys, "key", "revoked"),
  ];
  return `removed ${result.userId} (${parts.join(", ")})`;
}

/** Every member is detached, including those skipped for an unknown own tier. */
export function deletedLine(orgId: string, clamped: ClampCounts): string {
  const parts = [
    plural(clamped.users + clamped.skipped, "user", "detached"),
    plural(clamped.sites, "site", "clamped"),
  ];
  if (clamped.skipped > 0) parts.push(plural(clamped.skipped, "user", "skipped"));
  return `deleted ${orgId} (${parts.join(", ")})`;
}

function registerLine(created: RegisterResponse): string {
  const orgPart = created.org ? ` org=${printable(created.org.name)}` : "";
  return `id=${created.keyId} user=${created.userId} tier=${created.tier} effective=${created.effectiveTier}${orgPart}`;
}

function printMinted(minted: MintedKey): void {
  console.log(minted.token);
  console.error(
    `id=${minted.keyId} user=${minted.userId} org=${printable(minted.org.name)} role=${minted.org.role} effective=${minted.effectiveTier}`,
  );
  console.error(`claim=${minted.claimUrl}`);
  console.error("Save this token; it will not be shown again.");
}

function printJoinToken(joinToken: string | null): void {
  if (joinToken === null) {
    console.log("joining disabled");
    return;
  }
  console.log(joinToken);
  console.error("rotated; the previous token no longer works");
}

function poolText(org: OrgAdmin): string {
  return org.publishPerHour === null ? "-" : `${org.publishPerHour}/h`;
}

function orgRow(org: OrgAdmin, siteCount: number, permanentSites: number): string[] {
  return [
    org.id,
    printable(org.name),
    dash(org.tier),
    `comp=${dash(org.compTier)} billing=${dash(org.billingTier)}`,
    `members=${org.memberCount}/${org.maxMembers}`,
    `sites=${siteCount}`,
    `permanent=${permanentSites}`,
    `join=${org.joinEnabled ? "on" : "off"}`,
  ];
}

/** `free->paid`, but `free-- ->paid` so a trailing minus never runs into the arrow. */
function tierArrow(tier: string, effective: string): string {
  return `${tier}${tier.endsWith("-") ? " " : ""}->${effective}`;
}

function memberLines(members: OrgMember[]): string[] {
  const rows = members.map((m) => [
    m.userId,
    m.role,
    tierArrow(m.tier, m.effectiveTier),
    m.email === null ? "unclaimed" : printable(m.email),
    `keys=${m.keys.length === 0 ? "-" : m.keys.map((k) => `${printable(k.name)}(${k.id})`).join(",")}`,
    `sites=${m.sites}`,
  ]);
  return table(rows);
}

/** Pads every column but the last to its widest cell; cells are joined by two spaces. */
function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  "),
  );
}

function fail(e: unknown): never {
  if (e instanceof ApiError) {
    console.error(`error: ${e.code}: ${e.message}`);
    process.exit(1);
  }
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

/**
 * Importing this module (tests) must not consume argv; only the real entrypoint
 * parses. Both sides are resolved because either can be a symlink: argv[1] is
 * the bin symlink when installed, and under --preserve-symlinks-main
 * import.meta.filename is that same unresolved symlink path.
 */
export function isCliEntrypoint(entry: string | undefined, moduleFile: string): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(moduleFile);
  } catch {
    return false;
  }
}

if (isCliEntrypoint(process.argv[1], import.meta.filename)) {
  program.parseAsync(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
