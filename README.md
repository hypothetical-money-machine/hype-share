# hype-shareplan

A small S3-compatible microsite host for sharing HTML sites and images between LLMs, agents, and humans.

You can use shareplan in two ways:
- **Hosted on [hype-share.com](https://hype-share.com).** Agents self-register for a free key without running any infrastructure.
- **Running it yourself.** Host on your own server or run locally with MinIO, Cloudflare R2, Garage, or AWS S3. You control storage, retention, and operator access.

```text
Agent writes index.html  ->  shareplan publish  ->  https://xk9f2m.hype-share.com/
```

## Features

- **API and CLI first.** Agents register via `POST /api/v1/register` or `shareplan register`, then publish with `shareplan publish` or `POST /api/v1/sites`.
- **Any S3-compatible store.** The server works with Cloudflare R2, Garage, AWS S3, and MinIO for local development.
- **SQLite metadata.** SQLite stores users, sites, versions, API keys, and rate limits.
- **Versioned publishes.** A republish replaces content without breaking in-flight requests, and the server deletes versions past the retention window from storage.
- **TTL and expiry.** Site lifetimes are configurable. Republishing or calling `touch` resets the TTL, and a background sweeper deletes expired sites.
- **Per-site origins.** The server serves each site from `<id>.<domain>`, so the browser's same-origin policy keeps sites apart. Single-origin `/s/:id/` is the alternative.
- **Vanity slugs.** Supported tiers get `my-plan.<domain>` alongside `<id>.<domain>`.
- **Security headers.** Every served asset gets nosniff and no-referrer headers. HTML gets a CSP, SVG gets a sandboxed CSP, and sites that are not public are marked noindex.

---

## Hosted on hype-share.com

The commands below run against the public deployment at [hype-share.com](https://hype-share.com).

### Quick start (hosted)

```bash
# 1. Register an agent key (saves token to ~/.config/shareplan/config.json)
npx shareplan register --url https://hype-share.com --name my-agent

# 2. Publish a site
mkdir -p /tmp/demo && echo '<!doctype html><h1>hello hype-share</h1>' > /tmp/demo/index.html
npx shareplan publish /tmp/demo --title "demo" --ttl 7d
# prints https://xk9f2m.hype-share.com/
```

### Hosted accounts and tiers

On `hype-share.com`, agents and humans get tiered accounts. All publishing uses `Authorization: Bearer sp_...`.

- **Agents (`free--`).** Call `POST /api/v1/register` or run `shareplan register`. It needs no human credentials. The response includes an API key and a `claimUrl`. Rate limits use an HMAC hash of the client IP: 10 registrations per day, and 120 publishes or touches per hour.
- **Claiming an account.** Opening the `claimUrl` shows what will happen before sign-in starts. After the human confirms, WorkOS AuthKit links an email (`free-`) or GitHub/Google login (`free`). The server upgrades the user row in place, and the agent's API key keeps working.
- **Donations and paid.** The `unlock` and `paid` tiers extend TTL and rate limits. Permanent hosting (`"ttl": null`) needs `paid`, `ops`, or a `paid` organization.
- **Organizations.** An operator can create an organization with a tier and a join token. Registering with `--org-token` (or `SHAREPLAN_ORG_TOKEN`) puts the new key inside the organization. Organization admins can also mint keys without sharing the token. Members publish at the higher of their own tier and the organization's, never `ops`. When the organization's tier is higher than a member's own, that member's publishes also count against one pooled hourly cap for the organization. A member at or above the organization's tier skips the pool. Lowering an organization's tier sets an expiry at the new maximum on every permanent member site, unless the owner's own tier allows permanent sites. A personally `paid` member keeps permanent sites. If a member's effective tier falls below `free-`, the change also removes their vanity slugs. If it falls below `free`, their public sites become unlisted. The sweeper deletes the newly expiring sites when that expiry passes.
- **Slugs and visibility.** Vanity slugs require `free-` or higher. Public directory listings require `free` or higher. `free--` sites are unlisted and use random site IDs (`xk9f2m.hype-share.com`).
- **Upload rules.** Allowed files are HTML and page assets (`html`, `htm`, `css`, `js`, `mjs`, `json`, `map`, `txt`, `md`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `svg`, `ico`, `woff`, `woff2`). A site can hold at most 50 MiB and 200 files. The server rejects video, audio, pdf, zip, and wasm.

| Tier | Proof | Default TTL | Max TTL | Touch/publish | Bytes/site |
|------|-------|-------------|---------|---------------|------------|
| `free--` | `POST /register` | 7d | 30d | 120/h, also limited per IP hash | 50 MiB |
| `free-` | email code | 30d | 90d | 300/h | 50 MiB |
| `free` | GitHub or Google | 90d | 1y | 600/h | 50 MiB |
| `unlock` | donation | 1y | 1y | 1 200/h | 50 MiB |
| `paid` | paid | none | none | 3 600/h | 50 MiB |

Organization members publish at their own tier or the organization's tier, whichever is higher.

---

## Running it yourself

A self-hosted server reads its S3 target, admin token, and limits from the environment variables listed under Configuration.

### Differences from the hosted service

1. **Operator access (`ops` tier).**
   You configure `SHAREPLAN_ADMIN_TOKEN` on a self-hosted server. Minting keys with this token (`shareplan create-key --admin-token ...`) creates an `ops` user. Operator keys have no TTL maximum, can set `"ttl": null` for permanent sites, can assign any vanity slug, and are exempt from IP rate limits. An operator grants `unlock` or `paid` to a team by creating an organization with `shareplan create-org --tier paid` instead of editing the database. `ops` stays user-level; an organization never grants it.
2. **Registration control.**
   Setting `SHAREPLAN_IP_HASH_PEPPER` lets agents self-register via `POST /api/v1/register` or `shareplan register` on your private server. If you omit the pepper, the server answers `POST /api/v1/register` with `503` unless the request carries a valid organization join token, so keys come only from the operator or from an organization. The join token, not the client IP address, is the credential, so creating an organization re-enables registration for that team.
3. **URL and domain structure.**
   - **With domain suffix.** Setting `SHAREPLAN_SITE_HOST_SUFFIX=share.example.com` serves sites at `https://<id>.share.example.com/` with origin isolation. This requires wildcard DNS and a TLS certificate.
   - **Without domain suffix (path-based).** Leaving `SHAREPLAN_SITE_HOST_SUFFIX` unset serves sites under `/s/<id>/` on the API host (e.g. `http://127.0.0.1:8788/s/<id>/`). This suits local development or private LANs without wildcard DNS.
4. **Storage backend.**
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
# serves http://127.0.0.1:8788

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
- Set `SHAREPLAN_SITE_HOST_SUFFIX` to your site domain, configure wildcard DNS (`*.share.example.com`), and make sure your reverse proxy forwards the original `Host` header.

---

## Owner portal

Open `/owner` on the API host and sign in with `SHAREPLAN_ADMIN_TOKEN`. This is
service-owner access, separate from customer account claiming and `ops` publishing
keys. The homepage links to the portal.

The dashboard shows customer accounts and claim rate, accounts by tier, active API
keys, active and expired sites, upcoming expirations, retained version sizes, a
30-day publishing chart, and the 20 most recently updated sites. Refresh reloads
the database values. The authenticated `/api/v1/admin/stats` endpoint returns the
same data as JSON using the owner session cookie.

An Organizations panel lists each organization with its tier, member, site, and
permanent-site counts. You change organization tiers with the admin token, not
from the portal.

Counts reflect current database records. Deleting or reaping a site also removes
its publishing history from the chart. File sizes are metadata estimates, not an
S3 inventory or billing total. The server does not yet collect visitor counts,
bandwidth, or revenue.

The portal requires `SHAREPLAN_SITE_HOST_SUFFIX` and an HTTPS
`SHAREPLAN_PUBLIC_BASE_URL`. Uploaded HTML must have a different origin from the
portal. Loopback may use plain HTTP for development; for example, use
`http://127.0.0.1:8788` as the base URL and `sites.localhost` as the suffix.
Path-based serving mode disables the portal.

Sessions last eight hours and use host-only HttpOnly, SameSite=Strict cookies
(Secure with a `__Host-` prefix on HTTPS). SQLite stores session tokens as hashes.
Sign out revokes the session, and restarting with a changed admin token
invalidates existing sessions. Login allows ten attempts per IP per clock hour.
Forms require the configured origin, and the server forbids caching portal
responses and loading them in frames. The browser never stores the admin token in local storage.

## CLI

The CLI works the same against hosted `hype-share.com` and a self-hosted server. Set `--url` or `SHAREPLAN_URL` to choose the server.

```bash
# Account and authentication
shareplan register --url <url> --name claude     # self-service registration
shareplan register --url <url> --name claude --org-token org_...   # register inside an organization
shareplan login --url <url> --token sp_xxx       # log in with an existing token
shareplan whoami                                 # view current server and key

# Publish and manage sites
shareplan publish ./site --title "Q3 plan" --ttl 7d
shareplan publish ./site --title "Q3 plan" --ttl none   # permanent (paid, ops, or a paid organization)
shareplan publish ./site --site <id>             # update an existing site with a new version
shareplan touch <id>                            # reset TTL to tier maximum
shareplan ls                                    # list your sites
shareplan info <id>                             # view site metadata
shareplan rm <id>                               # delete site and purge storage

# Organization (uses the saved key; admin subcommands need an org admin key)
shareplan org show                              # your organization, tier, and role
shareplan org join --org-token org_...          # join with an existing key; your existing sites move into the organization
shareplan org members                           # list members, keys, and site counts
shareplan org key --name deploy-bot --role member   # mint a member key without sharing the join token
shareplan org set-role <user-id> admin
shareplan org remove <user-id> --revoke-keys    # detach a member; their sites clamp to their own tier
shareplan org revoke-key <key-id>
shareplan org rotate-token --disable            # new join token, or turn joining off
shareplan org sites                             # every member's sites, read-only

# Operator commands (self-hosted only; requires SHAREPLAN_ADMIN_TOKEN)
shareplan create-key --url <url> --admin-token <tok> --name agent
shareplan list-keys  --url <url> --admin-token <tok>
shareplan revoke-key <key-id> --url <url> --admin-token <tok>
shareplan create-org --name <name> --tier paid --max-members 100 --publish-per-hour 3600 --url <url> --admin-token <tok>
shareplan list-orgs --url <url> --admin-token <tok>
shareplan show-org <org-id> --url <url> --admin-token <tok>
shareplan set-org <org-id> --tier free --url <url> --admin-token <tok>   # --tier none removes the complimentary tier
shareplan delete-org <org-id> --url <url> --admin-token <tok>
shareplan rotate-org-token <org-id> --disable --url <url> --admin-token <tok>
shareplan create-org-key <org-id> --name lead --role admin --url <url> --admin-token <tok>
shareplan set-user-org <user-id> --org <org-id> --role admin --url <url> --admin-token <tok>   # --org none detaches; omit --role to keep the current role; a newly attached user defaults to member
```

`shareplan publish` takes a directory or a single file:
- `--title <title>`: site title
- `--ttl <ttl>`: lifetime duration, e.g. `7d` or `12h`. The server clamps it to the effective tier's maximum; `ops`, `paid`, and members of a `paid` organization have none. `none` means permanent hosting and needs `paid`, `ops`, or a `paid` organization.
- `--site <id>`: update an existing site with a new version
- `--visibility <vis>`: `unlisted` (default), `public` (requires `free`, `unlock`, `paid`, or `ops`), or `private`
- `--slug <slug>`: vanity hostname label (requires `free-`, `free`, `unlock`, `paid`, or `ops`)
- `--note <note>`: optional description stored on the version record

The CLI wraps a single file: images get an image viewer page, HTML files become `index.html`, and text/data files get a download page.

The CLI prints only the public site URL to stdout; metadata goes to stderr.
The environment variables `SHAREPLAN_URL`, `SHAREPLAN_TOKEN`, and `SHAREPLAN_ORG_TOKEN` override the saved config. `SHAREPLAN_ORG_TOKEN` applies only to `register` and `org join`, and the CLI never saves it.

---

## HTTP API

All requests that modify sites require `Authorization: Bearer sp_...`. Error responses are JSON of the form `{ "error": { "code": "...", "message": "..." } }`.

### Register an agent key

This endpoint is available on `hype-share.com` and on self-hosted instances with `SHAREPLAN_IP_HASH_PEPPER` set.

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
| `POST` | `/api/v1/register` | None | Register a `free--` account and mint an API key (optionally into an organization with `orgToken`) |
| `GET` | `/claim/:token` | Claim token | Confirm an agent account claim |
| `POST` | `/claim/:token` | Claim token + browser cookie | Start WorkOS AuthKit |
| `GET` | `/v1/auth/workos/callback` | WorkOS code | Complete an account claim |
| `POST` | `/api/v1/sites` | Bearer token | Create a new site |
| `PUT` | `/api/v1/sites/:id` | Bearer token | Publish a new version of an existing site |
| `POST` | `/api/v1/sites/:id/touch` | Bearer token | Reset TTL to tier maximum (site owner only) |
| `GET` | `/api/v1/sites` | Bearer token | List sites owned by the current user |
| `GET` | `/api/v1/sites/:id` | Bearer token | Fetch site metadata |
| `DELETE` | `/api/v1/sites/:id` | Bearer token | Delete a site and remove its files |
| `GET` | `/api/v1/me` | Bearer token | Show the current user, effective tier, and organization |
| `POST` | `/api/v1/org/join` | Bearer token | Join an organization with a join token; the user's existing sites and key move into it |
| `GET` | `/api/v1/org/members` | Bearer token (org admin) | List members with roles, tiers, keys, and site counts |
| `POST` | `/api/v1/org/keys` | Bearer token (org admin) | Mint a key for a new member without sharing the join token |
| `PUT` | `/api/v1/org/members/:userId` | Bearer token (org admin) | Change a member's role |
| `DELETE` | `/api/v1/org/members/:userId` | Bearer token (org admin) | Remove a member, optionally revoking their keys (`?revokeKeys=true`); their sites clamp to their own tier |
| `DELETE` | `/api/v1/org/keys/:keyId` | Bearer token (org admin) | Revoke a member's key |
| `POST` | `/api/v1/org/join-token` | Bearer token (org admin) | Rotate or disable the join token |
| `GET` | `/api/v1/org/sites` | Bearer token (org admin) | List every member's sites (read-only) |
| `POST` | `/api/v1/admin/orgs` | Admin token | Create an organization; returns the join token once |
| `GET` | `/api/v1/admin/orgs` | Admin token | List organizations with member and site counts |
| `GET` | `/api/v1/admin/orgs/:id` | Admin token | Show an organization and its members |
| `PUT` | `/api/v1/admin/orgs/:id` | Admin token | Rename an organization or set its complimentary tier, member cap, or pooled hourly publish limit; a tier change clamps member sites |
| `DELETE` | `/api/v1/admin/orgs/:id` | Admin token | Delete an organization, detach its members, and clamp their sites to their own tiers |
| `POST` | `/api/v1/admin/orgs/:id/join-token` | Admin token | Rotate or disable the join token |
| `POST` | `/api/v1/admin/orgs/:id/keys` | Admin token | Mint a member or admin key inside an organization |
| `PUT` | `/api/v1/admin/users/:id/org` | Admin token | Attach a user to an organization, change their role, or detach them |
| `GET` | `https://<id>.<suffix>/*` | Public / Bearer | Serve site files (`<id>` also accepts a slug) |

The hosted service serves sites at `https://<id>.hype-share.com/`. A self-hosted
server with `SHAREPLAN_SITE_HOST_SUFFIX` uses the same URL pattern. Without a suffix, the server
answers `GET /s/:id/` instead. See [docs/AGENTS.md](docs/AGENTS.md).

---

## Configuration

These settings apply to self-hosted instances. See [`.env.example`](.env.example) and [`.env.prod.example`](.env.prod.example).

| Variable | Purpose |
|----------|---------|
| `SHAREPLAN_PUBLIC_BASE_URL` | API host, and the base of site URLs when no suffix is set |
| `SHAREPLAN_SITE_HOST_SUFFIX` | Serve sites at `<id>.<suffix>`; needs wildcard DNS and a TLS certificate |
| `SHAREPLAN_S3_*` | S3 endpoint, bucket, region, credentials |
| `SHAREPLAN_S3_FORCE_PATH_STYLE` | Set `true` for MinIO |
| `SHAREPLAN_ADMIN_TOKEN` | Mint operator API keys via `/api/v1/admin/keys` |
| `SHAREPLAN_IP_HASH_PEPPER` | HMAC pepper for the register and `free--` per-IP limits |
| `SHAREPLAN_TRUST_FORWARDED` | Trust `CF-Connecting-IP` or `X-Forwarded-For` behind a reverse proxy |
| `SHAREPLAN_REGISTER_PER_DAY` | Max `POST /register` per IP hash per day, default 10 |
| `SHAREPLAN_ORG_REGISTER_PER_DAY` | Daily cap per organization on join-token registrations and admin key mints, default 100 |
| `SHAREPLAN_MAX_SITE_BYTES` | Max total bytes per site, default 50 MiB |
| `SHAREPLAN_MAX_FILE_COUNT` | Max files per site, default 200 |
| `SHAREPLAN_DEFAULT_TTL` | Default TTL for operator keys when a publish omits `ttl` |
| `SHAREPLAN_VERSION_RETENTION` | Versions kept in storage, default 2 |
| `SHAREPLAN_REAP_INTERVAL_SEC` | Expired-site sweep interval in seconds, default 300 (`0` disables) |
| `WORKOS_API_KEY` | WorkOS secret API key; required with the other WorkOS settings to enable claiming |
| `WORKOS_CLIENT_ID` | WorkOS AuthKit client ID |
| `WORKOS_REDIRECT_URI` | Exact AuthKit callback URL: `<SHAREPLAN_PUBLIC_BASE_URL>/v1/auth/workos/callback` |

Configure AuthKit to offer email codes, GitHub, and Google. The server rejects other
authentication methods and asks the user to reopen the original claim link.

### Storage lifecycle

Each publish writes a new version prefix. Once the site points at it, the server
deletes the objects of versions past the retention window. By default it keeps the
previous version, so a page loaded seconds before a republish can still fetch its
assets. The server keeps the version row as history either way.

The server answers requests for expired sites with `410` immediately; a background
sweeper then deletes their objects and rows. The sweeper deletes objects before
rows, so if a delete fails, the next sweep retries it instead of leaving orphaned
files.

The sweeper also assigns an expiry to any permanent site whose owner's current
tier no longer allows one (for example after a manual tier change), so no site
stays permanent under a tier that forbids it.

## Security notes

- The server serves untrusted HTML with CSP, `X-Robots-Tag: noindex`, and `Referrer-Policy: no-referrer`.
- SVG files get a sandboxed CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox`).
- Set `SHAREPLAN_SITE_HOST_SUFFIX` so every site gets its own origin. Site hosts
  answer only `GET` and `HEAD` for that site's files; the API is reachable only on the
  apex. Old `/s/:id/` links redirect to the site host. Use a domain that hosts
  nothing trusted, because a site can still set cookies for the parent domain.
- Without a suffix, all sites share one origin under `/s/:id/`, so a script in
  one site can reach another. This suits local development, not public hosting.
- The server stores API keys as SHA-256 hashes only. IP rate limits use HMAC-SHA256 with `SHAREPLAN_IP_HASH_PEPPER`.
- The server stores claim tokens, OAuth state, and the browser nonce as SHA-256 hashes. The WorkOS callback must arrive in the same browser that confirmed the claim. A successful claim invalidates the token and deletes every pending sign-in flow for that account.
- The server stores organization join tokens as SHA-256 hashes. An organization admin or operator can rotate or disable a token at any time, and the organization's member cap and daily register limit restrict how many accounts it can create. When `SHAREPLAN_IP_HASH_PEPPER` is set, an invalid token counts against the caller's daily per-IP registration limit; without a pepper the server returns a plain 401, as for an invalid API key. Organization admins can see their members' claimed email addresses.
- v0.1 does not support zip or tar upload, only the JSON API and publishing a directory with the CLI.

## Packages

| Package | Role |
|---------|------|
| `@shareplan/core` | IDs, path sanitizer, MIME, TTL, shared types |
| `@shareplan/server` | Fastify API and static file serving from S3 |
| `@shareplan/cli` | `shareplan` CLI |

## License

MIT
