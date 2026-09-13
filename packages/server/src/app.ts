import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  createApiKey,
  createSiteId,
  createVersionId,
  contentTypeForPath,
  HOST_LABEL_RE,
  isHostLabel,
  isHtmlPath,
  s3ObjectKey,
  sanitizeSitePath,
  type SiteResponse,
  type SiteListItem,
  type Visibility,
} from "@shareplan/core";
import type { Config } from "./config.js";
import { randomBytes } from "node:crypto";
import {
  createApiKeyRecord,
  createUser,
  deleteSite,
  getSite,
  getSiteByIdOrSlug,
  getSiteBySlug,
  insertSite,
  insertVersion,
  isExpired,
  listApiKeys,
  listPrunableVersions,
  listSitesForUser,
  markVersionPruned,
  revokeApiKey,
  updateSiteExpiry,
  updateSiteSlug,
  updateSiteVersion,
  type ApiKeyRow,
  type SiteRow,
  type UserRow,
} from "./db.js";
import { AuthError, requireAccount, requireAdmin } from "./auth.js";
import { HttpError } from "./errors.js";
import { hashIp, requestIp } from "./ip.js";
import { consumeRate, DAY_MS, HOUR_MS } from "./rate-limit.js";
import {
  policyFor,
  resolveTierExpiry,
  TtlPolicyError,
} from "./tiers.js";
import { FileError, ensureIndexHtml, prepareFiles } from "./files.js";
import {
  deleteSiteObjects,
  deleteVersionObjects,
  getObject,
  putSiteFiles,
} from "./storage.js";

const fileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().optional(),
  contentBase64: z.string().optional(),
});

const createSiteSchema = z.object({
  title: z.string().max(200).optional(),
  // A slug is a hostname label under hostname serving, so it follows the
  // label rule in every mode: the rule must not change when a suffix is set.
  slug: z
    .string()
    .regex(HOST_LABEL_RE, "slug must be a lowercase hostname label (a-z, 0-9, hyphens)")
    .optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  ttl: z.union([z.string(), z.number(), z.null()]).optional(),
  note: z.string().max(500).optional(),
  files: z.array(fileInputSchema).min(1),
});

const updateSiteSchema = createSiteSchema.partial().extend({
  files: z.array(fileInputSchema).min(1),
});

const createKeySchema = z.object({
  name: z.string().min(1).max(100).default("default"),
});

/**
 * Fastify's transport errors carry a usable status and a safe message, but
 * their codes are FST_ERR_*; map the ones a client can actually trigger onto
 * the snake_case vocabulary the rest of the API returns.
 */
const TRANSPORT_ERROR_CODES: Record<string, string> = {
  FST_ERR_CTP_INVALID_JSON_BODY: "invalid_json",
  FST_ERR_CTP_EMPTY_JSON_BODY: "invalid_json",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "unsupported_media_type",
  FST_ERR_CTP_BODY_TOO_LARGE: "payload_too_large",
};

export interface AppDeps {
  config: Config;
  db: DatabaseSync;
  s3: S3Client;
  /** Fastify options passthrough, mainly so tests can silence the logger. */
  logger?: boolean;
}

/** AppDeps plus the app logger, so helpers can report background failures. */
interface Ctx extends AppDeps {
  log: FastifyBaseLogger;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? true,
    trustProxy: deps.config.trustForwarded,
    // maxSiteBytes is enforced on *decoded* bytes in prepareFiles, but binary
    // files reach us base64-encoded inside JSON — 4 characters per 3 bytes — so
    // the transport limit has to cover that inflation or it would reject
    // payloads well under the real limit. The extra MiB covers the JSON
    // envelope (paths, title, note, quoting).
    bodyLimit: Math.ceil(deps.config.maxSiteBytes / 3) * 4 + 1_048_576,
  });

  const ctx: Ctx = { ...deps, log: app.log };

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof AuthError || err instanceof HttpError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message },
      });
    }
    if (err instanceof TtlPolicyError) {
      return reply.status(400).send({
        error: { code: err.code, message: err.message },
      });
    }
    if (err instanceof FileError) {
      return reply.status(400).send({
        error: { code: err.code, message: err.message },
      });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: "validation_error",
          message: err.issues.map((i) => i.message).join("; "),
        },
      });
    }
    // Fastify's own errors (malformed JSON, oversized body, ...) already carry
    // the right client-facing status and a safe message; without this they all
    // collapse into a misleading 500. Keyed on the FST_ERR_ prefix rather than
    // on statusCode alone, because an internal failure that happens to carry a
    // statusCode — an S3 403, say — must stay opaque and logged.
    if (
      typeof err.code === "string" &&
      err.code.startsWith("FST_ERR_") &&
      typeof err.statusCode === "number" &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      return reply.status(err.statusCode).send({
        error: {
          code: TRANSPORT_ERROR_CODES[err.code] ?? "bad_request",
          message: err.message,
        },
      });
    }
    app.log.error(err);
    return reply.status(500).send({
      error: { code: "internal_error", message: "internal server error" },
    });
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>shareplan</title>
  <style>
    :root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
    code { background: color-mix(in srgb, CanvasText 10%, transparent); padding: 0.1em 0.35em; border-radius: 4px; }
    h1 { font-size: 1.5rem; }
    a { color: inherit; }
  </style>
