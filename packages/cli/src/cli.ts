#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync, statSync } from "node:fs";
import { loadCliConfig, requireConfig, saveCliConfig } from "./config.js";
import {
  ApiError,
  createKey,
  createSite,
  deleteSite,
  getSite,
  listKeys,
  listSites,
  revokeKey,
  updateSite,
} from "./api.js";
import { collectDirectory, collectSingleFile } from "./bundle.js";
import type { CreateSiteRequest, SiteFileInput, Visibility } from "@shareplan/core";

/** Mirrors the server's visibility enum (createSiteSchema in @shareplan/server). */
const VISIBILITIES = ["public", "unlisted", "private"] as const satisfies readonly Visibility[];

const program = new Command();

program
  .name("shareplan")
  .description("Publish small HTML sites and media to shareplan")
  .version("0.1.0");

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
  .description("Show current config (token redacted)")
  .action(() => {
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
  });

program
  .command("publish")
  .description("Publish a directory or file as a microsite")
  .argument("<path>", "directory or file to publish")
  .option("--title <title>", "site title")
  .option("--ttl <ttl>", "expiry (e.g. 7d, 12h)")
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
        const title = s.title ? `  ${s.title}` : "";
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
      console.error(`id=${key.id} name=${key.name}`);
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
        console.log(`${k.id}  ${k.name}  ${state}`);
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
    ttl: opts.ttl,
    note: opts.note,
    slug: opts.slug,
  };

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

function isVisibility(value: string): value is Visibility {
  return (VISIBILITIES as readonly string[]).includes(value);
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
