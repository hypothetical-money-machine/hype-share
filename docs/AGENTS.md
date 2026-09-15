# shareplan — agent guide

Publish small HTML sites and images. Get a shareable URL.

Agents can publish to the hosted service at [hype-share.com](https://hype-share.com) or to a self-hosted shareplan instance.

## Setup

### Hosted (hype-share.com)

Register an agent key directly against the hosted service. No operator tokens or human credentials are required:

```bash
npx shareplan register --url https://hype-share.com --name claude
```

This issues a `free--` tier API key, saves it to `~/.config/shareplan/config.json`, and returns a `claimUrl` a human can use in a browser to link their account.

To configure an agent environment without writing a local config file:

```bash
export SHAREPLAN_URL=https://hype-share.com
export SHAREPLAN_TOKEN=sp_...
```

### Self-hosted (running your own server)

When using a self-hosted or private shareplan server:

- **If open registration is enabled** (`SHAREPLAN_IP_HASH_PEPPER` is configured):
  ```bash
  npx shareplan register --url http://127.0.0.1:8788 --name agent
  ```
- **If using operator-issued keys** (or open registration is disabled):
  An operator mints a key using the server's admin token:
  ```bash
  npx shareplan create-key --url http://127.0.0.1:8788 --admin-token "$SHAREPLAN_ADMIN_TOKEN" --name agent
  npx shareplan login --url http://127.0.0.1:8788 --token sp_...
  ```
  Keys created with the admin token belong to the `ops` tier: they have no TTL maximum cap, can set `"ttl": null` for permanent hosting, can assign custom vanity slugs, and bypass IP rate limits.

```bash
export SHAREPLAN_URL=http://127.0.0.1:8788
export SHAREPLAN_TOKEN=sp_...
```

## CLI

```bash
# Publish a directory with index.html (+ assets)
shareplan publish ./out --title "Q3 plan" --ttl 7d

# Update an existing site (publishes a new version)
shareplan publish ./out --site a1b2c3

# Single file — wraps a viewer page for images, or a download link for text/data
shareplan publish ./chart.png --title "chart"

# Keep-alive — resets site TTL to the tier maximum (30d on free--)
shareplan touch a1b2c3

# Inspection and cleanup
shareplan whoami
shareplan ls
shareplan info a1b2c3
shareplan rm a1b2c3
```

Stdout prints only the public URL; metadata goes to stderr.

## HTTP API

All requests that create or modify sites use `Authorization: Bearer sp_...`.

### Register an agent key

Available on `hype-share.com` and self-hosted instances with `SHAREPLAN_IP_HASH_PEPPER` configured. No credentials required:

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
  "userId": "8f14e45fceea167a",
  "keyId": "c9f0f895fb98ab91",
  "name": "claude",
  "token": "sp_9f2m...",
  "tier": "free--",
  "claimUrl": "https://hype-share.com/claim/AbCdEfGhIjKlMnOpQrStUv",
  "createdAt": "2026-09-13T22:00:00.000Z"
}
```

Registration is rate limited to 10 successful requests per day per hashed IP address.
Save the returned `token`; the server stores only a SHA-256 hash.

### Create a site

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
  "versionId": "ver_r8x2",
  "title": "My plan",
  "slug": null,
  "visibility": "unlisted",
  "createdAt": "2026-09-13T22:00:00.000Z",
  "updatedAt": "2026-09-13T22:00:00.000Z",
  "expiresAt": "2026-09-27T22:00:00.000Z",
  "byteSize": 67,
  "fileCount": 2
}
```

### Keep a site alive (touch)

```http
POST /api/v1/sites/a1b2c3d4e5/touch
Authorization: Bearer sp_...
```

Resets `expiresAt` to the tier maximum (30 days from now for `free--`). Sites that are already expired return `410 gone` and cannot be revived.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/register` | Register an agent key (`free--` tier) |
| `POST` | `/api/v1/sites` | Publish a new site |
| `PUT` | `/api/v1/sites/:id` | Publish a new version of an existing site |
| `POST` | `/api/v1/sites/:id/touch` | Reset TTL to the tier maximum (site owner only) |
| `GET` | `/api/v1/sites` | List sites owned by the authenticated user |
| `GET` | `/api/v1/sites/:id` | Get site metadata |
| `DELETE` | `/api/v1/sites/:id` | Delete a site and purge its files |
| `GET` | `https://<id>.<suffix>/*` | Public serve (`<id>` also accepts a slug) |

Always use the `url` from the response rather than constructing one:
- On `hype-share.com`, sites are served at `https://<id>.hype-share.com/`.
- On self-hosted servers with `SHAREPLAN_SITE_HOST_SUFFIX`, sites are served at `https://<id>.<suffix>/`.
- On self-hosted servers without a host suffix, sites are served at `http://<host>:<port>/s/<id>/` on the API host.

On `PUT`, omitting `ttl` preserves the current expiry. Only `paid` or `ops` tier accounts may set `"ttl": null` for permanent hosting.

## Limits and account tiers

### Hosted on hype-share.com (`free--` tier)

- **Allowed files**: `html`, `htm`, `css`, `js`, `mjs`, `json`, `map`, `txt`, `md`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `svg`, `ico`, `woff`, `woff2`. Uploading other extensions returns `400 file_type_not_allowed`.
- **File structure**: Multi-file uploads require an `index.html`. Single files wrap automatically.
- **Site size**: 50 MiB total byte size, maximum 200 files.
- **TTL**: Default 7d, maximum 30d. Setting `ttl: null` returns `400 ttl_not_allowed`.
- **Slugs**: Vanity slugs are not allowed on `free--` (requires `free` or higher). Returns `400 slug_not_allowed`.
- **Visibility**: `unlisted` by default. `public` returns `400 visibility_not_allowed`. `private` sites require owner API key to access.
- **Rate limits**: 120 publish/touch requests per hour per user and per IP hash. 10 registers per day per IP hash.

### Self-hosted instances

- **Operator keys (`ops` tier)**: No TTL maximum cap, permanent hosting (`"ttl": null`) allowed, vanity slugs allowed, exempt from IP rate limits.
- **Registered keys (`free--` tier)**: Same default 7d / max 30d TTL rules as hosted, unless custom server limits are configured.

## Example prompt

> Write this plan up as a rich HTML experience, and post it to shareplan.

Suggested agent steps:

1. Write `index.html` (and optional assets) to a directory.
2. `shareplan publish ./plan-site --title "Migration plan" --ttl 14d`
3. Return the URL from stdout to the human.
