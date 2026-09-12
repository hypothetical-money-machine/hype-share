import { mkdirSync } from "node:fs";
import path from "node:path";

export interface Config {
  host: string;
  port: number;
  publicBaseUrl: string;
  /**
   * When set, each site is served from its own origin at `<id>.<suffix>`
   * (and `<slug>.<suffix>`), so the browser's same-origin policy keeps sites
   * apart. Path serving under `/s/:id/` then only redirects. Null keeps the
   * single-origin `/s/:id/` layout.
   */
  siteHostSuffix: string | null;
  dataDir: string;
  dbPath: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  maxSiteBytes: number;
  maxFileCount: number;
  defaultTtl: string | null;
  adminToken: string | null;
  /** How many versions of a site keep their objects in S3. */
  versionRetention: number;
  /** How often to sweep expired sites, in ms. 0 disables the sweeper. */
  reapIntervalMs: number;
}

export function loadConfig(envSource: NodeJS.ProcessEnv = process.env): Config {
  const env = (name: string, fallback?: string): string | undefined => {
    const v = envSource[name];
    if (v === undefined || v === "") return fallback;
    return v;
  };

  const envBool = (name: string, fallback: boolean): boolean => {
    const v = env(name);
    if (v === undefined) return fallback;
    return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
  };

  const envInt = (name: string, fallback: number): number => {
    const v = env(name);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return n;
  };

  const dataDir = path.resolve(env("SHAREPLAN_DATA_DIR", "./data")!);
  mkdirSync(dataDir, { recursive: true });

  const port = envInt("SHAREPLAN_PORT", 8788);
  const host = env("SHAREPLAN_HOST", "127.0.0.1")!;
  const publicBaseUrl = (env("SHAREPLAN_PUBLIC_BASE_URL", `http://${host}:${port}`)!).replace(
    /\/$/,
    "",
  );

  const siteHostSuffix = normalizeSiteHostSuffix(env("SHAREPLAN_SITE_HOST_SUFFIX"));

  const accessKeyId = env("SHAREPLAN_S3_ACCESS_KEY", env("AWS_ACCESS_KEY_ID", "minioadmin"))!;
  const secretAccessKey = env(
    "SHAREPLAN_S3_SECRET_KEY",
    env("AWS_SECRET_ACCESS_KEY", "minioadmin"),
  )!;

  return {
    host,
    port,
    publicBaseUrl,
    siteHostSuffix,
    dataDir,
    dbPath: path.join(dataDir, "shareplan.sqlite"),
    s3: {
      endpoint: env("SHAREPLAN_S3_ENDPOINT"),
      region: env("SHAREPLAN_S3_REGION", "auto")!,
      bucket: env("SHAREPLAN_S3_BUCKET", "shareplan")!,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: envBool("SHAREPLAN_S3_FORCE_PATH_STYLE", true),
    },
    maxSiteBytes: envInt("SHAREPLAN_MAX_SITE_BYTES", 52_428_800),
    maxFileCount: envInt("SHAREPLAN_MAX_FILE_COUNT", 200),
    defaultTtl: env("SHAREPLAN_DEFAULT_TTL") ?? null,
    adminToken: env("SHAREPLAN_ADMIN_TOKEN") ?? null,
    versionRetention: Math.max(1, envInt("SHAREPLAN_VERSION_RETENTION", 2)),
    reapIntervalMs: Math.max(0, envInt("SHAREPLAN_REAP_INTERVAL_SEC", 300)) * 1000,
  };
}

/**
 * A hostname suffix is a bare domain like `share.example.com`: lowercase, no
 * scheme, no leading dot, no trailing dot or slash. Anything else is a
 * misconfiguration worth failing on at startup rather than serving 404s.
 */
export function normalizeSiteHostSuffix(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const suffix = raw.trim().toLowerCase().replace(/^\.+/, "").replace(/[./]+$/, "");
  if (suffix === "") return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(suffix)) {
    throw new Error(
      `SHAREPLAN_SITE_HOST_SUFFIX must be a bare domain like example.com, got "${raw}"`,
    );
  }
  return suffix;
}
