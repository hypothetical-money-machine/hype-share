# Changelog

## 0.1.0 (unreleased)

The first tagged release. An agent registers with `shareplan register` or `POST /api/v1/register`, publishes a directory, and gets back a link at `https://<id>.<suffix>/` that a person can open. Each site is served from its own hostname, so the browser keeps one site's scripts and cookies away from another's and from the API.

What is in it:

- Agent self-registration, per-tier TTLs, rate limits and an upload allowlist.
- Account claiming through WorkOS AuthKit, which keeps the agent's key working after a person signs in.
- Organizations with a shared tier, join tokens, and a link to a WorkOS organization.
- Org-only sites that signed-in members of the organization can open through a site-host handoff.
- An owner portal with aggregate service stats.
- A sweeper that expires sites, prunes old versions, and removes storage left behind by failed or interrupted publishes and deletes.
- A CLI, `@shareplan/cli`, installed from this repository with `npm link -w @shareplan/cli`.

### Upgrading an existing deployment

Read these before pointing a running server at this release.

- **Back up first.** Back up the SQLite file and the MinIO volume. The database migration and the volume handover below are one-way.
- **Database.** The schema moves to `user_version` 4 on first start. The migration clears slugs that aren't valid hostname labels and slugs that are now reserved (`login`, `auth`, `account`, `support`, `status`, `help`, `billing` and similar), and logs each one with its site id. Those sites stay up at their generated id.
- **Admin token.** A `SHAREPLAN_ADMIN_TOKEN` shorter than 16 characters stops the server from starting.
- **Stricter config.** The server also refuses to start on a `SHAREPLAN_PUBLIC_BASE_URL` with a path, only one of the two S3 keys, a number setting that isn't a whole number in range, or a `SHAREPLAN_DEFAULT_TTL` it can't parse. Each error names the setting.
- **S3 credentials.** The implicit `minioadmin` keys are gone. Set `SHAREPLAN_S3_ACCESS_KEY` and `SHAREPLAN_S3_SECRET_KEY`, or leave both unset to use the AWS SDK's default credential chain.
- **Client IP behind Cloudflare.** Set `SHAREPLAN_CLIENT_IP_HEADER=cf-connecting-ip` together with `SHAREPLAN_TRUST_FORWARDED=true`, or every client shares the Cloudflare edge's rate-limit bucket. The server refuses to start with the header set and forwarding untrusted.
- **Claims need site hosts.** Without `SHAREPLAN_SITE_HOST_SUFFIX`, claim links answer 503.
- **Production compose.** `compose.prod.yaml` won't start without `SHAREPLAN_PUBLIC_BASE_URL`, `SHAREPLAN_SITE_HOST_SUFFIX`, `SHAREPLAN_ADMIN_TOKEN`, `SHAREPLAN_IP_HASH_PEPPER`, `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`.
- **MinIO image.** `minio/minio` and `minio/mc` can no longer be pulled. Both compose files now use `cgr.dev/chainguard/minio`, pinned by digest, which runs as uid 65532. The new `minio-volume` service hands a volume made by the old root-run image to that user on first start, then exits.
- **Site link ports.** Site URLs now carry the API URL's port. A server reached directly at `http://host:8788` prints `http://<id>.host:8788/` instead of a link without the port. Behind a proxy on 443 nothing changes.
- **Node.** `engines` is `>=22.13.0`, the first release where `node:sqlite` works without a flag.

### Known gaps

- Site ids deleted before this release weren't recorded, so a vanity slug can still take one.
- Claim tokens don't expire yet.
- After a republish, a page loaded just before it asks the live version for its assets, not the version it came from.
- A request pipelined behind a site request on the same connection inherits that request's 30-second idle limit. Browsers and common proxies don't pipeline.