</head>
<body>
  <h1>shareplan</h1>
  <p>Small S3-backed microsite host for agents and humans.</p>
  <p>Publish with the CLI or <code>POST /api/v1/sites</code>. Sites live at <code>${siteUrlShape(deps.config)}</code>.</p>
  <p><a href="/healthz">healthz</a> · <a href="/docs/agents">agent docs</a></p>
</body>
</html>`;
  });

  app.get("/docs/agents", async (_req, reply) => {
    reply.type("text/markdown; charset=utf-8");
    return `# shareplan for agents

## Auth
\`Authorization: Bearer sp_...\`

## Publish a site
\`\`\`http
POST /api/v1/sites
Content-Type: application/json

{
  "title": "My plan",
  "ttl": "14d",
  "files": [
    { "path": "index.html", "content": "<!doctype html>..." }
  ]
}
\`\`\`

Response includes \`url\` like \`${siteUrl(deps.config, "<id>")}\`.

## Update
\`PUT /api/v1/sites/:id\` with the same body shape (new version).

## List / delete
- \`GET /api/v1/sites\`
- \`DELETE /api/v1/sites/:id\`

## CLI
\`shareplan publish ./site --title "..." --ttl 7d\`
`;
  });

  app.post("/api/v1/register", async (req, reply) => {
    const pepper = deps.config.ipHashPepper;
    if (!pepper) {
      throw new AuthError(
        503,
        "rate_limit_unconfigured",
        "SHAREPLAN_IP_HASH_PEPPER is not set",
      );
    }
    const ip = requestIp(req, deps.config.trustForwarded);
    const ipBucket = `ip:${hashIp(ip, pepper)}`;
    if (
      !consumeRate(
        deps.db,
        ipBucket,
        "register",
        DAY_MS,
        deps.config.registerPerDay,
      )
    ) {
      throw new HttpError(429, "rate_limited", "too many registrations from this address");
    }
    const body = createKeySchema.parse(req.body ?? {});
    const claimToken = randomBytes(16).toString("base64url");
    const user = createUser(deps.db, {
      tier: "free--",
      claimToken,
    });
    const token = createApiKey();
    const row = createApiKeyRecord(deps.db, {
      name: body.name,
      token,
      userId: user.id,
    });
    return reply.status(201).send({
      userId: user.id,
      keyId: row.id,
      name: row.name,
      token,
      tier: user.tier,
      claimUrl: `${deps.config.publicBaseUrl}/claim/${claimToken}`,
      createdAt: new Date(row.created_at).toISOString(),
    });
  });

  // --- Admin: mint API keys ---
  app.post("/api/v1/admin/keys", async (req, reply) => {
    requireAdmin(deps.config.adminTokenHash, req);
    const body = createKeySchema.parse(req.body ?? {});
    const token = createApiKey();
    const user = createUser(deps.db, { tier: "ops" });
    const row = createApiKeyRecord(deps.db, {
      name: body.name,
      token,
      userId: user.id,
    });
    return reply.status(201).send({
      id: row.id,
      name: row.name,
      token,
      createdAt: new Date(row.created_at).toISOString(),
    });
  });

  app.get("/api/v1/admin/keys", async (req, reply) => {
    requireAdmin(deps.config.adminTokenHash, req);
    const keys = listApiKeys(deps.db).map((k) => ({
      id: k.id,
      name: k.name,
      createdAt: new Date(k.created_at).toISOString(),
      revokedAt: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
    }));
    return reply.send({ keys });
  });

  app.delete("/api/v1/admin/keys/:id", async (req, reply) => {
    requireAdmin(deps.config.adminTokenHash, req);
    const { id } = req.params as { id: string };
    if (!revokeApiKey(deps.db, id)) {
      return reply.status(404).send({
        error: { code: "not_found", message: "key not found or already revoked" },
      });
    }
    return reply.status(204).send();
  });

  // --- Sites API ---
  app.post("/api/v1/sites", async (req, reply) => {
    const { key, user } = requireAccount(deps.db, req);
    const body = createSiteSchema.parse(req.body);
    consumePublishQuota(ctx, req, user);
    const site = await publishNewSite(ctx, key, user, body);
    return reply.status(201).send(site);
  });

  app.put("/api/v1/sites/:id", async (req, reply) => {
    const { key, user } = requireAccount(deps.db, req);
    const { id } = req.params as { id: string };
    const body = updateSiteSchema.parse(req.body);
    consumePublishQuota(ctx, req, user);
    const existing = getSite(deps.db, id);
    if (!existing || existing.owner_user_id !== user.id) {
      return reply.status(404).send({
        error: { code: "not_found", message: "site not found" },
      });
    }
    const site = await publishVersion(ctx, existing, user, body);
    return reply.send(site);
  });

  app.post("/api/v1/sites/:id/touch", async (req, reply) => {
    const { user } = requireAccount(deps.db, req);
    consumePublishQuota(ctx, req, user);
    const { id } = req.params as { id: string };
    const existing = getSite(deps.db, id);
    if (!existing || existing.owner_user_id !== user.id) {
      return reply.status(404).send({
        error: { code: "not_found", message: "site not found" },
      });
    }
    const policy = policyFor(user.tier);
    const now = Date.now();
    let expiresAt = existing.expires_at;
    if (existing.expires_at === null && policy.allowNullTtl) {
      expiresAt = null;
    } else {
      expiresAt = resolveTierExpiry(policy, policy.maxTtl, now, "explicit");
    }
    updateSiteExpiry(deps.db, id, expiresAt, now);
    const row = getSite(deps.db, id)!;
    return reply.send(toSiteResponse(deps.config, row));
  });

  app.get("/api/v1/sites", async (req, reply) => {
    const { user } = requireAccount(deps.db, req);
    const rows = listSitesForUser(deps.db, user.id);
    const items: SiteListItem[] = rows.map((r) => toListItem(deps.config, r));
    return reply.send({ sites: items });
  });

  app.get("/api/v1/sites/:id", async (req, reply) => {
    const { user } = requireAccount(deps.db, req);
    const { id } = req.params as { id: string };
    const row = getSite(deps.db, id);
    if (!row || row.owner_user_id !== user.id) {
      return reply.status(404).send({
        error: { code: "not_found", message: "site not found" },
      });
    }
    return reply.send(toSiteResponse(deps.config, row));
  });

  app.delete("/api/v1/sites/:id", async (req, reply) => {
    const { user } = requireAccount(deps.db, req);
    const { id } = req.params as { id: string };
    const row = getSite(deps.db, id);
    if (!row || row.owner_user_id !== user.id) {
      return reply.status(404).send({
        error: { code: "not_found", message: "site not found" },
      });
    }
    await deleteSiteObjects(deps.s3, deps.config.s3.bucket, id);
    deleteSite(deps.db, id);
    return reply.status(204).send();
  });

  // --- Public serve ---
  const suffix = deps.config.siteHostSuffix;

  if (suffix !== null) {
    // Every site gets its own origin: <label>.<suffix>. Requests on a site
    // host are answered here, before any route handler, so nothing but that
    // site's content is reachable from it. A route constraint would not do:
    // find-my-way prefers a static match like /healthz over a constrained
    // wildcard, so the API would leak through. Only single-label subdomains
    // count; the apex stays the API host.
    app.addHook("onRequest", async (req, reply) => {
      const label = siteLabelFromHost(req.headers.host ?? "", suffix);
      if (label === null) return;
      if (req.method !== "GET" && req.method !== "HEAD") {
        reply.header("Allow", "GET, HEAD");
        await reply.status(405).send({
          error: { code: "method_not_allowed", message: "site hosts serve content only" },
        });
        return reply;
      }
      if (RESERVED_LABELS.has(label)) {
        // Never a site (slugs cannot claim these), so send www and friends
        // to the same path on the API host rather than 404 them as missing
        // sites. req.url always starts with "/", so the base stays in charge.
        await reply.redirect(`${deps.config.publicBaseUrl}${req.url}`, 302);
        return reply;
      }
      // No route matched here, so nothing has percent-decoded the path yet;
      // the /s/:id/* route got that from find-my-way for free.
      const relPath = decodePath(splitQuery(req.url).path);
      if (relPath === null) {
        await reply.status(400).send({ error: { code: "invalid_path", message: "invalid path" } });
        return reply;
      }
      await serveSitePath(ctx, req, reply, label, relPath);
      return reply;
    });
  }

  // /s/:id/... is the only site URL without a suffix, and a legacy link with
  // one: it then hops to the site's own origin instead of being served from
  // the shared one. Temporary redirect, since the layout is config, not a
  // fact about the site. Three registrations because find-my-way does not
  // fold the bare, trailing-slash, and splat forms into one route.
  const legacy = async (req: FastifyRequest, reply: FastifyReply, bare: boolean) => {
    const params = req.params as { id: string; "*"?: string };
    // Params arrive decoded, so anything that goes back into a URL is
    // re-encoded per segment rather than pasted in as text.
    const rest = (params["*"] ?? "").split("/").map(encodeURIComponent).join("/");
    const { query } = splitQuery(req.url);
    if (suffix === null) {
      if (bare) {
        return reply.redirect(`/s/${encodeURIComponent(params.id)}/${query}`, 302);
      }
      return serveSitePath(ctx, req, reply, params.id, params["*"] ?? "");
    }
    // The id lands in the Location hostname, so it must be a clean label:
    // anything else (a dot, an encoded "#" or "/") would let a crafted link
    // redirect to a host of the attacker's choosing.
    const label = params.id.toLowerCase();
    if (!isHostLabel(label)) {
      return reply.status(404).send({ error: { code: "not_found", message: "site not found" } });
    }
    return reply.redirect(`${siteUrl(deps.config, label)}${rest}${query}`, 302);
  };
  app.get("/s/:id", (req, reply) => legacy(req, reply, true));
  app.get("/s/:id/", (req, reply) => legacy(req, reply, false));
  app.get("/s/:id/*", (req, reply) => legacy(req, reply, false));

  return app;
}

