import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import fastifyCookie from "@fastify/cookie";
import { createWorkOS } from "@workos-inc/node";
import { z } from "zod";
import {
  createApiKey,
  createSiteId,
  createVersionId,
  contentTypeForPath,
  HOST_LABEL_RE,
  isHostLabel,
  isHtmlPath,
  RESERVED_HOST_LABELS,
  s3ObjectKey,
  sanitizeSitePath,
  siteLabelFromHost,
  type SiteResponse,
  type SiteListItem,
  type Visibility,
} from "@shareplan/core";
import { WORKOS_CALLBACK_PATH, type Config } from "./config.js";
import { randomBytes } from "node:crypto";
import {
  createApiKeyRecord,
  createClaimAuthFlow,
  createUser,
  ClaimIdentityConflictError,
  ClaimStateError,
  completeClaim,
  deleteClaimAuthFlow,
  deleteSite,
  findUserByClaimToken,
  getClaimAuthFlow,
  getSite,
  getSiteByIdOrSlug,
  getSiteBySlug,
  hashApiKey,
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
import { consumeRate } from "./rate-limit.js";
import {
  clampStoredExpiry,
  policyFor,
  resolveTierExpiry,
  tierForAuthenticationMethod,
  TtlPolicyError,
  UnknownTierError,
  type TierPolicy,
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

const CLAIM_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const BROWSER_NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_CONFIRM_COOKIE = "shareplan_claim_confirm";
const CLAIM_CALLBACK_COOKIE = "shareplan_claim_callback";
const CLAIM_CONFIRM_MAX_AGE_SECONDS = 5 * 60;
const CLAIM_CALLBACK_MAX_AGE_SECONDS = 10 * 60;
const CLAIM_STARTS_PER_HOUR = 10;

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
  /** Test override for the two WorkOS methods used by account claiming. */
  workos?: WorkOSAuthClient;
}

export interface WorkOSAuthClient {
  userManagement: {
    getAuthorizationUrlWithPKCE(options: {
      clientId: string;
      provider: "authkit";
      redirectUri: string;
      screenHint: "sign-up";
    }): Promise<{ url: string; state: string; codeVerifier: string }>;
    authenticateWithCode(options: {
      clientId: string;
      code: string;
      codeVerifier: string;
      ipAddress: string;
      userAgent?: string;
    }): Promise<{
      user: { id: string; email: string; emailVerified: boolean };
      authenticationMethod?: string;
    }>;
  };
}

/** AppDeps plus the app logger, so helpers can report background failures. */
interface Ctx extends AppDeps {
  log: FastifyBaseLogger;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? true,
    // One hop: the socket peer, or the address the immediate proxy added.
    // `true` would trust every X-Forwarded-For entry, including the client's.
    trustProxy: deps.config.trustForwarded ? 1 : false,
    // maxSiteBytes is enforced on *decoded* bytes in prepareFiles, but binary
    // files reach us base64-encoded inside JSON — 4 characters per 3 bytes — so
    // the transport limit has to cover that inflation or it would reject
    // payloads well under the real limit. The extra MiB covers the JSON
    // envelope (paths, title, note, quoting).
    bodyLimit: Math.ceil(deps.config.maxSiteBytes / 3) * 4 + 1_048_576,
  });

  const ctx: Ctx = { ...deps, log: app.log };
  const workos = deps.workos ?? createWorkOSAuthClient(deps.config);

  app.register(fastifyCookie);
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (req, body, done) => {
      const isClaimConfirmation =
        req.method === "POST" &&
        /^\/claim\/[A-Za-z0-9_-]{22}$/.test(splitQuery(req.url).path) &&
        body === "";
      if (isClaimConfirmation) {
        done(null, {});
        return;
      }
      done(
        new HttpError(
          415,
          "unsupported_media_type",
          "Unsupported Media Type: application/x-www-form-urlencoded",
        ),
      );
    },
  );

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
    if (err instanceof UnknownTierError) {
      return reply.status(400).send({
        error: { code: "invalid_tier", message: err.message },
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
    return [
      "# shareplan for agents",
      "",
      "## Register",
      "```http",
      "POST /api/v1/register",
      "Content-Type: application/json",
      "",
      JSON.stringify({ name: "claude" }, null, 2),
      "```",
      "",
      "Returns `token` (`sp_...`), `claimUrl`, and account metadata. Rate-limited to 10/day per IP hash.",
      "",
      "## Auth",
      "`Authorization: Bearer sp_...`",
      "",
      "## Publish a site",
      "```http",
      "POST /api/v1/sites",
      "Content-Type: application/json",
      "",
      JSON.stringify({
        title: "My plan",
        ttl: "14d",
        visibility: "unlisted",
        files: [{ path: "index.html", content: "<!doctype html>..." }],
      }, null, 2),
      "```",
      "",
      "Binary files use `contentBase64`. Response includes `url` like `" + siteUrl(deps.config, "<id>") + "`.",
      "",
      "## Update",
      "`PUT /api/v1/sites/:id` with the same body shape (new version).",
      "",
      "## Keep-alive (touch)",
      "`POST /api/v1/sites/:id/touch` resets TTL to the tier maximum (30d on free--).",
      "",
      "## List / delete",
      "- `GET /api/v1/sites`",
      "- `GET /api/v1/sites/:id`",
      "- `DELETE /api/v1/sites/:id`",
      "",
      "## CLI",
      "```bash",
      "shareplan register --url <url> --name <name>",
      "shareplan publish ./site --title \"plan\" --ttl 7d",
      "shareplan touch <id>",
      "```",
      "",
      "## Limits and tiers",
      "- free-- (registered / hosted): 7d default TTL, 30d max, unlisted, no vanity slugs",
      "- ops (self-hosted operator key): no TTL maximum cap, permanent hosting (ttl: null) and slugs allowed",
      "- Files: HTML, CSS, JS, JSON, text, markdown, images, fonts (up to 50 MiB, 200 files)",
      "",
    ].join("\n");
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
    const body = createKeySchema.parse(req.body ?? {});
    const ip = requestIp(req);
    const ipBucket = `ip:${hashIp(ip, pepper)}`;
    if (
      !consumeRate(
        deps.db,
        ipBucket,
        "register",
        deps.config.registerPerDay,
      )
    ) {
      throw new HttpError(429, "rate_limited", "too many registrations from this address");
    }
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

  app.get(
    "/claim/:token",
    { logLevel: "silent", exposeHeadRoute: false },
    async (req, reply) => {
      if (!workos || !deps.config.workos) {
        return authPage(
          reply,
          503,
          "Claiming unavailable",
          "Account claiming is not configured on this server.",
        );
      }
      const { token } = req.params as { token: string };
      if (!CLAIM_TOKEN_RE.test(token)) {
        return invalidClaimPage(reply);
      }
      const user = findUserByClaimToken(deps.db, token);
      if (!user) return invalidClaimPage(reply);

      setClaimConfirmationCookie(reply, deps.config, hashApiKey(token));
      return claimConfirmationPage(reply);
    },
  );

  app.post(
    "/claim/:token",
    { logLevel: "silent" },
    async (req, reply) => {
      const confirmation = req.cookies[claimCookieName(deps.config, CLAIM_CONFIRM_COOKIE)];
      clearClaimConfirmationCookie(reply, deps.config);
      if (!workos || !deps.config.workos) {
        return authPage(
          reply,
          503,
          "Claiming unavailable",
          "Account claiming is not configured on this server.",
        );
      }
      const { token } = req.params as { token: string };
      if (!CLAIM_TOKEN_RE.test(token)) {
        return invalidClaimPage(reply);
      }
      const user = findUserByClaimToken(deps.db, token);
      if (!user) return invalidClaimPage(reply);

      if (confirmation !== hashApiKey(token)) {
        return authPage(
          reply,
          400,
          "Confirmation expired",
          "Open the claim link and confirm again before signing in.",
        );
      }
      if (!consumeRate(deps.db, `user:${user.id}`, "claim", CLAIM_STARTS_PER_HOUR)) {
        return authPage(
          reply,
          429,
          "Too many sign-in attempts",
          "Wait before opening the claim link and trying again.",
        );
      }

      try {
        const authorization = await workos.userManagement.getAuthorizationUrlWithPKCE({
          clientId: deps.config.workos.clientId,
          provider: "authkit",
          redirectUri: deps.config.workos.redirectUri,
          screenHint: "sign-up",
        });
        const browserNonce = randomBytes(32).toString("base64url");
        createClaimAuthFlow(deps.db, {
          state: authorization.state,
          browserNonce,
          userId: user.id,
          codeVerifier: authorization.codeVerifier,
        });
        setClaimCallbackCookie(reply, deps.config, browserNonce);
        reply.header("Cache-Control", "no-store");
        reply.header("Referrer-Policy", "no-referrer");
        return reply.redirect(authorization.url, 302);
      } catch (err) {
        app.log.error({ err }, "could not start WorkOS account claim");
        return authPage(
          reply,
          502,
          "Sign-in unavailable",
          "WorkOS could not start sign-in. Open the claim link and try again.",
        );
      }
    },
  );

  app.get(
    WORKOS_CALLBACK_PATH,
    { logLevel: "silent" },
    async (req, reply) => {
      const browserNonce = req.cookies[claimCookieName(deps.config, CLAIM_CALLBACK_COOKIE)];
      clearClaimCallbackCookie(reply, deps.config);
      if (!workos || !deps.config.workos) {
        return authPage(
          reply,
          503,
          "Claiming unavailable",
          "Account claiming is not configured on this server.",
        );
      }
      const query = req.query as Record<string, unknown>;
      if (typeof query.error === "string") {
        if (
          typeof query.state === "string" &&
          typeof browserNonce === "string" &&
          BROWSER_NONCE_RE.test(browserNonce)
        ) {
          deleteClaimAuthFlow(deps.db, query.state, browserNonce);
        }
        return authPage(
          reply,
          400,
          "Sign-in cancelled",
          "Open the claim link again when you are ready to retry.",
        );
      }
      if (
        typeof query.code !== "string" ||
        typeof query.state !== "string" ||
        typeof browserNonce !== "string" ||
        !BROWSER_NONCE_RE.test(browserNonce)
      ) {
        return invalidClaimAttemptPage(reply);
      }
      const flow = getClaimAuthFlow(deps.db, query.state, browserNonce);
      if (!flow) return invalidClaimAttemptPage(reply);

      let authentication: Awaited<
        ReturnType<WorkOSAuthClient["userManagement"]["authenticateWithCode"]>
      >;
      try {
        authentication = await workos.userManagement.authenticateWithCode({
          clientId: deps.config.workos.clientId,
          code: query.code,
          codeVerifier: flow.code_verifier,
          ipAddress: requestIp(req),
          userAgent: req.headers["user-agent"],
        });
      } catch (err) {
        deleteClaimAuthFlow(deps.db, query.state, browserNonce);
        app.log.error({ err }, "WorkOS account claim failed");
        return authPage(
          reply,
          502,
          "Sign-in failed",
          "WorkOS could not complete sign-in. Open the claim link and try again.",
        );
      }

      const authenticatedTier = tierForAuthenticationMethod(
        authentication.authenticationMethod,
      );
      if (!authenticatedTier || !authentication.user.emailVerified) {
        deleteClaimAuthFlow(deps.db, query.state, browserNonce);
        return authPage(
          reply,
          403,
          "Login method not supported",
          "Use an email code, GitHub, or Google to claim this account.",
        );
      }

      try {
        const user = completeClaim(deps.db, {
          state: query.state,
          browserNonce,
          workosUserId: authentication.user.id,
          email: authentication.user.email,
          authenticatedTier,
        });
        return authPage(
          reply,
          200,
          "Account claimed",
          `The agent's existing API key now has ${user.tier} limits.`,
        );
      } catch (err) {
        deleteClaimAuthFlow(deps.db, query.state, browserNonce);
        if (err instanceof ClaimStateError) return invalidClaimAttemptPage(reply);
        if (err instanceof ClaimIdentityConflictError) {
          return authPage(
            reply,
            409,
            "Account already exists",
            "That login belongs to another account, so this agent account was not changed.",
          );
        }
        throw err;
      }
    },
  );

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
    const site = await publishNewSite(ctx, key, user, body, req);
    return reply.status(201).send(site);
  });

  app.put("/api/v1/sites/:id", async (req, reply) => {
    const { key, user } = requireAccount(deps.db, req);
    const { id } = req.params as { id: string };
    const body = updateSiteSchema.parse(req.body);
    const existing = getSite(deps.db, id);
    if (!existing || existing.owner_user_id !== user.id) {
      return reply.status(404).send({
        error: { code: "not_found", message: "site not found" },
      });
    }
    const site = await publishVersion(ctx, existing, user, body, req);
    return reply.send(site);
  });

  app.post("/api/v1/sites/:id/touch", async (req, reply) => {
    const { user } = requireAccount(deps.db, req);
    const { id } = req.params as { id: string };
    const existing = getSite(deps.db, id);
    if (!existing || existing.owner_user_id !== user.id) {
      return reply.status(404).send({
        error: { code: "not_found", message: "site not found" },
      });
    }
    if (isExpired(existing)) {
      throw new HttpError(410, "site_expired", "site expired");
    }
    consumePublishQuota(ctx, req, user);
    const policy = policyForUser(user, ctx.config);
    const now = Date.now();
    let expiresAt: number | null;
    if (existing.expires_at === null && policy.allowNullTtl) {
      expiresAt = null;
    } else if (policy.maxTtl === null) {
      expiresAt = existing.expires_at;
    } else {
      expiresAt = resolveTierExpiry(policy, policy.maxTtl, now, "explicit");
    }
    updateSiteExpiry(deps.db, id, expiresAt, now);
    applyStoredTierLimits(deps.db, existing, policy);
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
      if (RESERVED_HOST_LABELS.has(label)) {
        // Never a site (slugs cannot claim these), so send www and friends
        // to the same path on the API host rather than 404 them as missing
        // sites. Fastify gives a path-form url here; Node already 400s
        // authority-form targets.
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

function createWorkOSAuthClient(config: Config): WorkOSAuthClient | null {
  if (!config.workos) return null;
  const client = createWorkOS({
    apiKey: config.workos.apiKey,
    clientId: config.workos.clientId,
  });
  return {
    userManagement: {
      getAuthorizationUrlWithPKCE: (options) =>
        client.userManagement.getAuthorizationUrlWithPKCE(options),
      authenticateWithCode: async (options) => {
        const result = await client.userManagement.authenticateWithCode(options);
        return {
          user: {
            id: result.user.id,
            email: result.user.email,
            emailVerified: result.user.emailVerified,
          },
          authenticationMethod: result.authenticationMethod,
        };
      },
    },
  };
}

function invalidClaimPage(reply: FastifyReply): FastifyReply {
  return authPage(
    reply,
    404,
    "Claim link not found",
    "This claim link is invalid or has already been used.",
  );
}

function invalidClaimAttemptPage(reply: FastifyReply): FastifyReply {
  return authPage(
    reply,
    400,
    "Sign-in expired",
    "This sign-in attempt is invalid or expired. Open the claim link again.",
  );
}

function authPage(
  reply: FastifyReply,
  statusCode: number,
  title: string,
  message: string,
): FastifyReply {
  setAuthPageHeaders(reply, false);
  reply.type("text/html; charset=utf-8");
  return reply.status(statusCode).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · shareplan</title>
  <style>
    :root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 34rem; margin: 5rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { font-size: 1.5rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`);
}

function claimConfirmationPage(reply: FastifyReply): FastifyReply {
  setAuthPageHeaders(reply, true);
  reply.type("text/html; charset=utf-8");
  return reply.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claim this agent account · shareplan</title>
  <style>
    :root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 34rem; margin: 5rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { font-size: 1.5rem; }
    button { font: inherit; padding: 0.65rem 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Claim this agent account?</h1>
  <p>Signing in links your verified identity to this agent account and raises its limits.</p>
  <p>The agent's existing API key will keep access. Continue only if you intended to claim this account and trust whoever gave you the link.</p>
  <form method="post"><button type="submit">Continue to sign in</button></form>
</body>
</html>`);
}

function setAuthPageHeaders(reply: FastifyReply, allowForm: boolean): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action ${allowForm ? "'self'" : "'none'"}; frame-ancestors 'none'`,
  );
}

function claimCookieName(config: Config, name: string): string {
  return new URL(config.publicBaseUrl).protocol === "https:" ? `__Host-${name}` : name;
}

function claimCookiesAreSecure(config: Config): boolean {
  return new URL(config.publicBaseUrl).protocol === "https:";
}

function setClaimConfirmationCookie(
  reply: FastifyReply,
  config: Config,
  tokenHash: string,
): void {
  reply.setCookie(claimCookieName(config, CLAIM_CONFIRM_COOKIE), tokenHash, {
    httpOnly: true,
    sameSite: "strict",
    secure: claimCookiesAreSecure(config),
    path: "/",
    maxAge: CLAIM_CONFIRM_MAX_AGE_SECONDS,
  });
}

function clearClaimConfirmationCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(claimCookieName(config, CLAIM_CONFIRM_COOKIE), {
    httpOnly: true,
    sameSite: "strict",
    secure: claimCookiesAreSecure(config),
    path: "/",
  });
}

function setClaimCallbackCookie(
  reply: FastifyReply,
  config: Config,
  browserNonce: string,
): void {
  reply.setCookie(claimCookieName(config, CLAIM_CALLBACK_COOKIE), browserNonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: claimCookiesAreSecure(config),
    path: "/",
    maxAge: CLAIM_CALLBACK_MAX_AGE_SECONDS,
  });
}

function clearClaimCallbackCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(claimCookieName(config, CLAIM_CALLBACK_COOKIE), {
    httpOnly: true,
    sameSite: "lax",
    secure: claimCookiesAreSecure(config),
    path: "/",
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function policyForUser(user: UserRow, config: Config): TierPolicy {
  const policy = policyFor(user.tier);
  if (user.tier === "ops" && config.defaultTtl) {
    return { ...policy, defaultTtl: config.defaultTtl };
  }
  return policy;
}

function consumePublishQuota(ctx: Ctx, req: FastifyRequest, user: UserRow): void {
  const policy = policyForUser(user, ctx.config);
  if (policy.ipPublishLimit) {
    const pepper = ctx.config.ipHashPepper;
    if (!pepper) {
      throw new AuthError(
        503,
        "rate_limit_unconfigured",
        "SHAREPLAN_IP_HASH_PEPPER is not set",
      );
    }
    const ip = requestIp(req);
    const ipBucket = `ip:${hashIp(ip, pepper)}`;
    if (!consumeRate(ctx.db, ipBucket, "publish", policy.publishPerHour)) {
      throw new HttpError(429, "rate_limited", "too many publishes from this address");
    }
  }
  const userBucket = `user:${user.id}`;
  if (!consumeRate(ctx.db, userBucket, "publish", policy.publishPerHour)) {
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

/** Drop stored slug/public that the current tier is not allowed to keep. */
function applyStoredTierLimits(
  db: Ctx["db"],
  existing: SiteRow,
  policy: TierPolicy,
): void {
  if (!policy.slugs && existing.slug !== null) {
    updateSiteSlug(db, existing.id, null);
  }
  if (!policy.publicVisibility && existing.visibility === "public") {
    db.prepare(`UPDATE sites SET visibility = 'unlisted' WHERE id = ?`).run(existing.id);
  }
}

async function publishNewSite(
  ctx: Ctx,
  key: ApiKeyRow,
  user: UserRow,
  body: z.infer<typeof createSiteSchema>,
  req: FastifyRequest,
): Promise<SiteResponse> {
  assertTierPublish(user, body);
  consumePublishQuota(ctx, req, user);
  const policy = policyForUser(user, ctx.config);
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
  req: FastifyRequest,
): Promise<SiteResponse> {
  assertTierPublish(user, body);
  consumePublishQuota(ctx, req, user);
  const policy = policyForUser(user, ctx.config);
  let files = prepareFiles(body.files, ctx.config);
  files = ensureIndexHtml(files);

  const versionId = createVersionId();
  const now = Date.now();

  // An explicit ttl always wins (including `null` to clear it, if the tier
  // allows). Otherwise keep the stored expiry if this tier still allows it.
  const expires_at =
    body.ttl !== undefined
      ? resolveTierExpiry(policy, body.ttl, now, "explicit")
      : clampStoredExpiry(policy, existing.expires_at, now);

  // Checked up front so a taken slug fails before we upload anything, but only
  // written once the upload lands — a failed publish must not move the slug.
  const newSlug =
    body.slug !== undefined && body.slug !== existing.slug ? body.slug : null;
  if (newSlug !== null) {
    assertSlugAvailable(ctx, newSlug, existing.id);
  }
  const dropSlug = !policy.slugs && existing.slug !== null;

  const byte_size = files.reduce((n, f) => n + f.body.byteLength, 0);
  const file_count = files.length;
  let visibility = body.visibility ?? existing.visibility;
  if (visibility === "public" && !policy.publicVisibility) {
    visibility = "unlisted";
  }

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
  } else if (dropSlug) {
    updateSiteSlug(ctx.db, existing.id, null);
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
  if (RESERVED_HOST_LABELS.has(slug)) {
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
  } else if (ct.startsWith("image/svg") || path.toLowerCase().endsWith(".svg")) {
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox",
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
    url: siteUrl(config, row.slug ?? row.id),
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
    url: siteUrl(config, row.slug ?? row.id),
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
