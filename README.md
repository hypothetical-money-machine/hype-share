# hype-shareplan

A small **S3-compatible** microsite host for sharing HTML sites, images, and videos between **LLMs, agents, and humans**.

```text
Agent writes index.html  →  shareplan publish  →  https://xk9f2m.share.example.com/
```

## Features (v0.1)

- **API + CLI first** — agents publish with `shareplan publish` or `POST /api/v1/sites`
- **Any S3-compatible store** — MinIO (dev), Cloudflare R2, Garage, AWS S3
- **SQLite metadata** — sites, versions, API keys
- **Versioned publishes** — replace content without breaking mid-upload, with
  old versions swept from storage automatically
- **TTL / expiry** — optional `7d`-style lifetimes, reclaimed by a background sweeper
- **Per-site origins** — each site served from `<id>.<your-domain>` so the
  browser's same-origin policy keeps sites apart (or single-origin `/s/:id/`)
- **Vanity slugs** — `my-plan.<your-domain>` alongside `xk9f2m.<your-domain>`
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

Public sites: `https://<id>.<suffix>/` when `SHAREPLAN_SITE_HOST_SUFFIX` is set,
otherwise `GET /s/:id/`. See [docs/AGENTS.md](docs/AGENTS.md).

## Configuration

See [`.env.example`](.env.example). Important vars:

| Var | Purpose |
|-----|---------|
| `SHAREPLAN_PUBLIC_BASE_URL` | API host, and the base of site URLs when no suffix is set |
| `SHAREPLAN_SITE_HOST_SUFFIX` | Serve sites at `<id>.<suffix>`; needs wildcard DNS + cert |
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

- Untrusted HTML is served with CSP, `X-Robots-Tag: noindex`, and `Referrer-Policy: no-referrer`.
- Set `SHAREPLAN_SITE_HOST_SUFFIX` so every site gets its own origin. Site hosts
  answer only `GET`/`HEAD` for that site's files; the API is reachable only on the
  apex. Old `/s/:id/` links redirect to the site host. Use a domain that hosts
  nothing trusted: a site can still set cookies for the parent domain.
- Without a suffix, all sites share one origin under `/s/:id/`, so a script in
  one site can reach another. Fine for local dev, not for public hosting.
- API keys are stored as SHA-256 hashes only.
- Zip/tar upload is not in v0.1 (JSON + directory CLI only).

## License

MIT
