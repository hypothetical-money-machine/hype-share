import Fastify, {
  type FastifyBaseLogger,
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
  expiresAtFromTtl,
  isHtmlPath,
  s3ObjectKey,
  type SiteResponse,
  type SiteListItem,
  type Visibility,
} from "@shareplan/core";
import type { Config } from "./config.js";
import {
  createApiKeyRecord,
  deleteSite,
  getSite,
  getSiteByIdOrSlug,
  getSiteBySlug,
  insertSite,
  insertVersion,
  isExpired,
  listApiKeys,
  listPrunableVersions,
  listSitesForKey,
  markVersionPruned,
  revokeApiKey,
  updateSiteSlug,
  updateSiteVersion,
  type ApiKeyRow,
  type SiteRow,
} from "./db.js";
import { AuthError, requireAdmin, requireApiKey } from "./auth.js";
import { HttpError } from "./errors.js";
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
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/i, "slug must be alphanumeric with hyphens")
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
    bodyLimit: deps.config.maxSiteBytes + 1_048_576,
  });

  const ctx: Ctx = { ...deps, log: app.log };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError || err instanceof HttpError) {
      return reply.status(err.statusCode).send({
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
  <p>Publish with the CLI or <code>POST /api/v1/sites</code>. Sites live at <code>/s/:id/</code>.</p>
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

Response includes \`url\` like \`${deps.config.publicBaseUrl}/s/<id>/\`.

## Update
\`PUT /api/v1/sites/:id\` with the same body shape (new version).

## List / delete
- \`GET /api/v1/sites\`
- \`DELETE /api/v1/sites/:id\`

## CLI
\`shareplan publish ./site --title "..." --ttl 7d\`
`;
  });

  // --- Admin: mint API keys ---
  app.post("/api/v1/admin/keys", async (req, reply) => {
    requireAdmin(deps.config.adminToken, req);
    const body = createKeySchema.parse(req.body ?? {});
    const token = createApiKey();
    const row = createApiKeyRecord(deps.db, { name: body.name, token });
    return reply.status(201).send({
      id: row.id,
      name: row.name,
      token,
      createdAt: new Date(row.created_at).toISOString(),
    });
  });

  app.get("/api/v1/admin/keys", async (req, reply) => {
    requireAdmin(deps.config.adminToken, req);
    const keys = listApiKeys(deps.db).map((k) => ({
      id: k.id,
      name: k.name,
      createdAt: new Date(k.created_at).toISOString(),
      revokedAt: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
    }));
    return reply.send({ keys });
  });

  app.delete("/api/v1/admin/keys/:id", async (req, reply) => {
    requireAdmin(deps.config.adminToken, req);
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
    const key = requireApiKey(deps.db, req);
    const body = createSiteSchema.parse(req.body);
    const site = await publishNewSite(ctx, key, body);
    return reply.status(201).send(site);
  });

  app.put("/api/v1/sites/:id", async (req, reply) => {
    const key = requireApiKey(deps.db, req);
    const { id } = req.params as { id: string };
    const body = updateSiteSchema.parse(req.body);
    const existing = getSite(deps.db, id);
    if (!existing || existing.owner_key_id !== key.id) {
      return reply.status(404).send({
        error: { code: "not_found", message: "site not found" },
      });
    }
    const site = await publishVersion(ctx, existing, body);
    return reply.send(site);
  });

  app.get("/api/v1/sites", async (req, reply) => {
    const key = requireApiKey(deps.db, req);
    const rows = listSitesForKey(deps.db, key.id);
    const items: SiteListItem[] = rows.map((r) => toListItem(deps.config, r));
    return reply.send({ sites: items });
  });

  app.get("/api/v1/sites/:id", async (req, reply) => {
    const key = requireApiKey(deps.db, req);
    const { id } = req.params as { id: string };
    const row = getSite(deps.db, id);
    if (!row || row.owner_key_id !== key.id) {
      return reply.status(404).send({
        error: { code: "not_found", message: "site not found" },
      });
    }
    return reply.send(toSiteResponse(deps.config, row));
  });

  app.delete("/api/v1/sites/:id", async (req, reply) => {
    const key = requireApiKey(deps.db, req);
    const { id } = req.params as { id: string };
    const row = getSite(deps.db, id);
    if (!row || row.owner_key_id !== key.id) {
      return reply.status(404).send({
        error: { code: "not_found", message: "site not found" },
      });
    }
    await deleteSiteObjects(deps.s3, deps.config.s3.bucket, id);
    deleteSite(deps.db, id);
    return reply.status(204).send();
  });

  // --- Public serve --- (:id accepts a site id or a vanity slug)
  app.get("/s/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.redirect(`/s/${encodeURIComponent(id)}/`, 302);
  });

  app.get("/s/:id/*", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wildcard = (req.params as { "*": string })["*"] ?? "";
    return serveSitePath(ctx, req, reply, id, wildcard);
  });

  // Fastify may not match trailing slash path with splat alone in all versions
  app.get("/s/:id/", async (req, reply) => {
    const { id } = req.params as { id: string };
    return serveSitePath(ctx, req, reply, id, "");
  });

  return app;
}