/** Request URL split at the "?", with the query keeping its "?" (or ""). */
function splitQuery(url: string): { path: string; query: string } {
  const q = url.indexOf("?");
  return q === -1 ? { path: url, query: "" } : { path: url.slice(0, q), query: url.slice(q) };
}

/** A raw request path percent-decoded, or null if the encoding is broken. */
function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/**
 * The subdomain label of a site host, lowercased, or null if the host is not
 * `<one-label>.<suffix>`. Works from the raw Host header, so it drops the
 * port and a trailing dot first: `site.example.com.:443` is the same host as
 * `site.example.com`, and treating it as anything else would let a request
 * on a site's own name reach the API.
 */
export function siteLabelFromHost(host: string, suffix: string): string | null {
  const name = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!name.endsWith(`.${suffix}`)) return null;
  const label = name.slice(0, -(suffix.length + 1));
  return isHostLabel(label) ? label : null;
}

/** Labels that must stay free so they can never be claimed as a slug. */
const RESERVED_LABELS = new Set(["www", "api", "admin", "docs", "mail", "static", "cdn"]);

function consumePublishQuota(ctx: Ctx, req: FastifyRequest, user: UserRow): void {
  const policy = policyFor(user.tier);
  if (policy.ipPublishLimit) {
    const pepper = ctx.config.ipHashPepper;
    if (!pepper) {
      throw new AuthError(
        503,
        "rate_limit_unconfigured",
        "SHAREPLAN_IP_HASH_PEPPER is not set",
      );
    }
    const ip = requestIp(req, ctx.config.trustForwarded);
    const ipBucket = `ip:${hashIp(ip, pepper)}`;
    if (!consumeRate(ctx.db, ipBucket, "publish", HOUR_MS, policy.publishPerHour)) {
      throw new HttpError(429, "rate_limited", "too many publishes from this address");
    }
  }
  const userBucket = `user:${user.id}`;
  if (!consumeRate(ctx.db, userBucket, "publish", HOUR_MS, policy.publishPerHour)) {
    throw new HttpError(429, "rate_limited", "too many publishes");
  }
}

