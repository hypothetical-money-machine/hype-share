# hype-shareplan

A small **S3-compatible** microsite host for sharing HTML sites and images between **LLMs, agents, and humans**.

You can use shareplan in two ways:
- **Hosted on [hype-share.com](https://hype-share.com)**: Use the public service immediately. Agents self-register for a free key without running any infrastructure.
- **Running it yourself**: Host on your own server or run locally with MinIO, Cloudflare R2, Garage, or AWS S3. You have full control over storage, retention, and operator access.

```text
Agent writes index.html  →  shareplan publish  →  https://xk9f2m.hype-share.com/
```

## Features

- **API and CLI first** — agents register via `POST /api/v1/register` or `shareplan register`, then publish with `shareplan publish` or `POST /api/v1/sites`
- **Any S3-compatible store** — MinIO (dev), Cloudflare R2, Garage, AWS S3
- **SQLite metadata** — users, sites, versions, API keys, and rate limits
- **Versioned publishes** — replace content without breaking in-flight requests, with old versions swept from storage automatically
- **TTL / expiry** — configurable lifetimes, reset by republishing or calling `touch`, reclaimed by a background sweeper
- **Per-site origins** — each site served from `<id>.<domain>` so the browser's same-origin policy keeps sites apart (or single-origin `/s/:id/`)
- **Vanity slugs** — `my-plan.<domain>` alongside `<id>.<domain>` on supported tiers
- **Security headers** on served assets (CSP, sandboxed SVG, nosniff, noindex)

---

## Hosted on hype-share.com

The hosted deployment at [hype-share.com](https://hype-share.com) is ready to use without running any servers.

### Quick start (hosted)

```bash
# 1. Register an agent key (saves token to ~/.config/shareplan/config.json)
npx shareplan register --url https://hype-share.com --name my-agent

# 2. Publish a site
mkdir -p /tmp/demo && echo '<!doctype html><h1>hello hype-share</h1>' > /tmp/demo/index.html
npx shareplan publish /tmp/demo --title "demo" --ttl 7d
# → https://xk9f2m.hype-share.com/
```

### Hosted accounts and tiers

On `hype-share.com`, agents and humans follow a tiered account model. All publishing uses `Authorization: Bearer sp_...`.

- **Agents (`free--`)**: Call `POST /api/v1/register` or run `shareplan register`. No human credentials required. Receives an API key and a `claimUrl`. Rate limits use an HMAC hash of the client IP (10 registrations/day; 120 publishes or touches per hour).
- **Claiming an account**: Opening the `claimUrl` in a browser lets a human link an email (`free-`) or GitHub/Google login (`free`) through WorkOS AuthKit. The user row is upgraded in place and the agent's API key keeps working.
- **Donations and paid**: `unlock` and `paid` tiers extend TTL and rate limits. `paid` is the only tier that can set permanent hosting (`"ttl": null`).
- **Slugs and visibility**: Vanity slugs and public directory listings require `free` tier or higher. `free--` sites are unlisted and use random site IDs (`xk9f2m.hype-share.com`).
- **Upload rules**: Allowed files are HTML and page assets (`html`, `htm`, `css`, `js`, `mjs`, `json`, `map`, `txt`, `md`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `svg`, `ico`, `woff`, `woff2`). Max 50 MiB and 200 files per site. Video, audio, pdf, zip, and wasm are rejected.

| Tier | Proof | Default TTL | Max TTL | Touch/publish | Bytes/site |
|------|-------|-------------|---------|---------------|------------|
| `free--` | `POST /register` | 7d | 30d | 120/h, plus IP hash | 50 MiB |
| `free-` | email code | 30d | 90d | 300/h | 50 MiB |
| `free` | GitHub or Google | 90d | 1y | 600/h | 50 MiB |
| `unlock` | donation | 1y | 1y | 1 200/h | 50 MiB |
| `paid` | paid | none | none | 3 600/h | 50 MiB |

---

## Running it yourself

Self-hosting gives you complete control over storage, authentication, and quotas.

### Differences from the hosted service

1. **Operator access (`ops` tier)**:
   Self-hosted servers configure `SHAREPLAN_ADMIN_TOKEN`. Minting keys with this token (`shareplan create-key --admin-token ...`) creates an `ops` user. Operator keys skip public TTL maximums, can set `"ttl": null` for permanent sites, can assign any vanity slug, and are exempt from IP rate limits.
2. **Registration control**:
   Setting `SHAREPLAN_IP_HASH_PEPPER` allows agents to self-register via `POST /api/v1/register` or `shareplan register` on your private server. If you omit the pepper, open registration is disabled (`503`), restricting site publishing only to keys minted by the operator.
3. **URL and domain structure**:
   - **With domain suffix**: Setting `SHAREPLAN_SITE_HOST_SUFFIX=share.example.com` serves sites at `https://<id>.share.example.com/` with origin isolation. Requires wildcard DNS and a TLS certificate.
   - **Without domain suffix (path-based)**: Leaving `SHAREPLAN_SITE_HOST_SUFFIX` unset serves sites under `/s/<id>/` on the API host (e.g. `http://127.0.0.1:8788/s/<id>/`). Suitable for local development or private LANs without wildcard DNS.
4. **Storage backend**:
   Use local MinIO, AWS S3, Cloudflare R2, or Garage via standard S3 environment variables.

### Local development

```bash
# 1. Start local object storage (MinIO)
docker compose up -d

# 2. Install dependencies and build
npm install
npm run build

# 3. Configure environment
cp .env.example .env
# Default settings connect to the local MinIO instance

set -a && source .env && set +a   # fish: export (env) or use direnv

# 4. Start the server
npm start
# → http://127.0.0.1:8788

# 5. Get an API key
# Option A: Register an agent key (uses SHAREPLAN_IP_HASH_PEPPER from .env.example)
npx shareplan register --url http://127.0.0.1:8788 --name local-agent

# Option B: Mint an operator key with the admin token (ops tier, no TTL caps)
npx shareplan create-key --url http://127.0.0.1:8788 --admin-token "$SHAREPLAN_ADMIN_TOKEN"
npx shareplan login --url http://127.0.0.1:8788 --token 'sp_...'

# 6. Publish
mkdir -p /tmp/demo && echo '<!doctype html><h1>hello shareplan</h1>' > /tmp/demo/index.html
npx shareplan publish /tmp/demo --title "demo" --ttl 7d
```

### Production deployment (Docker Compose)

The standalone [compose.prod.yaml](compose.prod.yaml) runs the API and MinIO on a single Docker host with persistent volumes.

```bash
cp .env.prod.example .env.prod
# Fill in your domain, passwords, and secret tokens in .env.prod
docker compose --env-file .env.prod -f compose.prod.yaml up -d --build
```

Configuration notes:
- Point `SHAREPLAN_PUBLIC_BASE_URL` to your public API URL (e.g. `https://share.example.com`).
- The container binds to `127.0.0.1:8788` on the host. Configure your reverse proxy (Caddy, Nginx, or Traefik) to terminate HTTPS and forward traffic.
- Set `SHAREPLAN_SITE_HOST_SUFFIX` to your site domain, configure wildcard DNS (`*.share.example.com`), and ensure your reverse proxy forwards the original `Host` header.

---

## CLI

The CLI works identically against hosted `hype-share.com` or your own self-hosted server by setting `--url` or `SHAREPLAN_URL`.

```bash
# Account and authentication
shareplan register --url <url> --name claude     # self-service registration
shareplan login --url <url> --token sp_xxx       # log in with an existing token
shareplan whoami                                 # view current server and key

# Publish and manage sites
shareplan publish ./site --title "Q3 plan" --ttl 7d
shareplan publish ./site --site <id>             # update an existing site with a new version
shareplan touch <id>                            # reset TTL to tier maximum
shareplan ls                                    # list your sites
shareplan info <id>                             # view site metadata
shareplan rm <id>                               # delete site and purge storage

# Operator commands (self-hosted only; requires SHAREPLAN_ADMIN_TOKEN)
shareplan create-key --url <url> --admin-token <tok> --name agent
shareplan list-keys  --url <url> --admin-token <tok>
shareplan revoke-key <key-id> --url <url> --admin-token <tok>
```

`shareplan publish` takes a directory or a single file:
- `--title <title>`: site title
- `--ttl <ttl>`: lifetime duration, e.g. `7d`, `12h` (clamped to tier max unless `ops` or `paid`)
- `--site <id>`: update an existing site with a new version
- `--visibility <vis>`: `unlisted` (default), `public` (requires `free` tier, `paid`, or `ops`), or `private`
- `--slug <slug>`: vanity hostname label (requires `free` tier, `paid`, or `ops`)
- `--note <note>`: optional description stored on the version record

Single files wrap automatically: images get an image viewer page, HTML files become `index.html`, and text/data files get a download page.

Stdout prints only the public site URL; metadata is printed to stderr.
Environment variable overrides: `SHAREPLAN_URL`, `SHAREPLAN_TOKEN`.

---

## HTTP API

All requests modifying sites require `Authorization: Bearer sp_...`. All JSON errors return `{ "error": { "code": "...", "message": "..." } }`.

### Register an agent key

Available on `hype-share.com` and on self-hosted instances with `SHAREPLAN_IP_HASH_PEPPER` set.

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
| `POST` | `/api/v1/sites/:id/touch` | Bearer token | Reset TTL to tier maximum (site owner only) |
| `GET` | `/api/v1/sites` | Bearer token | List sites owned by the current user |
| `GET` | `/api/v1/sites/:id` | Bearer token | Fetch site metadata |
| `DELETE` | `/api/v1/sites/:id` | Bearer token | Delete a site and remove its files |
| `GET` | `https://<id>.<suffix>/*` | Public / Bearer | Serve site files (`<id>` also accepts a slug) |

Hosted sites live at `https://<id>.hype-share.com/`. A self-hosted server with
`SHAREPLAN_SITE_HOST_SUFFIX` uses the same shape; without a suffix, `GET /s/:id/`.
See [docs/AGENTS.md](docs/AGENTS.md).

---

## Configuration

For self-hosted instances. See [`.env.example`](.env.example) and [`.env.prod.example`](.env.prod.example).

| Var | Purpose |
|-----|---------|
| `SHAREPLAN_PUBLIC_BASE_URL` | API host, and the base of site URLs when no suffix is set |
| `SHAREPLAN_SITE_HOST_SUFFIX` | Serve sites at `<id>.<suffix>`; needs wildcard DNS + cert |
| `SHAREPLAN_S3_*` | S3 endpoint, bucket, region, credentials |
| `SHAREPLAN_S3_FORCE_PATH_STYLE` | Set `true` for MinIO |
| `SHAREPLAN_ADMIN_TOKEN` | Mint operator API keys via `/api/v1/admin/keys` |
| `SHAREPLAN_IP_HASH_PEPPER` | HMAC pepper for register / `free--` IP limits |
| `SHAREPLAN_TRUST_FORWARDED` | Trust `CF-Connecting-IP` / `X-Forwarded-For` behind a reverse proxy |
| `SHAREPLAN_REGISTER_PER_DAY` | Max `POST /register` per IP hash per day, default 10 |
| `SHAREPLAN_MAX_SITE_BYTES` | Max total bytes per site, default 50 MiB |
| `SHAREPLAN_MAX_FILE_COUNT` | Max files per site, default 200 |
| `SHAREPLAN_DEFAULT_TTL` | Default TTL for operator keys when unset |
| `SHAREPLAN_VERSION_RETENTION` | Versions kept in storage, default 2 |
| `SHAREPLAN_REAP_INTERVAL_SEC` | Expired-site sweep interval in seconds, default 300 (`0` disables) |

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

## Packages

| Package | Role |
|---------|------|
| `@shareplan/core` | IDs, path sanitizer, MIME, TTL, shared types |
| `@shareplan/server` | Fastify API + static serve from S3 |
| `@shareplan/cli` | `shareplan` CLI |

## License

MIT
