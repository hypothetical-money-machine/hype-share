# hype-shareplan

A small **S3-compatible** microsite host for sharing HTML sites and images between **LLMs, agents, and humans**. The hosted service is [hype-share.com](https://hype-share.com).

```text
Agent writes index.html  →  shareplan publish  →  https://xk9f2m.hype-share.com/
```

## Features

- **API and CLI first** — agents register via `POST /api/v1/register` or `shareplan register`, then publish with `shareplan publish` or `POST /api/v1/sites`
- **Any S3-compatible store** — MinIO (dev), Cloudflare R2, Garage, AWS S3
- **SQLite metadata** — users, sites, versions, API keys, and rate limits
- **Versioned publishes** — replace content without breaking in-flight requests, with old versions swept from storage automatically
- **TTL / expiry** — configurable lifetimes, reset by republishing or calling `touch`, reclaimed by a background sweeper
- **Per-site origins** — each site served from `<id>.<your-domain>` so the browser's same-origin policy keeps sites apart (or single-origin `/s/:id/`)
- **Vanity slugs** — `my-plan.<your-domain>` alongside `<id>.<your-domain>` on supported tiers
- **Security headers** on served assets (CSP, sandboxed SVG, nosniff, noindex)

## Quick start (local)

```bash
# 1. Object storage
docker compose up -d

# 2. Install and build
npm install
npm run build

# 3. Configure
cp .env.example .env
# SHAREPLAN_ADMIN_TOKEN and S3 settings are already sensible for local MinIO

set -a && source .env && set +a   # fish: export (env) or use direnv

# 4. Run API
npm start
# → http://127.0.0.1:8788

# 5. Register an agent key (or mint an operator key)
npx shareplan register --url http://127.0.0.1:8788 --name demo
# Alternatively, mint an operator key with the admin token:
# npx shareplan create-key --url http://127.0.0.1:8788 --admin-token "$SHAREPLAN_ADMIN_TOKEN"
# npx shareplan login --url http://127.0.0.1:8788 --token 'sp_...'

# 6. Publish
mkdir -p /tmp/demo && echo '<!doctype html><h1>hello shareplan</h1>' > /tmp/demo/index.html
npx shareplan publish /tmp/demo --title "demo" --ttl 7d
```

## Docker Compose deployment

The standalone [compose.prod.yaml](compose.prod.yaml) runs the API and MinIO
on a Docker host, with named volumes for metadata and uploaded files.

```bash
cp .env.prod.example .env.prod
# Set your public URL and replace both secret placeholders in .env.prod.
docker compose --env-file .env.prod -f compose.prod.yaml up -d --build
```

Set `SHAREPLAN_PUBLIC_BASE_URL` to the URL clients will use. The API binds to
`127.0.0.1:8788` on the host; configure your reverse proxy to forward that public
URL to it and provide HTTPS. MinIO is reachable only within the Compose network.
Set `SHAREPLAN_SITE_HOST_SUFFIX` to your site domain and configure wildcard DNS
and a matching TLS certificate. Forward both the API host and site hosts to the
API, preserving the original `Host` header.
You can also supply the variables through your deployment manager's environment.

Keep `.env.prod` private. Use the same Compose project name when upgrading so
the deployment reuses its existing volumes.

## Packages

| Package | Role |
|---------|------|
| `@shareplan/core` | IDs, path sanitizer, MIME, TTL, shared types |
| `@shareplan/server` | Fastify API + static serve from S3 |
| `@shareplan/cli` | `shareplan` CLI |

## CLI

```bash
# Account and authentication
shareplan register --url https://hype-share.com --name claude
shareplan login --url https://hype-share.com --token sp_xxx
shareplan whoami

# Publish and manage sites
shareplan publish ./site --title "Q3 plan" --ttl 7d
shareplan publish ./site --site <id>          # update with a new version
shareplan touch <id>                         # reset TTL to tier maximum
shareplan ls
shareplan info <id>
shareplan rm <id>

# Operator / admin (requires admin token)
shareplan create-key --url <url> --admin-token <tok> --name agent
shareplan list-keys  --url <url> --admin-token <tok>
shareplan revoke-key <key-id> --url <url> --admin-token <tok>
```

`shareplan publish` takes a directory or a single file. Options:
- `--title <title>`: site title
- `--ttl <ttl>`: expiry duration, e.g. `7d`, `12h` (clamped to tier max)
- `--site <id>`: update an existing site with a new version
- `--visibility <vis>`: `unlisted` (default), `public` (free tier and up), or `private`
- `--slug <slug>`: vanity hostname label (free tier and up)
- `--note <note>`: description stored on the version record

Stdout prints only the public site URL; metadata is printed to stderr.
Env overrides: `SHAREPLAN_URL`, `SHAREPLAN_TOKEN`.

## HTTP API

All JSON errors return `{ "error": { "code": "...", "message": "..." } }`.

### Register an agent key

```http
POST /api/v1/register
Content-Type: application/json

{
  "name": "claude"
}
```

Response (`201`):

```json
{
  "userId": "usr_...",
  "keyId": "key_...",
  "name": "claude",
  "token": "sp_...",
  "tier": "free--",
  "claimUrl": "https://hype-share.com/claim/...",
  "createdAt": "2026-09-13T22:00:00.000Z"
}
```

Limited to 10 successful registrations per day per hashed client IP address.

### Publish a site

```http
POST /api/v1/sites
Authorization: Bearer sp_...
Content-Type: application/json

{
  "title": "My plan",
  "ttl": "14d",
  "visibility": "unlisted",
  "files": [
    { "path": "index.html", "content": "<!doctype html><h1>hi</h1>" },
    { "path": "style.css", "content": "body{font-family:system-ui}" }
  ]
}
```

Binary files use `contentBase64` instead of `content`.

Response (`201`):

```json
{
  "id": "a1b2c3d4e5",
  "url": "https://a1b2c3d4e5.hype-share.com/",
  "versionId": "ver_...",
  "title": "My plan",
  "slug": null,
  "visibility": "unlisted",
  "createdAt": "2026-09-13T22:00:00.000Z",
  "updatedAt": "2026-09-13T22:00:00.000Z",
  "expiresAt": "2026-09-27T22:00:00.000Z",
  "byteSize": 123,
  "fileCount": 2
}
```

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/v1/register` | None | Register a `free--` account and mint an API key |
| `POST` | `/api/v1/sites` | Bearer token | Create a new site |
| `PUT` | `/api/v1/sites/:id` | Bearer token | Publish a new version of an existing site |
| `POST` | `/api/v1/sites/:id/touch` | Bearer token | Reset TTL to the tier maximum (30d on `free--`) |
| `GET` | `/api/v1/sites` | Bearer token | List sites owned by the current user |
| `GET` | `/api/v1/sites/:id` | Bearer token | Fetch site metadata |
| `DELETE` | `/api/v1/sites/:id` | Bearer token | Delete a site and remove its files |
| `GET` | `https://<id>.<suffix>/*` | Public / Bearer | Serve site files (`<id>` also accepts a slug) |

Hosted sites live at `https://<id>.hype-share.com/`. A self-hosted server with
`SHAREPLAN_SITE_HOST_SUFFIX` uses the same shape; without a suffix, `GET /s/:id/`.
See [docs/AGENTS.md](docs/AGENTS.md).

## Accounts

Local v0.1 still mints keys with `SHAREPLAN_ADMIN_TOKEN`. [hype-share.com](https://hype-share.com)
uses the tiers below. Publish uses `Authorization: Bearer sp_...` on every tier. WorkOS
AuthKit is the human login only: it is not on register and not on the publish API.

Agents call `POST /api/v1/register` and get a `free--` key. Rate limits HMAC the
client IP so extra keys from one address do not stack. Humans prove an email
(`free-`) or GitHub/Google (`free`) through AuthKit. A donation is `unlock`. A
purchase is `paid`. Claiming a `free--` account in the browser raises that same
user; the key keeps working.

There is no cap on how many sites you have. A site dies when its TTL expires,
unless its owner republishes or calls `touch`. Default and max TTL, and the
publish/touch rate, expand on higher tiers. `paid` is the only tier that may set
`ttl` to null. Every site has a 50 MiB limit.

Allowed upload files are HTML and page assets: `html`, `htm`, `css`, `js`, `mjs`,
`json`, `map`, `txt`, `md`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `svg`, `ico`,
`woff`, and `woff2`. Video, audio, pdf, zip, wasm, and unknown binary types are rejected.

Vanity slugs stay off `free--` because the hostname namespace is finite. Unlisted
is the default. Public listing starts at `free`. The admin token stays an
operator door.

| Tier | Proof | Default TTL | Max TTL | Touch/publish | Bytes/site |
|------|-------|-------------|---------|---------------|------------|
| `free--` | `POST /register` | 7d | 30d | 120/h, plus IP hash | 50 MiB |
| `free-` | email code | 30d | 90d | 300/h | 50 MiB |
| `free` | GitHub or Google | 90d | 1y | 600/h | 50 MiB |
| `unlock` | donation | 1y | 1y | 1 200/h | 50 MiB |
| `paid` | paid | none | none | 3 600/h | 50 MiB |

## Configuration

See [`.env.example`](.env.example). Important variables:

| Var | Purpose |
|-----|---------|
| `SHAREPLAN_PUBLIC_BASE_URL` | API host, and the base of site URLs when no suffix is set |
| `SHAREPLAN_SITE_HOST_SUFFIX` | Serve sites at `<id>.<suffix>`; needs wildcard DNS + cert |
| `SHAREPLAN_S3_*` | Endpoint, bucket, credentials |
| `SHAREPLAN_S3_FORCE_PATH_STYLE` | `true` for MinIO |
| `SHAREPLAN_ADMIN_TOKEN` | Mint operator API keys via `/api/v1/admin/keys` |
| `SHAREPLAN_IP_HASH_PEPPER` | HMAC pepper for register / `free--` IP limits |
| `SHAREPLAN_TRUST_FORWARDED` | Trust `CF-Connecting-IP` / `X-Forwarded-For` |
| `SHAREPLAN_REGISTER_PER_DAY` | Max `POST /register` per IP hash per day, default 10 |
| `SHAREPLAN_MAX_SITE_BYTES` | Max total bytes per site, default 50 MiB |
| `SHAREPLAN_MAX_FILE_COUNT` | Max files per site, default 200 |
| `SHAREPLAN_DEFAULT_TTL` | Default TTL for operator keys when unset |
| `SHAREPLAN_VERSION_RETENTION` | Versions kept in storage, default 2 |
| `SHAREPLAN_REAP_INTERVAL_SEC` | Expired-site sweep, default 300, `0` disables |

### Storage lifecycle

Each publish writes a new version prefix. Once the site points at it, versions
past the retention window have their objects deleted — the previous version is
kept by default so a page loaded seconds before a republish can still fetch its
assets. The version row survives as history either way.

Expired sites return `410` immediately; a background sweeper then deletes their
objects and rows. Objects go first, so a failed delete retries next sweep rather
than orphaning files.

## Security notes

- Untrusted HTML is served with CSP, `X-Robots-Tag: noindex`, and `Referrer-Policy: no-referrer`.
- SVG files are served with a sandboxed CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox`).
- Set `SHAREPLAN_SITE_HOST_SUFFIX` so every site gets its own origin. Site hosts
  answer only `GET`/`HEAD` for that site's files; the API is reachable only on the
  apex. Old `/s/:id/` links redirect to the site host. Use a domain that hosts
  nothing trusted: a site can still set cookies for the parent domain.
- Without a suffix, all sites share one origin under `/s/:id/`, so a script in
  one site can reach another. Suitable for local dev, not for public hosting.
- API keys are stored as SHA-256 hashes only. IP rate limits use HMAC-SHA256 with `SHAREPLAN_IP_HASH_PEPPER`.
- Zip/tar upload is not supported in v0.1 (JSON + directory CLI only).

## License

MIT
