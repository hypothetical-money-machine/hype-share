import { mkdirSync } from "node:fs";
import path from "node:path";
import { isHostLabel, siteLabelFromHost } from "@shareplan/core";
import { hashApiKey } from "./db.js";

export const WORKOS_CALLBACK_PATH = "/v1/auth/workos/callback";

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
  /** SHA-256 hex of SHAREPLAN_ADMIN_TOKEN; null if unset. */
  adminTokenHash: string | null;
  /** HMAC pepper for client IP buckets. Null disables register / free-- IP limits. */
  ipHashPepper: string | null;
  /** Trust CF-Connecting-IP / X-Forwarded-For. Off unless behind a known proxy. */
  trustForwarded: boolean;
  registerPerDay: number;
  /** How many versions of a site keep their objects in S3. */
  versionRetention: number;
  /** How often to sweep expired sites, in ms. 0 disables the sweeper. */
  reapIntervalMs: number;
  /** WorkOS AuthKit settings. Null keeps human account claiming disabled. */
  workos: WorkOSConfig | null;
}

export interface WorkOSConfig {
  apiKey: string;
  clientId: string;
  redirectUri: string;
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
  assertPublicBaseUrlIsApiHost(publicBaseUrl, siteHostSuffix);
  const adminToken = env("SHAREPLAN_ADMIN_TOKEN") ?? null;
  const workos = normalizeWorkOSConfig(
    {
      apiKey: env("WORKOS_API_KEY"),
      clientId: env("WORKOS_CLIENT_ID"),
      redirectUri: env("WORKOS_REDIRECT_URI"),
    },
    publicBaseUrl,
  );

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
    adminTokenHash: adminToken ? hashApiKey(adminToken) : null,
    ipHashPepper: env("SHAREPLAN_IP_HASH_PEPPER") ?? null,
    trustForwarded: envBool("SHAREPLAN_TRUST_FORWARDED", false),
    registerPerDay: Math.max(1, envInt("SHAREPLAN_REGISTER_PER_DAY", 10)),
    versionRetention: Math.max(1, envInt("SHAREPLAN_VERSION_RETENTION", 2)),
    reapIntervalMs: Math.max(0, envInt("SHAREPLAN_REAP_INTERVAL_SEC", 300)) * 1000,
    workos,
  };
}

export function normalizeWorkOSConfig(
  values: {
    apiKey?: string;
    clientId?: string;
    redirectUri?: string;
  },
  publicBaseUrl: string,
): WorkOSConfig | null {
  const configured = [values.apiKey, values.clientId, values.redirectUri].filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== 3) {
    throw new Error(
      "WORKOS_API_KEY, WORKOS_CLIENT_ID, and WORKOS_REDIRECT_URI must all be set",
    );
  }

  let redirect: URL;
  let publicBase: URL;
  try {
    redirect = new URL(values.redirectUri!);
    publicBase = new URL(publicBaseUrl);
  } catch {
    throw new Error("WORKOS_REDIRECT_URI and SHAREPLAN_PUBLIC_BASE_URL must be absolute URLs");
  }
  if (!/^https?:$/.test(redirect.protocol) || redirect.origin !== publicBase.origin) {
    throw new Error("WORKOS_REDIRECT_URI must use the SHAREPLAN_PUBLIC_BASE_URL origin");
  }
  if (
    redirect.pathname !== WORKOS_CALLBACK_PATH ||
    redirect.search !== "" ||
    redirect.hash !== ""
  ) {
    throw new Error(`WORKOS_REDIRECT_URI must use the exact path ${WORKOS_CALLBACK_PATH}`);
  }

  return {
    apiKey: values.apiKey!,
    clientId: values.clientId!,
    redirectUri: values.redirectUri!,
  };
}

export function assertPublicBaseUrlIsApiHost(
  publicBaseUrl: string,
  siteHostSuffix: string | null,
): void {
  if (siteHostSuffix === null) return;
  let publicBase: URL;
  try {
    publicBase = new URL(publicBaseUrl);
  } catch {
    throw new Error("SHAREPLAN_PUBLIC_BASE_URL must be an absolute URL");
  }
  if (siteLabelFromHost(publicBase.host, siteHostSuffix) !== null) {
    throw new Error(
      "SHAREPLAN_PUBLIC_BASE_URL cannot be a site host under SHAREPLAN_SITE_HOST_SUFFIX",
    );
  }
}

/**
 * A hostname suffix is a bare domain like `share.example.com`: lowercase, no
 * scheme, no leading or trailing dot. Anything else is a misconfiguration
 * worth failing on at startup rather than serving 404s.
 */
export function normalizeSiteHostSuffix(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const suffix = raw.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
  if (suffix === "") return null;
  const labels = suffix.split(".");
  // Site hosts add one more label of up to 63 chars plus a dot, so the suffix
  // has to leave room for that inside the 253-char hostname limit.
  const ok = labels.length >= 2 && suffix.length <= 253 - 64 && labels.every(isHostLabel);
  if (!ok) {
    throw new Error(
      `SHAREPLAN_SITE_HOST_SUFFIX must be a bare domain like example.com, got "${raw}"`,
    );
  }
  return suffix;
}
