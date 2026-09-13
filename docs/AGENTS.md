# shareplan — agent guide

Publish small HTML sites, images, and videos. Get a shareable URL.

## Setup

```bash
# Server (dev): MinIO + API
docker compose up -d
cp .env.example .env   # adjust if needed
npm install && npm run build
export $(grep -v '^#' .env | xargs)   # or use your shell's env loader
npm start

# Mint a key
npx shareplan create-key --url http://127.0.0.1:8788 --admin-token "$SHAREPLAN_ADMIN_TOKEN"
npx shareplan login --url http://127.0.0.1:8788 --token sp_...
```

Env for agents (no login file needed):

```bash
export SHAREPLAN_URL=http://127.0.0.1:8788
export SHAREPLAN_TOKEN=sp_...
```

## Publish

```bash
# Directory with index.html (+ assets)
shareplan publish ./out --title "Q3 plan" --ttl 7d

# Update existing site (new version)
shareplan publish ./out --site a1b2c3

# Single file (image/html/video) — auto-wraps a viewer page when needed
shareplan publish ./chart.png --title "chart"
```

Stdout is only the public URL; metadata goes to stderr.

## HTTP API

`Authorization: Bearer sp_...`

### Create

```http
POST /api/v1/sites
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

### Response

```json
{
  "id": "a1b2c3d4e5",
  "url": "https://a1b2c3d4e5.share.example.com/",
  "versionId": "...",
  "expiresAt": null,
  "byteSize": 123,
  "fileCount": 2
}
```

### Other

| Method | Path | Purpose |
|--------|------|---------|
| `PUT` | `/api/v1/sites/:id` | New version |
| `GET` | `/api/v1/sites` | List yours |
| `GET` | `/api/v1/sites/:id` | Metadata |
| `DELETE` | `/api/v1/sites/:id` | Delete |
| `GET` | `https://<id>.<suffix>/*` | Public serve (`<id>` also accepts a slug) |

Optional `slug` on create gives a readable URL (`https://my-plan.<suffix>/`);
it must be a valid hostname label (lowercase letters, digits, inner hyphens, at
most 63 chars), must not be a reserved label like `www`, and must not
already be taken or look like an existing site id, otherwise you get a `409`.

Always use the `url` from the response rather than building one: a server
without a host suffix serves sites under `/s/:id/` on the API host instead.

On `PUT`, omitting `ttl` keeps the current expiry — send `"ttl": null` to make
a site permanent, or a new value to reset the clock.

## Example prompt

> Write this plan up as a rich HTML experience, and post it to shareplan.

Suggested agent steps:

1. Write `index.html` (and optional assets) to a temp dir.
2. `shareplan publish /tmp/plan-site --title "..." --ttl 14d`
3. Return the URL from stdout to the human.