function assertTierPublish(
  user: UserRow,
  body: { slug?: string; visibility?: Visibility },
): void {
  const policy = policyFor(user.tier);
  if (body.slug !== undefined && !policy.slugs) {
    throw new HttpError(400, "slug_not_allowed", "this tier cannot set a vanity slug");
  }
  if (body.visibility === "public" && !policy.publicVisibility) {
    throw new HttpError(
      400,
      "visibility_not_allowed",
      "this tier cannot list sites as public",
    );
  }
}

async function publishNewSite(
  ctx: Ctx,
  key: ApiKeyRow,
  user: UserRow,
  body: z.infer<typeof createSiteSchema>,
): Promise<SiteResponse> {
  assertTierPublish(user, body);
  const policy = policyFor(user.tier);
  let files = prepareFiles(body.files, ctx.config);
  files = ensureIndexHtml(files);

  const siteId = createSiteId();
  const versionId = createVersionId();
  const now = Date.now();
  const visibility: Visibility = body.visibility ?? "unlisted";
  const expires_at = resolveTierExpiry(policy, body.ttl, now, "create");

  if (body.slug !== undefined) {
    assertSlugAvailable(ctx, body.slug);
  }

  const byte_size = files.reduce((n, f) => n + f.body.byteLength, 0);
  const file_count = files.length;

  await putSiteFiles(ctx.s3, ctx.config.s3.bucket, siteId, versionId, files);

  insertSite(ctx.db, {
    id: siteId,
    owner_key_id: key.id,
    owner_user_id: user.id,
    slug: body.slug ?? null,
    title: body.title ?? null,
    visibility,
    current_version_id: versionId,
    created_at: now,
    updated_at: now,
    expires_at,
    byte_size,
    file_count,
  });
  insertVersion(ctx.db, {
    id: versionId,
    site_id: siteId,
    created_at: now,
    byte_size,
    file_count,
    note: body.note ?? null,
  });

  const row = getSite(ctx.db, siteId)!;
  return toSiteResponse(ctx.config, row);
}

