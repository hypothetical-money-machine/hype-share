import type { DatabaseSync } from "node:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import {
  deleteSite,
  listExpiredSites,
  pruneClaimAuthFlows,
  pruneRateLimits,
  reconcilePermanentSites,
} from "./db.js";
import { deleteSiteObjects } from "./storage.js";

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
 */
export async function reapExpiredSites(
  deps: ReapDeps,
  now = Date.now(),
): Promise<{ sites: number; objects: number }> {
  pruneRateLimits(deps.db, now);
  pruneClaimAuthFlows(deps.db, now);
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
