# hype-shareplan

A small **S3-compatible** microsite host for sharing HTML sites, images, and videos between **LLMs, agents, and humans**.

```text
Agent writes index.html  →  shareplan publish  →  https://share.example.com/s/xk9f2m/
```

## Features (v0.1)

- **API + CLI first** — agents publish with `shareplan publish` or `POST /api/v1/sites`
- **Any S3-compatible store** — MinIO (dev), Cloudflare R2, Garage, AWS S3
- **SQLite metadata** — sites, versions, API keys
- **Versioned publishes** — replace content without breaking mid-upload, with
  old versions swept from storage automatically
- **TTL / expiry** — optional `7d`-style lifetimes, reclaimed by a background sweeper
- **Vanity slugs** — `/s/my-plan/` alongside `/s/xk9f2m/`
- **Security headers** on served HTML (CSP, nosniff, noindex)

## Quick start (local)

```bash
# 1. Object storage
docker compose up -d

# 2. Install & build
npm install
npm run build

# 3. Configure
cp .env.example .env
# SHAREPLAN_ADMIN_TOKEN and S3 settings are already sensible for local MinIO

set -a && source .env && set +a   # fish: export (env) or use direnv

# 4. Run API
npm start
# → http://127.0.0.1:8788

# 5. Mint an API key & login
npx shareplan create-key --url http://127.0.0.1:8788 --admin-token "$SHAREPLAN_ADMIN_TOKEN"
npx shareplan login --url http://127.0.0.1:8788 --token 'sp_...'

# 6. Publish
mkdir -p /tmp/demo && echo '<!doctype html><h1>hello shareplan</h1>' > /tmp/demo/index.html
npx shareplan publish /tmp/demo --title "demo" --ttl 7d
```

## Packages

| Package | Role |
|---------|------|
| `@shareplan/core` | IDs, path sanitizer, MIME, TTL, shared types |
| `@shareplan/server` | Fastify API + static serve from S3 |
| `@shareplan/cli` | `shareplan` CLI |

## CLI

```bash
shareplan login --url https://share.example.com --token sp_xxx
shareplan publish ./site --title "Q3 plan" --ttl 7d
shareplan publish ./site --site <id>          # new version
shareplan ls
shareplan info <id>
shareplan rm <id>

# admin (needs the admin token, not an API key)
shareplan create-key --url <url> --admin-token <tok> --name agent
shareplan list-keys  --url <url> --admin-token <tok>
shareplan revoke-key <key-id> --url <url> --admin-token <tok>
```

Env overrides: `SHAREPLAN_URL`, `SHAREPLAN_TOKEN`.

## HTTP (agent-friendly)

```http
POST /api/v1/sites
Authorization: Bearer sp_...
Content-Type: application/json

{
  "title": "My plan",
  "ttl": "14d",
  "files": [
    { "path": "index.html", "content": "<!doctype html>..." }
  ]
}
```

Public sites: `GET /s/:id/`. See [docs/AGENTS.md](docs/AGENTS.md).

## Configuration

See [`.env.example`](.env.example). Important vars:

| Var | Purpose |
|-----|---------|
| `SHAREPLAN_PUBLIC_BASE_URL` | URLs returned to clients |
| `SHAREPLAN_S3_*` | Endpoint, bucket, credentials |
| `SHAREPLAN_S3_FORCE_PATH_STYLE` | `true` for MinIO |
| `SHAREPLAN_ADMIN_TOKEN` | Mint API keys via `/api/v1/admin/keys` |
| `SHAREPLAN_MAX_SITE_BYTES` | Default 50 MiB |
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

- Untrusted HTML is served under `/s/:id/` with CSP and `X-Robots-Tag: noindex`.
- Path-based hosting shares an origin across sites (XSS can affect other path-sites). Prefer a wildcard subdomain deploy for stronger isolation later.
- API keys are stored as SHA-256 hashes only.
- Zip/tar upload is not in v0.1 (JSON + directory CLI only).

## License

MIT