async function publishNewSite(
  ctx: Ctx,
  key: ApiKeyRow,
  body: z.infer<typeof createSiteSchema>,
): Promise<SiteResponse> {
  let files = prepareFiles(body.files, ctx.config);
  files = ensureIndexHtml(files);

  const siteId = createSiteId();
  const versionId = createVersionId();
  const now = Date.now();
  const visibility: Visibility = body.visibility ?? "unlisted";
  const expires_at = resolveTtl(
    body.ttl !== undefined ? body.ttl : ctx.config.defaultTtl,
    now,
  );

  if (body.slug !== undefined) {
    assertSlugAvailable(ctx, body.slug);
  }

  const byte_size = files.reduce((n, f) => n + f.body.byteLength, 0);
  const file_count = files.length;

  await putSiteFiles(ctx.s3, ctx.config.s3.bucket, siteId, versionId, files);

  insertSite(ctx.db, {
    id: siteId,
    owner_key_id: key.id,
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
  body: z.infer<typeof updateSiteSchema>,
): Promise<SiteResponse> {
  let files = prepareFiles(body.files, ctx.config);
  files = ensureIndexHtml(files);

  const versionId = createVersionId();
  const now = Date.now();

  // An explicit ttl always wins (including `null` to clear it). Otherwise keep
  // whatever expiry the site already had, and only fall back to the server
  // default for a site that has never had one.
  let expires_at = existing.expires_at;
  if (body.ttl !== undefined) {
    expires_at = resolveTtl(body.ttl, now);
  } else if (existing.expires_at === null) {
    expires_at = resolveTtl(ctx.config.defaultTtl, now);
  }

  if (body.slug !== undefined && body.slug !== existing.slug) {
    assertSlugAvailable(ctx, body.slug, existing.id);
    updateSiteSlug(ctx.db, existing.id, body.slug);
  }

  const byte_size = files.reduce((n, f) => n + f.body.byteLength, 0);
  const file_count = files.length;
  const visibility = body.visibility ?? existing.visibility;

  await putSiteFiles(ctx.s3, ctx.config.s3.bucket, existing.id, versionId, files);

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

function resolveTtl(
  ttl: string | number | null | undefined,
  now: number,
): number | null {
  try {
    return expiresAtFromTtl(ttl, now);
  } catch (e) {
    throw new FileError("invalid_ttl", e instanceof Error ? e.message : "invalid ttl");
  }
}

/** Slugs share the `/s/:id/` namespace with site ids, so both must be free. */
function assertSlugAvailable(ctx: Ctx, slug: string, exceptSiteId?: string): void {
  const bySlug = getSiteBySlug(ctx.db, slug);
  if (bySlug && bySlug.id !== exceptSiteId) {
    throw new HttpError(409, "slug_taken", `slug "${slug}" is already in use`);
  }
  if (getSite(ctx.db, slug)) {
    throw new HttpError(409, "slug_taken", `slug "${slug}" collides with a site id`);
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
      const key = requireApiKey(ctx.db, req);
      if (key.id !== site.owner_key_id) {
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

  let path = (relPath || "index.html").replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) {
    path = `${path}index.html`.replace(/^\/+/, "");
  }

  // Prevent traversal in serve path
  if (path.includes("..") || path.startsWith("/")) {
    await reply.status(400).send({ error: { code: "invalid_path", message: "invalid path" } });
    return;
  }

  const key = s3ObjectKey(site.id, site.current_version_id, path);
  let obj = await getObject(ctx.s3, ctx.config.s3.bucket, key);

  // Try index.html under directory
  if (!obj && !path.endsWith("index.html")) {
    const idxKey = s3ObjectKey(site.id, site.current_version_id, `${path}/index.html`);
    obj = await getObject(ctx.s3, ctx.config.s3.bucket, idxKey);
    if (obj) path = `${path}/index.html`;
  }

  if (!obj) {
    await reply.status(404).send({ error: { code: "not_found", message: "file not found" } });
    return;
  }

  const ct = obj.contentType ?? contentTypeForPath(path);
  reply.header("Content-Type", ct);
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
    site.visibility === "private"
      ? "private, no-store"
      : "public, max-age=60",
  );

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

function siteUrl(config: Config, id: string): string {
  return `${config.publicBaseUrl}/s/${id}/`;
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