async function publishVersion(
  ctx: Ctx,
  existing: SiteRow,
  user: UserRow,
  body: z.infer<typeof updateSiteSchema>,
): Promise<SiteResponse> {
  assertTierPublish(user, body);
  const policy = policyFor(user.tier);
  let files = prepareFiles(body.files, ctx.config);
  files = ensureIndexHtml(files);

  const versionId = createVersionId();
  const now = Date.now();

  // An explicit ttl always wins (including `null` to clear it, if the tier
  // allows). Otherwise keep whatever expiry the site already had.
  let expires_at = existing.expires_at;
  if (body.ttl !== undefined) {
    expires_at = resolveTierExpiry(policy, body.ttl, now, "explicit");
  }

  // Checked up front so a taken slug fails before we upload anything, but only
  // written once the upload lands — a failed publish must not move the slug.
  const newSlug =
    body.slug !== undefined && body.slug !== existing.slug ? body.slug : null;
  if (newSlug !== null) {
    assertSlugAvailable(ctx, newSlug, existing.id);
  }

  const byte_size = files.reduce((n, f) => n + f.body.byteLength, 0);
  const file_count = files.length;
  const visibility = body.visibility ?? existing.visibility;

  await putSiteFiles(ctx.s3, ctx.config.s3.bucket, existing.id, versionId, files);

  if (newSlug !== null) {
    // Re-checked after the upload, not just before it: another publish can claim
    // the slug while we await S3, and sites.slug is UNIQUE, so writing blind
    // would surface the race as a 500 instead of a 409. Nothing awaits between
    // this check and the writes below, so they land as one step.
    try {
      assertSlugAvailable(ctx, newSlug, existing.id);
    } catch (err) {
      await discardVersionObjects(ctx, existing.id, versionId);
      throw err;
    }
    updateSiteSlug(ctx.db, existing.id, newSlug);
  }
  updateSiteVersion(ctx.db, existing.id, {
    current_version_id: versionId,
    updated_at: now,
    expires_at,
    byte_size,
    file_count,
    title: body.title ?? undefined,
    visibility,
  });
  insertVersion(ctx.db, {
    id: versionId,
    site_id: existing.id,
    created_at: now,
    byte_size,
    file_count,
    note: body.note ?? null,
  });

  await pruneOldVersions(ctx, existing.id);

  const row = getSite(ctx.db, existing.id)!;
  return toSiteResponse(ctx.config, row);
}

