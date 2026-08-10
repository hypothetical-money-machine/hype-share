import { mkdirSync } from "node:fs";
import path from "node:path";

export interface Config {
  host: string;
  port: number;
  publicBaseUrl: string;
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
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function loadConfig(envSource: NodeJS.ProcessEnv = process.env): Config {
  // Allow tests to pass a custom env object by temporarily assigning — we read process.env
  // but call sites can set process.env before invoking.
  void envSource;
  const dataDir = path.resolve(env("SHAREPLAN_DATA_DIR", "./data")!);
  mkdirSync(dataDir, { recursive: true });

  const port = envInt("SHAREPLAN_PORT", 8788);
  const host = env("SHAREPLAN_HOST", "127.0.0.1")!;
  const publicBaseUrl = (env("SHAREPLAN_PUBLIC_BASE_URL", `http://${host}:${port}`)!).replace(
    /\/$/,
    "",
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
  };
}
