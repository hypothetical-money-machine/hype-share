# Accounts for hype-share.com

This is the implementation guide for public accounts on [hype-share.com](https://hype-share.com). Product rules live in the README Accounts section; this file says how to put them in the code. Local v0.1 still mints keys with `SHAREPLAN_ADMIN_TOKEN`. That path stays as an operator door. It is not how customers get a token.

Publish stays `Authorization: Bearer sp_...` on every tier. WorkOS AuthKit is the human login on the apex host only. It is not on register and not on the publish API. Do not copy Hype Comms `docs/workos-authkit.md`: that contract is invite-only desktop PKCE, one workspace, and session revocation. This service is the opposite.

## Implementation status

- [x] **Slice 1 (Schema)**: `users` table, `api_keys.user_id`, `sites.owner_user_id`, migration and backfill.
- [x] **Slice 2 (Agent registration and limits)**: `POST /api/v1/register`, IP HMAC rate limits, per-tier default and max TTL on create/update.
- [x] **Slice 3 (Keep-alive)**: `POST /api/v1/sites/:id/touch` resets TTL to tier maximum.
- [x] **Slice 4 (Upload allowlist)**: HTML and page assets allowlist (`ALLOWED_UPLOAD_EXTS`); video, audio, pdf, zip, and wasm rejected.
- [ ] **Slice 5 (AuthKit on the apex)**: email code → `free-`, GitHub/Google → `free`, claim URL upgrades a `free--` user in place.
- [ ] **Slice 6 (Billing)**: Stripe (or Sponsors) webhooks for `unlock` and `paid`.

## Architecture

A user row owns sites. API keys are credentials for that user. `sites.owner_user_id` replaces `owner_key_id` as the ownership check. Listing, updating, deleting, and private GET all key off the user, so rotating a token does not orphan sites.

Five tiers: `free--` (agent register), `free-` (email code), `free` (GitHub or Google), `unlock` (donation), `paid` (purchase). There is no cap on how many sites exist. A site dies when its TTL does, unless something republishes or calls `touch`. `paid` is the only tier that may set `ttl` to null.

| Tier | Proof | Default TTL | Max TTL | Touch/publish | Bytes/site |
|------|-------|-------------|---------|---------------|------------|
| `free--` | `POST /register` | 7d | 30d | 120/h, plus IP hash | 50 MiB |
| `free-` | email code | 30d | 90d | 300/h | 50 MiB |
| `free` | GitHub or Google | 90d | 1y | 600/h | 50 MiB |
| `unlock` | donation | 1y | 1y | 1 200/h | 50 MiB |
| `paid` | paid | none | none | 3 600/h | 50 MiB |

Vanity slugs stay off `free--`. Unlisted is the default. Public listing starts at `free`. Bytes stay 50 MiB for everyone (`SHAREPLAN_MAX_SITE_BYTES`). Version retention stays 2 unless `paid` later buys more.

## Schema

Follow the existing `migrate` / `addColumn` style in `packages/server/src/db.ts`. SQLite will not rewrite `sites.owner_key_id`, so add columns and backfill. Keep `owner_key_id` populated until every read uses `owner_user_id`, then stop writing it.

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  email TEXT,
  workos_user_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email) WHERE email IS NOT NULL;