/**
 * Slugs share a namespace with site ids, so both must be free. A slug is also
 * a DNS label under hostname serving, so reserved labels stay off limits in
 * every mode: a site claimed as "www" under path serving would break the
 * moment a suffix was configured.
 */
function assertSlugAvailable(ctx: Ctx, slug: string, exceptSiteId?: string): void {
  if (RESERVED_LABELS.has(slug)) {
    throw new HttpError(409, "slug_taken", `slug "${slug}" is reserved`);
  }
  const bySlug = getSiteBySlug(ctx.db, slug);
  if (bySlug && bySlug.id !== exceptSiteId) {
    throw new HttpError(409, "slug_taken", `slug "${slug}" is already in use`);
  }
  if (getSite(ctx.db, slug)) {
    throw new HttpError(409, "slug_taken", `slug "${slug}" collides with a site id`);
  }
}

/**
 * Drop the objects of a version that will never be recorded. No site_versions
 * row means pruning can never reach them, so a publish that dies after its
 * upload has to clean up after itself. Failing to is logged, not fatal — the
 * caller is already on its way to reporting a more useful error.
 */
async function discardVersionObjects(
  ctx: Ctx,
  siteId: string,
  versionId: string,
): Promise<void> {
  try {
    await deleteVersionObjects(ctx.s3, ctx.config.s3.bucket, siteId, versionId);
  } catch (err) {
    ctx.log.warn(
      { err, siteId, versionId },
      "failed to discard objects of an abandoned version",
    );
  }
}

/**
 * Drop objects for versions beyond the retention window. The previous version
 * is kept so a page loaded moments before a republish can still fetch its
 * assets. Failures are logged, not fatal — the publish itself already landed.
 */
async function pruneOldVersions(ctx: Ctx, siteId: string): Promise<void> {
  const stale = listPrunableVersions(ctx.db, siteId, ctx.config.versionRetention);
  for (const version of stale) {
    try {
      await deleteVersionObjects(ctx.s3, ctx.config.s3.bucket, siteId, version.id);
      markVersionPruned(ctx.db, version.id);
    } catch (err) {
      ctx.log.warn(
        { err, siteId, versionId: version.id },
        "failed to prune old version objects",
      );
    }
  }
}

/**
 * Resolve a requested path with the same sanitizer that builds S3 keys, so
 * anything the sanitizer rejects (drive letters, backslashes, null bytes,
 * over-long paths) becomes a 400 instead of a PathError escaping into the
 * generic 500 handler. Null means "not serviceable". Passing the result to
 * s3ObjectKey re-sanitizes it, which is safe because sanitizeSitePath is
 * idempotent by contract.
 */
function normalizeServePath(relPath: string): string | null {
  let path = relPath.replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) {
    path = `${path}index.html`;
  }
  try {
    return sanitizeSitePath(path);
  } catch {
    return null;
  }
}

/**
 * The site's own policy headers, which every response that reveals its content
 * carries — including the directory redirect, so a private site's no-store does
 * not go missing on the hop.
 */
function setSiteHeaders(reply: FastifyReply, site: SiteRow): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  // Only sites explicitly marked public are indexable; unlisted sites rely on
  // the id being unguessable, which crawling would defeat.
  reply.header(
    "X-Robots-Tag",
    site.visibility === "public" ? "noarchive" : "noindex, nofollow, noarchive",
  );
  reply.header(
    "Cache-Control",
    site.visibility === "private" ? "private, no-store" : "public, max-age=60",
  );
}

