import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import multipart from "@fastify/multipart";
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
  insertSite,
  insertVersion,
  isExpired,
  listSitesForKey,
  updateSiteVersion,
  type ApiKeyRow,
  type SiteRow,
} from "./db.js";
import { AuthError, requireAdmin, requireApiKey } from "./auth.js";
import { FileError, ensureIndexHtml, prepareFiles } from "./files.js";
import { deleteSiteObjects, getObject, putSiteFiles } from "./storage.js";

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
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: deps.config.maxSiteBytes + 1_048_576,
  });

  await app.register(multipart, {
    limits: {
      fileSize: deps.config.maxSiteBytes,
      files: deps.config.maxFileCount,
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) {
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

  // --- Sites API ---
  app.post("/api/v1/sites", async (req, reply) => {
    const key = requireApiKey(deps.db, req);
    const body = createSiteSchema.parse(req.body);
    const site = await publishNewSite(deps, key, body);
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
    const site = await publishVersion(deps, existing, body);
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

  // --- Public serve ---
  app.get("/s/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.redirect(`/s/${id}/`, 302);
  });

  app.get("/s/:id/*", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wildcard = (req.params as { "*": string })["*"] ?? "";
    return serveSitePath(deps, req, reply, id, wildcard);
  });

  // Fastify may not match trailing slash path with splat alone in all versions
  app.get("/s/:id/", async (req, reply) => {
    const { id } = req.params as { id: string };
    return serveSitePath(deps, req, reply, id, "");
  });

  return app;
}

async function publishNewSite(
  deps: AppDeps,
  key: ApiKeyRow,
  body: z.infer<typeof createSiteSchema>,
): Promise<SiteResponse> {
  let files = prepareFiles(body.files, deps.config);
  files = ensureIndexHtml(files);

  const siteId = createSiteId();
  const versionId = createVersionId();
  const now = Date.now();
  const visibility: Visibility = body.visibility ?? "unlisted";
  const ttlInput = body.ttl !== undefined ? body.ttl : deps.config.defaultTtl;
  let expires_at: number | null;
  try {
    expires_at = expiresAtFromTtl(ttlInput, now);
  } catch (e) {
    throw new FileError("invalid_ttl", e instanceof Error ? e.message : "invalid ttl");
  }

  const byte_size = files.reduce((n, f) => n + f.body.byteLength, 0);
  const file_count = files.length;

  await putSiteFiles(deps.s3, deps.config.s3.bucket, siteId, versionId, files);

  insertSite(deps.db, {
    id: siteId,
    owner_key_id: key.id,
    slug: body.slug ?? null,
    title: body.title ?? null,
    visibility,
    current_version_id: versionId,
    created_at: now,
    updated_at: now,
    expires_at,
  });
  // set sizes via update to keep insert simple
  updateSiteVersion(deps.db, siteId, {
    current_version_id: versionId,
    updated_at: now,
    expires_at,
    byte_size,
    file_count,
    title: body.title ?? null,
    visibility,
  });
  insertVersion(deps.db, {
    id: versionId,
    site_id: siteId,
    created_at: now,
    byte_size,
    file_count,
    note: body.note ?? null,
  });

  const row = getSite(deps.db, siteId)!;
  return toSiteResponse(deps.config, row);
}

async function publishVersion(
  deps: AppDeps,
  existing: SiteRow,
  body: z.infer<typeof updateSiteSchema>,
): Promise<SiteResponse> {
  let files = prepareFiles(body.files, deps.config);
  files = ensureIndexHtml(files);

  const versionId = createVersionId();
  const now = Date.now();
  const ttlInput =
    body.ttl !== undefined ? body.ttl : existing.expires_at
      ? null // keep existing expiry unless explicitly set
      : deps.config.defaultTtl;

  let expires_at = existing.expires_at;
  if (body.ttl !== undefined) {
    try {
      expires_at = expiresAtFromTtl(body.ttl, now);
    } catch (e) {
      throw new FileError("invalid_ttl", e instanceof Error ? e.message : "invalid ttl");
    }
  } else if (ttlInput && !existing.expires_at) {
    try {
      expires_at = expiresAtFromTtl(ttlInput, now);
    } catch {
      /* keep */
    }
  }

  const byte_size = files.reduce((n, f) => n + f.body.byteLength, 0);
  const file_count = files.length;
  const visibility = body.visibility ?? existing.visibility;

  await putSiteFiles(
    deps.s3,
    deps.config.s3.bucket,
    existing.id,
    versionId,
    files,
  );

  updateSiteVersion(deps.db, existing.id, {
    current_version_id: versionId,
    updated_at: now,
    expires_at,
    byte_size,
    file_count,
    title: body.title ?? undefined,
    visibility,
  });
  insertVersion(deps.db, {
    id: versionId,
    site_id: existing.id,
    created_at: now,
    byte_size,
    file_count,
    note: body.note ?? null,
  });

  const row = getSite(deps.db, existing.id)!;
  return toSiteResponse(deps.config, row);
}

async function serveSitePath(
  deps: AppDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
  relPath: string,
): Promise<void> {
  const site = getSite(deps.db, id);
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
      const key = requireApiKey(deps.db, req);
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

  const key = s3ObjectKey(id, site.current_version_id, path);
  let obj = await getObject(deps.s3, deps.config.s3.bucket, key);

  // Try index.html under directory
  if (!obj && !path.endsWith("index.html")) {
    const idxKey = s3ObjectKey(id, site.current_version_id, `${path}/index.html`);
    obj = await getObject(deps.s3, deps.config.s3.bucket, idxKey);
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
  reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  reply.header("Cache-Control", "public, max-age=60");

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