```

`api_keys` gains `user_id TEXT REFERENCES users(id)`. `sites` gains `owner_user_id TEXT REFERENCES users(id)`. Index `sites(owner_user_id)`.

Backfill: each existing `api_keys` row gets a `users` row with `tier = 'ops'`. Operator users skip public TTL max and IP limits so the Zima deploy and local admin-minted keys keep behaving. New customer keys never get `ops`.

Unverified email must not unique-bind. Store a pending email on a separate `email_challenges` (or equivalent) table until AuthKit or Magic Auth succeeds; then write `users.email`. Otherwise the first caller to `POST /register` with someone else's address squats it.

`tier` is an enum in code: `ops | free-- | free- | free | unlock | paid`. Enforcement reads `users.tier`, not the token string. A `free--` key on a user who later becomes `paid` gets paid limits. Optional token prefix (`sp_free--_…`) is provenance for logs only; do not require rotation on upgrade.

## HTTP

All JSON errors keep the existing `{ error: { code, message } }` shape from `AuthError` / `HttpError`.

**`POST /api/v1/register`** (no auth). Body `{ "name": "claude" }` optional. Creates a `users` row at `free--`, mints one API key, returns the token once, plus `userId`, `keyId`, `tier`, and `claimUrl`. Rate-limit by IP hash: 10 successful registers per day from one hash is enough; return `429` with `code: "rate_limited"`. This replaces `create-key --admin-token` in `docs/AGENTS.md` for hosted use.

**`POST /api/v1/sites` and `PUT /api/v1/sites/:id`** stay as they are, plus: resolve the key to a user, apply that user's default/max TTL, refuse slugs on `free--`, refuse `visibility: "public"` below `free`, refuse `ttl: null` unless `paid`, cap a supplied TTL at the tier max, count the request against the user's publish limiter (and the IP limiter when `tier = free--`).

**`POST /api/v1/sites/:id/touch`**. Same owner check as GET metadata. Does not upload files. If `expires_at` is already null and the user is `paid`, leave it null. Otherwise set `expires_at` to now plus the tier **max** TTL (a ping means keep this, not shrink this). Count against the same limiter as publish.

**`GET /api/v1/sites`** lists by `owner_user_id`, not by key id.

Admin `/api/v1/admin/keys` stays. Hash `SHAREPLAN_ADMIN_TOKEN` at process start and compare with `timingSafeEqual`, the way `findApiKeyByToken` already compares key hashes. Admin-minted keys create or attach an `ops` user.

Private site GET already requires the owner's key in `serveSitePath`. After the schema change, compare `key.user_id` to `site.owner_user_id`. Other people's keys still 404.

## Rate limits

HMAC-SHA256 the client address with `SHAREPLAN_IP_HASH_PEPPER`. Store the hex (or a truncation), never the raw IP. IPv4: the full address. IPv6: the `/64`. Behind Cloudflare, use `CF-Connecting-IP` only when the peer is Cloudflare; otherwise use the socket address. Trusting that header from anyone else lets a client pick its bucket.

`free--` publish/touch is limited by both the user and the IP hash. Extra keys from one café do not multiply the 120/h. Humans (email and up) drop the IP publish limit; they still have the per-user hour cap. Register always uses the IP hash.

SQLite is enough for one server process. A table of `(bucket, action, window_start, count)` with hourly windows is fine. Fail closed if the pepper is missing in a hosted config; local dev may use a fixed dev pepper from `.env.example`.

## TTL

Move the numbers into config so tests can shrink them. Defaults match the README table. `packages/server/src/app.ts` `resolveTtl` today falls back to `config.defaultTtl` and allows null. Change it to: omitted `ttl` on create → tier default; omitted `ttl` on update → keep current expiry; explicit `ttl` → clamp to max; explicit `null` → only `paid`, else 400 `ttl_not_allowed`.

The sweeper in `packages/server/src/reap.ts` already deletes expired sites. No site-count job. Keep-alive is `touch` or republish.

## Files

Add an allowlist next to `EXT_MAP` in `packages/core/src/mime.ts` (or a sibling in `files.ts`) and reject anything else in `prepareFiles` with `400` `file_type_not_allowed`. First cut:

`html`, `htm`, `css`, `js`, `mjs`, `json`, `txt`, `md`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `svg`, `ico`, `woff`, `woff2`.

Remove video, audio, pdf, zip, wasm, and the `octet-stream` fallback from what we **accept**. Serving can keep a wider MIME map for files already in S3. `ensureIndexHtml` still wraps a single image; drop the video/audio wrapper branches once those types cannot be uploaded. `index.html` remains required for multi-file sites.

## WorkOS (slice 5)

New env: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI` (`https://hype-share.com/v1/auth/workos/callback` in prod; loopback in dev). Callback and cookies live on the API host, never on `*.hype-share.com`.

Email Magic Auth creates or matches a user at `free-`. GitHub or Google creates or matches at `free`. If the user already exists at a higher tier, do not demote. Linking Google onto an email user raises `free-` to `free`.

`claimUrl` from register is a one-time secret on the `free--` user. Browser AuthKit, then write `workos_user_id` / `email` on that same row and set the tier. Sites and keys stay. A human who already has an account does not merge a stray agent user; they mint another key from the account.

After AuthKit, mint a key if the client is the CLI, or set an apex session cookie if the client is a browser. The CLI can stay dumb for a long time: print a URL, wait, print a token, `shareplan login --token`. Do not build Comms's desktop PKCE.

## Billing (slice 6)

`unlock` and `paid` are different Stripe products (or a Sponsors amount vs a subscription). Webhooks set `users.tier` and `stripe_customer_id`. Never take a donation or payment for an unclaimed `free--` user; they have no email to refund. A downgrade from `paid` to `unlock` or `free` must assign a max TTL to sites that currently have `expires_at` null, rather than leaving them permanent.

## CLI and agent docs

`shareplan register --url https://hype-share.com --name claude` calls `POST /api/v1/register`, writes config, prints the token once. `shareplan touch <id>` hits the touch route. Keep `login --token` and `SHAREPLAN_TOKEN`. Point `docs/AGENTS.md` at register for hosted, and leave admin `create-key` as the local operator path.

## Tests

Extend `packages/server/src/app.test.ts`. The harness in `setup()` should grow a user, not only `createApiKeyRecord`. Cover at least:

- register returns a token and a `free--` user
- second register from the same hashed IP inside the window is 429
- omitted ttl on create becomes 7d for `free--`
- `ttl: null` is 400 for `free--` and 200 for `paid`
- slug on `free--` is 409/400
- `visibility: "public"` below `free` is 400
- touch moves `expires_at` forward and does not write S3
- `ls` after minting a second key for the same user shows sites from both
- mp4 / zip / no-extension binary is 400
- admin-minted `ops` keys still skip the public max TTL

Rate-limit tests should inject a client address; do not depend on wall-clock beyond a fake `now` if you thread that through.

## Config

Hosted `.env` / `.env.zima.example` will need the pepper, WorkOS, and Stripe values when those slices land. Until then, register can run with only `SHAREPLAN_IP_HASH_PEPPER`. Missing WorkOS means email and social routes 503 `auth_unconfigured`, same idea as today's `admin_disabled`. Self-host without those keys still has admin minting and agent register.