async function serveSitePath(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  idOrSlug: string,
  relPath: string,
): Promise<void> {
  const site = getSiteByIdOrSlug(ctx.db, idOrSlug);
  if (!site || !site.current_version_id) {
    await reply.status(404).send({ error: { code: "not_found", message: "site not found" } });
    return;
  }
  if (isExpired(site)) {
    await reply.status(410).send({ error: { code: "gone", message: "site expired" } });
    return;
  }
  if (site.visibility === "private") {
    // Require API key of owner for private sites (v1 simple)
    try {
      const { user } = requireAccount(ctx.db, req);
      if (user.id !== site.owner_user_id) {
        await reply.status(404).send({ error: { code: "not_found", message: "site not found" } });
        return;
      }
    } catch {
      await reply.status(401).send({
        error: { code: "unauthorized", message: "private site requires API key" },
      });
      return;
    }
  }

  const path = normalizeServePath(relPath);
  if (path === null) {
    await reply.status(400).send({ error: { code: "invalid_path", message: "invalid path" } });
    return;
  }

  const key = s3ObjectKey(site.id, site.current_version_id, path);
  const obj = await getObject(ctx.s3, ctx.config.s3.bucket, key);

  // A directory hit has to bounce to the trailing-slash URL rather than serve
  // the index here: at /s/:id/docs the browser resolves "./style.css" against
  // /s/:id/, one level too high. Redirect off the request URL so vanity slugs
  // and the query string survive, and keep it temporary — a later version may
  // publish a real file at this path.
  if (!obj && !path.endsWith("index.html")) {
    const indexPath = normalizeServePath(`${path}/index.html`);
    if (indexPath !== null) {
      const idxKey = s3ObjectKey(site.id, site.current_version_id, indexPath);
      if (await getObject(ctx.s3, ctx.config.s3.bucket, idxKey)) {
        const { path: reqPath, query } = splitQuery(req.url);
        setSiteHeaders(reply, site);
        // Collapse leading slashes so "//host" can never become a
        // scheme-relative Location; the redirect stays on this origin.
        await reply.redirect(`${reqPath.replace(/^\/+/, "/")}/${query}`, 302);
        return;
      }
    }
  }

  if (!obj) {
    await reply.status(404).send({ error: { code: "not_found", message: "file not found" } });
    return;
  }

  const ct = obj.contentType ?? contentTypeForPath(path);
  reply.header("Content-Type", ct);
  setSiteHeaders(reply, site);

  if (isHtmlPath(path) || ct.startsWith("text/html")) {
    // Permissive enough for LLM demo HTML with inline scripts/styles
    reply.header(
      "Content-Security-Policy",
      [
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
      ].join("; "),
    );
  }

  await reply.send(obj.body);
}

/**
 * Sites share the API host's scheme; a plain-http deployment behind no TLS
 * would otherwise hand out https links that do not resolve.
 */
function siteScheme(config: Config): "http" | "https" {
  return config.publicBaseUrl.startsWith("http://") ? "http" : "https";
}

function siteUrl(config: Config, id: string): string {
  if (config.siteHostSuffix === null) {
    return `${config.publicBaseUrl}/s/${id}/`;
  }
  return `${siteScheme(config)}://${id}.${config.siteHostSuffix}/`;
}

/** How the landing page describes site URLs, without inventing an id. */
function siteUrlShape(config: Config): string {
  return config.siteHostSuffix === null
    ? "/s/:id/"
    : `${siteScheme(config)}://:id.${config.siteHostSuffix}/`;
}

function toSiteResponse(config: Config, row: SiteRow): SiteResponse {
  return {
    id: row.id,
    url: siteUrl(config, row.id),
    versionId: row.current_version_id ?? "",
    title: row.title,
    slug: row.slug,
    visibility: row.visibility,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    byteSize: row.byte_size,
    fileCount: row.file_count,
  };
}

function toListItem(config: Config, row: SiteRow): SiteListItem {
  return {
    id: row.id,
    url: siteUrl(config, row.id),
    title: row.title,
    slug: row.slug,
    visibility: row.visibility,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    byteSize: row.byte_size,
    currentVersionId: row.current_version_id,
  };
}
