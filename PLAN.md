# Accounts for hype-share.com

This is the implementation guide for public accounts on [hype-share.com](https://hype-share.com). Product rules live in the README Accounts section; this file says how to put them in the code. Local v0.1 still mints keys with `SHAREPLAN_ADMIN_TOKEN`. That path stays as an operator door. It is not how customers get a token.

Publish stays `Authorization: Bearer sp_...` on every tier. WorkOS AuthKit is the human login on the apex host only. It is not on register and not on the publish API. Do not copy Hype Comms `docs/workos-authkit.md`: that contract is invite-only desktop PKCE, one workspace, and session revocation. This service is the opposite.

## Implementation status

- [x] **Slice 1 (Schema)**: `users` table, `api_keys.user_id`, `sites.owner_user_id`, migration and backfill.
- [x] **Slice 2 (Agent registration and limits)**: `POST /api/v1/register`, IP HMAC rate limits, per-tier default and max TTL on create/update.
- [x] **Slice 3 (Keep-alive)**: `POST /api/v1/sites/:id/touch` resets TTL to tier maximum.
- [x] **Slice 4 (Upload allowlist)**: HTML and page assets allowlist (`ALLOWED_UPLOAD_EXTS`); video, audio, pdf, zip, and wasm rejected.
- [ ] **Slice 5 (AuthKit on the apex)**: claim URL upgrades are implemented (email code → `free-`, GitHub/Google → `free`); standalone human login and browser sessions remain.
- [ ] **Slice 6 (Billing)**: Stripe (or Sponsors) webhooks for `unlock` and `paid`, attached to organizations (`orgs.billing_tier`, `orgs.stripe_customer_id`) first and to individual users second.
- [ ] **Slice 7 (Organizations)**: `orgs` table (comp and billing tiers), `users.org_id` / `org_role`, effective tier, join-token register, pooled org publish limit, org-admin and operator routes, bulk clamp on downgrade, reaper reconcile of permanent sites.

## Architecture

A user row owns sites. API keys are credentials for that user. `sites.owner_user_id` replaces `owner_key_id` as the ownership check. Listing, updating, deleting, and private GET all key off the user, so rotating a token does not orphan sites.

A user may point at one organization (`users.org_id`, `users.org_role`). Enforcement reads the effective tier: the higher of the user's own tier and the organization's, never `ops`. Sites stay user-owned.

Five tiers: `free--` (agent register), `free-` (email code), `free` (GitHub or Google), `unlock` (donation), `paid` (purchase). There is no cap on how many sites exist. A site dies when its TTL does, unless something republishes or calls `touch`. Only `paid` and `ops` may set `ttl` to null; a member of a `paid` organization inherits that through the effective tier.

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

`tier` is an enum in code: `ops | free-- | free- | free | unlock | paid`. Enforcement reads the effective tier resolved from `users.tier` and the organization, not the token string. A `free--` key on a user who later becomes `paid` gets paid limits. Optional token prefix (`sp_free--_…`) is provenance for logs only; do not require rotation on upgrade.

## HTTP

All JSON errors keep the existing `{ error: { code, message } }` shape from `AuthError` / `HttpError`.

**`POST /api/v1/register`** (no auth). Body `{ "name": "claude" }` optional. Creates a `users` row at `free--`, mints one API key, returns the token once, plus `userId`, `keyId`, `tier`, and `claimUrl`. Rate-limit by IP hash: 10 successful registers per day from one hash is enough; return `429` with `code: "rate_limited"`. This replaces `create-key --admin-token` in `docs/AGENTS.md` for hosted use.

**`POST /api/v1/sites` and `PUT /api/v1/sites/:id`** stay as they are, plus: resolve the key to a user, apply that user's default/max TTL, refuse slugs on `free--`, refuse `visibility: "public"` below `free`, refuse `ttl: null` unless the effective tier's policy has `allowNullTtl` (`paid`, `ops`, or a member of a `paid` organization), cap a supplied TTL at the tier max, count the request against the user's publish limiter (and the IP limiter when `tier = free--`).

**`POST /api/v1/sites/:id/touch`**. Same owner check as GET metadata. Does not upload files. If `expires_at` is already null and the effective tier allows null TTL (`paid`, `ops`, or a `paid` organization), leave it null. Otherwise set `expires_at` to now plus the tier **max** TTL (a ping means keep this, not shrink this). Count against the same limiter as publish.

**`GET /api/v1/sites`** lists by `owner_user_id`, not by key id.

Admin `/api/v1/admin/keys` stays. Hash `SHAREPLAN_ADMIN_TOKEN` at process start and compare with `timingSafeEqual`, the way `findApiKeyByToken` already compares key hashes. Admin-minted keys create or attach an `ops` user.

Private site GET already requires the owner's key in `serveSitePath`. After the schema change, compare `key.user_id` to `site.owner_user_id`. Other people's keys still 404.

## Rate limits

HMAC-SHA256 the client address with `SHAREPLAN_IP_HASH_PEPPER`. Store the hex (or a truncation), never the raw IP. IPv4: the full address. IPv6: the `/64`. Behind Cloudflare, use `CF-Connecting-IP` only when the peer is Cloudflare; otherwise use the socket address. Trusting that header from anyone else lets a client pick its bucket.

`free--` publish/touch is limited by both the user and the IP hash. Extra keys from one café do not multiply the 120/h. Humans (email and up) drop the IP publish limit; they still have the per-user hour cap. Register without an `orgToken` always uses the IP hash and requires the pepper; a valid `orgToken` register spends the organization's daily `register` bucket instead and needs no pepper, since the token is the credential (see Organizations, Rate limits).

SQLite is enough for one server process. A table of `(bucket, action, window_start, count)` with hourly windows is fine. Fail closed if the pepper is missing in a hosted config; local dev may use a fixed dev pepper from `.env.example`.

## TTL

Move the numbers into config so tests can shrink them. Defaults match the README table. `packages/server/src/app.ts` `resolveTtl` today falls back to `config.defaultTtl` and allows null. Change it to: omitted `ttl` on create → tier default; omitted `ttl` on update → keep current expiry; explicit `ttl` → clamp to max; explicit `null` → only when the effective tier's policy has `allowNullTtl` (`paid`, `ops`, or a `paid` organization), else 400 `ttl_not_allowed`.

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

`unlock` and `paid` are different Stripe products (or a Sponsors amount vs a subscription). Webhooks set `users.tier` and `stripe_customer_id`. Never take a donation or payment for an unclaimed `free--` user; they have no email to refund. A downgrade from `paid` to `unlock` or `free` must assign a max TTL to sites that currently have `expires_at` null, rather than leaving them permanent. Webhooks resolve a Stripe customer to `orgs.stripe_customer_id` before `users.stripe_customer_id`, write `orgs.billing_tier` via `updateOrg` (which clamps), set it NULL on cancellation, and never write `ops`. For individuals call `clampSitesForUsers([userId])` after `setUserTier`. Checkout for an organization may only be started by an org admin whose user row is claimed, the organization analogue of never taking payment from an unclaimed `free--` user.

## Organizations (slice 7)

An organization is a named group with a tier gift and a shared join token. It owns no sites: `sites.owner_user_id` and every ownership check stay as they are, so org admins cannot edit, touch, delete, or read other members' private sites. Operators create organizations with the admin token; there is no self-service creation and no browser session on any org route.

### Schema

Idempotent DDL at the end of `upgrade()`, after the `version < 3` block. `orgs` is created before the `users` column because the column carries a `REFERENCES` clause and `PRAGMA foreign_keys = ON`. No `PRAGMA user_version` bump: there is no one-time data step, so the DDL is unguarded like the other additive columns and indexes, and `user_version` stays 3. No backfill: existing rows get `org_id NULL` and `org_role NULL` and behave exactly as before.

```sql
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,                                   -- newId(), 16 hex, same shape as users.id
  name TEXT NOT NULL,                                    -- display only, 1..100 chars, not unique
  comp_tier TEXT CHECK (comp_tier IS NULL OR comp_tier <> 'ops'),        -- operator gift; NULL = no comp
  billing_tier TEXT CHECK (billing_tier IS NULL OR billing_tier <> 'ops'), -- slice 6 writes this; NULL until then
  stripe_customer_id TEXT,                               -- slice 6; users.stripe_customer_id stays for individuals
  join_token_hash TEXT,                                  -- hashApiKey(token); NULL = joining disabled
  max_members INTEGER NOT NULL DEFAULT 100,              -- hard cap on users WHERE org_id = id
  publish_per_hour INTEGER,                              -- pooled publish override; NULL = TIER_POLICIES[orgTier].publishPerHour
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_join_token
  ON orgs(join_token_hash) WHERE join_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_stripe_customer
  ON orgs(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- via addColumn, like api_keys.user_id:
ALTER TABLE users ADD COLUMN org_id TEXT REFERENCES orgs(id);   -- plain FK, no ON DELETE: DELETE FROM orgs with members fails loudly
ALTER TABLE users ADD COLUMN org_role TEXT;                     -- 'admin' | 'member' | NULL; code keeps (org_id IS NULL) = (org_role IS NULL)

CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sites_permanent ON sites(owner_user_id) WHERE expires_at IS NULL;
```

`CHECK (tier <> 'ops')` rather than an `IN (...)` list so a future tier does not need a table rebuild; unknown strings are neutralised in code.

### Effective tier

`tiers.ts` exports `TIER_RANK`, `OrgTier = Exclude<Tier, "ops">`, `OrgRole = "admin" | "member"`, `isOrgTier`, and:

```ts
/** What an org contributes: the higher of comp and billing; null when it holds neither. Garbage or 'ops' in either column contributes nothing. */
export function orgTier(
  org: { comp_tier: string | null; billing_tier: string | null } | null,
): OrgTier | null {
  if (org === null) return null;
  const comp = org.comp_tier !== null && isOrgTier(org.comp_tier) ? org.comp_tier : null;
  const billing = org.billing_tier !== null && isOrgTier(org.billing_tier) ? org.billing_tier : null;
  if (comp === null) return billing;
  if (billing === null) return comp;
  return higherTier(comp, billing) as OrgTier;
}

/** An org lifts a member, never lowers one, and never reaches ops. */
export function effectiveTier(user: Tier, org: Tier | null): Tier {
  if (user === "ops" || !isTier(user)) return user;
  if (org === null || !isOrgTier(org)) return user;
  return higherTier(user, org);
}
```

`requireAccount` resolves this once per request and returns `{ key, user, org, tier }`; every policy call in publish and touch uses `account.tier`. `requireOrgAdmin` derives the org from the caller's own `users.org_id`, never from the URL, so cross-org access by parameter substitution is impossible. An unknown own tier passes through unchanged so `policyFor` still throws and publish still returns `400 invalid_tier`.

`ops` is contained three ways: the CHECK constraints, `isOrgTier` at every write, and the `user === "ops"` branch in `effectiveTier`. Attaching an `ops` user to an organization is refused with `400 invalid_tier`, so operator rows never appear in an org listing.

### Join token

`"org_" + randomBytes(32).toString("base64url")`, 47 characters, matching `/^org_[A-Za-z0-9_-]{43}$/`. Only `hashApiKey(token)` is stored in `orgs.join_token_hash`; a NULL hash means joining is disabled. Rotation replaces the hash, so the previous token stops matching at once and members and keys are unaffected. The CLI reads the token from `--org-token` or `SHAREPLAN_ORG_TOKEN` and never writes it to the config file. Org admins mint keys with `POST /api/v1/org/keys`, so agents can be onboarded without ever seeing the token.

### Member cap

`orgs.max_members` (default 100, range 1..10000) is a hard cap on `users WHERE org_id = id`. It is checked inside the same transaction as the insert or attach, on token register, org-admin mint, operator mint, `org join`, and `set-user-org`, and refuses with `403 org_full`.

### Rate limits

Publish and touch consume up to three buckets, all action `publish`, hourly window, first refusal wins:

| Order | Bucket | Limit | When |
|---|---|---|---|
| 1 | `ip:<hmac>` | `policyFor(account.tier).publishPerHour` | only if the effective policy has `ipPublishLimit` (`free--` alone); a member whose org tier is above `free--` never hits it, since the org lifts the effective tier out of `free--`. A `free--` org lifts nothing, so its `free--` members still consume this bucket |
| 2 | `user:<user.id>` | `policyFor(account.tier).publishPerHour` | always |
| 3 | `org:<org.id>` | `org.publish_per_hour ?? policyFor(orgTier).publishPerHour` | the org has a tier, the user is not `ops`, and the org tier ranks above the user's own tier (a member at or above the org tier, such as a personally paid member of a free org, publishes on their own plan and skips the pool) |

User before org, so a runaway agent that is already over its own cap never touches the shared pool. The org refusal message is `organization publish limit reached`.

Registration and org actions:

| Action | Bucket | Window | Limit | Route |
|---|---|---|---|---|
| `register` | `ip:<hmac>` | day | `SHAREPLAN_REGISTER_PER_DAY` (10) | `POST /api/v1/register` without `orgToken`; also consumed, when a pepper is set, on an invalid `orgToken` before the 401 |
| `register` | `org:<org.id>` | day | `SHAREPLAN_ORG_REGISTER_PER_DAY` (100) | `POST /api/v1/register` with a valid `orgToken`; `POST /api/v1/org/keys` |
| `org_join` | `user:<user.id>` | hour | 10 | `POST /api/v1/org/join`, consumed before the token lookup |
| none | | | | all `/api/v1/admin/*` routes, `GET /api/v1/me`, and org-admin reads, removals, revokes, role changes, and token rotation |

A valid token register needs no pepper: the token is the credential. `consumeRate` opens its own `BEGIN IMMEDIATE` and node:sqlite does not nest, so every route consumes its buckets before opening the transaction that inserts or clamps.

### Downgrade: clamp and triggers

`clampSitesToPolicy(db, ownerUserId, policy, now)` runs four guarded UPDATEs over `sites WHERE owner_user_id = ?`, rows only, never S3, `updated_at` untouched, and returns the number of distinct sites changed:

1. `!policy.allowNullTtl`: `expires_at IS NULL` becomes `now + maxTtl` (`clampStoredExpiry(policy, null, now)`).
2. `policy.maxTtl !== null`: `expires_at > now + maxTtl` becomes `now + maxTtl`.
3. `!policy.slugs`: `slug` becomes NULL.
4. `!policy.publicVisibility`: `visibility = 'public'` becomes `unlisted`.

`clampSitesForUsers(db, userIds, now)` recomputes per user from current DB state, `policyFor(effectiveTier(user.tier, orgTier(getOrg(user.org_id))))`, then calls `clampSitesToPolicy`, and returns `{ users, sites, skipped }`, where `users` counts the members processed and `skipped` counts members whose own tier is unknown (that member is skipped and the rest still clamp). Upgrades and same-tier writes run the same function and match zero rows, so there is no rank comparison to get wrong. Neither function opens its own transaction; the caller does.

Triggers, each inside one `transaction()` with the write that changed the tier:

1. `PUT /api/v1/admin/orgs/:id` with `compTier` in the body (any value, including null): every member. A rename or cap change does not clamp.
2. `PUT /api/v1/admin/users/:id/org`: the one user, on attach, detach, and role change.
3. `DELETE /api/v1/org/members/:userId`: the removed user.
4. `DELETE /api/v1/admin/orgs/:id`: every former member, after detaching them.
5. Slice 6: the Stripe webhook calls `updateOrg(db, id, { billing_tier, stripe_customer_id }, now)` and gets the clamp for free; for individuals it calls `clampSitesForUsers([userId], now)` after `setUserTier`.

Concretely, a paid org lowered to `unlock` or `free`: permanent sites get `now + 1y`; to `free-`: `now + 90d` and public becomes unlisted; to `free--`: `now + 30d`, slug dropped, public becomes unlisted. A member whose own tier is `paid` keeps NULL expiries. The route response carries the count (`clamped.sites` or `clampedSites`) and the CLI prints `clamped=N`, which is the operator's only signal; warn the org before lowering.

This answers the Billing note above: `listExpiredSites` filters `expires_at IS NOT NULL`, so the reaper never sees a permanent site. After a downgrade such rows no longer exist for that user, and the existing sweep deletes the site once its new expiry passes, with no reaper change.

### Reconcile backstop

`reconcilePermanentSites(db, now, log)` runs in `reapExpiredSites` between `pruneClaimAuthFlows` and `listExpiredSites`, wrapped in `try/catch` so a failure is logged and expired-site deletion still runs. It selects every site with `expires_at IS NULL` (served by `idx_sites_permanent`) joined to its owner and the owner's org, computes the effective policy per row, and when `allowNullTtl` is false assigns `now + maxTtl`. A row whose `users.tier` is an unknown string (the manual-SQL case) is skipped and counted, not fatal. Returns `{ clamped, skipped }` and logs `reap: assigned expiry to N permanent site(s) whose tier no longer allows it` when N > 0. Scoped to NULL expiries only; over-long non-null expiries and stale slug or public flags keep the lazy handling at touch and publish.

### Notes

- The WorkOS note above, "they mint another key from the account", is `POST /api/v1/org/keys` for organizations: an org admin mints a member key without sharing the join token.
- Deleting an organization refuses with `409 org_billed` while `billing_tier` or `stripe_customer_id` is set; cancel in Stripe first.
- `org remove --revoke-keys` is a single request, `DELETE /api/v1/org/members/:userId?revokeKeys=true`, and the key revocation runs inside the removal transaction after the last-admin check, so removing yourself with your own key still completes.
- Deferred: pooled bytes and per-seat pricing, time-boxed or use-capped invites, org suspension, self-leave (a member asks an org admin or the operator), org slugs, and org-owned sites.

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

Organizations (slice 7) add, across `tiers.test.ts`, `db.test.ts`, `config.test.ts`, `orgs.test.ts` (new), `owner.test.ts`, and `cli.test.ts`:

- `effectiveTier` table: (free--, paid) paid; (paid, free) paid; (free, null) free; (ops, paid) ops; (free--, ops) free--; (free--, "gold") free--; ("gold", paid) "gold" and `policyFor` of that throws
- `orgTier`: null org, both columns null, comp only, billing only, both set returns the higher, "gold" or "ops" in a column is ignored
- `isOrgTier` rejects `ops` and `gold`; `TIER_RANK` is exported and strictly increasing over `ORG_TIERS`
- schema: `orgs` table, `users.org_id` / `org_role`, and the four new indexes exist; `user_version` is still 3; a second `upgrade()` is a no-op
- a pre-org database upgrades in place: an existing user reports `org_id: null`, keys still resolve, the site row is unchanged
- CHECK rejects `ops` in `comp_tier` and `billing_tier`; FK rejects `DELETE FROM orgs` with a member; `deleteOrg` detaches first
- `clampSitesToPolicy` at free-- returns 3 for the four-site fixture: NULL and over-long expiries become now+30d, slug and public are dropped from one site (counted once), an in-range site is untouched, `updated_at` is unchanged, another user's sites are untouched; at paid returns 0; at free NULL becomes now+1y with slug and public kept
- `clampSitesForUsers` recomputes per user: after `updateOrg({ comp_tier: "free" })` the free-- member's NULL site is now+1y and the paid member's stays NULL
- `updateOrg` free to paid changes no site row; a name-only patch does not clamp; a later `free-` clamps to now+90d and unlists
- `setUserOrg(user, null, null)` detaches and clamps to the own tier
- `createOrgMember` at the cap throws 403 `org_full` and rolls back
- `removeOrgMember` and `setOrgMemberRole` refuse the last admin with 409 `last_admin`; non-members return null or false
- `revokeOrgMemberKey` revokes only a member's active key
- `reconcilePermanentSites` clamps a free-- user's NULL site, leaves paid, ops, and paid-org members alone, skips and counts an unknown tier, and is a no-op on the second run
- `deleteOrg` throws 409 `org_billed` when `stripe_customer_id` is set
- `findOrgByJoinToken` returns null after disable and for a never-issued token; a rotated token resolves
- `loadConfig`: `orgRegisterPerDay` defaults to 100, `"5"` gives 5, `"0"` gives 1, `"x"` throws
- `POST /api/v1/admin/orgs` returns a join token matching `ORG_TOKEN_RE` and stores only its hash; a user key is 401; no admin token is 503
- `compTier` `ops` or `gold` is 400 `invalid_tier`; `PUT {}` is 400 `validation_error`
- register with a valid token: 201, `tier` free--, `effectiveTier` paid, `org.role` member; a plain register has `org: null`
- invalid token: 401 `invalid_org_token`, no users row, the IP register bucket is spent; a malformed token is 400 and spends nothing
- a valid token skips the IP bucket and uses the org's daily bucket; without a pepper a plain register is 503 and a token register is 201
- disable and rotate the join token (operator and org admin): the old token 401s, the new one works, `joinEnabled` reflects it
- member cap: the third register is 403 `org_full`; raising `maxMembers` allows it
- a free-- member of a paid org publishes `ttl: null`, a slug, and public; the same body from a plain free-- user is 400
- an org member skips the IP publish bucket; the pooled bucket refuses the fourth publish across two keys with `organization publish limit reached`; a personally paid member of a free org skips the pool; a paid user in a free- org keeps `ttl: null`
- ops never joins: `PUT /api/v1/admin/users/:id/org` and `POST /api/v1/org/join` are 400 `invalid_tier`
- lowering clamps and the reaper deletes the site after the new expiry; lowering to free-- clears slug and public and the slug host is 404; raising is a no-op; comp and billing are independent; rename does not clamp
- attach and detach via `PUT /api/v1/admin/users/:id/org`, with 404, `unknown_org`, `already_in_org`, role change, and `org_full` cases
- `POST /api/v1/org/join`: an existing key joins, a second join is 409, ten bad tokens then 429, a full org is 403
- org-admin mint, members list (with the claimed email), remove, revoke key, set role, rotate, and `GET /api/v1/org/sites`; a member key is 403 `org_admin_required`, a no-org key is 404 `no_org`
- `GET /api/v1/me` for a member and a plain user; a claim still works for an org member and keeps `org_id`
- list and show orgs; delete org is 409 `org_billed` while billed, then 200 with clamp counts
- `GET /api/v1/admin/keys` items carry `userId` and `orgId`; `/docs/agents` mentions `orgToken` and `--org-token`
- the existing `app.test.ts` passes with only `orgRegisterPerDay: 100` added to the Config literal
- owner stats: empty `orgs` and `orgList`; after one org, one member, and one publish the list row and `elevated` match; the JSON holds neither the join token nor its hash; the dashboard escapes the org name
- CLI: `--ttl none` sends `ttl: null`; `resolveOrgToken` prefers the flag over the env; the saved config never contains `org_`

## Config

Hosted `.env` / `.env.zima.example` will need the pepper, WorkOS, and Stripe values when those slices land. Until then, register can run with only `SHAREPLAN_IP_HASH_PEPPER`. Missing WorkOS means email and social routes 503 `auth_unconfigured`, same idea as today's `admin_disabled`. Self-host without those keys still has admin minting and agent register.

`SHAREPLAN_ORG_REGISTER_PER_DAY` (default 100) caps organization-token registers and org-admin key mints per organization per day.
