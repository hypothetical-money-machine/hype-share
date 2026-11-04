import type { DatabaseSync } from "node:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import {
  beginUpload,
  deleteSite,
  endUpload,
  listAbandonedUploads,
  listExpiredSites,
  markSiteDeleting,
  pruneClaimAuthFlows,
  pruneRateLimits,
  reconcilePermanentSites,
} from "./db.js";
import { pruneViewerAuth } from "./viewer-db.js";
import { deletePrefix, deleteSiteObjects } from "./storage.js";

/**
 * An upload this old that never committed was abandoned: its publish failed
 * and could not clean up, or the process died. Far longer than any upload of
 * a size-capped site, so a live one is never taken.
 */
export const ABANDONED_UPLOAD_MS = 60 * 60 * 1000;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface ReapDeps {
  config: Config;
  db: DatabaseSync;
  s3: S3Client;
  log?: Logger;
}

/**
 * Drop sites whose TTL has passed, objects first. Serving already returns 410
 * for these, so this only reclaims storage.
 *
 * Objects go before the row: if the delete fails we keep the row and retry on
 * the next sweep, whereas the reverse would orphan the objects permanently.
 *
 * Each site is first marked as deleting, and only if it is still expired at
 * that moment: a republish or touch that extended it since the listing wins,
 * and once marked, no publish can land on it while its objects go. Sites whose
 * owner delete did not finish are already marked and are retried here too.
 */
export async function reapExpiredSites(
  deps: ReapDeps,
  now = Date.now(),
): Promise<{ sites: number; objects: number }> {
  pruneRateLimits(deps.db, now);
  pruneClaimAuthFlows(deps.db, now);
  pruneViewerAuth(deps.db, now);
  // Guarded so a reconcile failure never blocks expired-site deletion.
  try {
    const { clamped } = reconcilePermanentSites(deps.db, now, deps.log);
    if (clamped > 0) {
      deps.log?.info(
        `reap: assigned expiry to ${clamped} permanent site(s) whose tier no longer allows it`,
      );
    }
  } catch (err) {
    deps.log?.warn(`reap: reconcile failed: ${errMessage(err)}`);
  }
  const expired = listExpiredSites(deps.db, now);
  let sites = 0;
  let objects = 0;

  for (const site of expired) {
    try {
      if (!markSiteDeleting(deps.db, site.id, Date.now(), now)) continue;
      objects += await deleteSiteObjects(deps.s3, deps.config.s3.bucket, site.id);
      deleteSite(deps.db, site.id);
      sites += 1;
    } catch (err) {
      deps.log?.warn(
        `reap: could not delete expired site ${site.id}: ${errMessage(err)}`,
      );
    }
  }

  if (sites > 0) {
    deps.log?.info(`reap: removed ${sites} expired site(s), ${objects} object(s)`);
  }

  // Taking the record first means a publish that is somehow still running sees
  // it gone and refuses to commit; on failure it goes back for the next sweep.
  for (const prefix of listAbandonedUploads(deps.db, now - ABANDONED_UPLOAD_MS)) {
    if (!endUpload(deps.db, prefix)) continue;
    try {
      objects += await deletePrefix(deps.s3, deps.config.s3.bucket, prefix);
    } catch (err) {
      beginUpload(deps.db, prefix, now - ABANDONED_UPLOAD_MS);
      deps.log?.warn(`reap: could not remove abandoned upload ${prefix}: ${errMessage(err)}`);
    }
  }
  return { sites, objects };
}

/**
 * Sweep on an interval until the returned stop function is called. The timer is
 * unref'd so it never holds the process open on its own.
 */
export function startReaper(deps: ReapDeps): () => void {
  if (deps.config.reapIntervalMs <= 0) return () => {};

  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void reapExpiredSites(deps)
      .catch((err: unknown) => deps.log?.warn(`reap: sweep failed: ${errMessage(err)}`))
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, deps.config.reapIntervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
