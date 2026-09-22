import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CliConfig {
  url: string;
  token: string;
}

/** What the loader returns: the saved config plus the env-only org join token. */
export type LoadedCliConfig = Partial<CliConfig> & { orgToken?: string };

export function configPath(): string {
  const base =
    process.env.SHAREPLAN_CONFIG ??
    path.join(os.homedir(), ".config", "shareplan", "config.json");
  return base;
}

export function loadCliConfig(): LoadedCliConfig {
  const fromEnv: LoadedCliConfig = {};
  if (process.env.SHAREPLAN_URL) fromEnv.url = process.env.SHAREPLAN_URL.replace(/\/$/, "");
  if (process.env.SHAREPLAN_TOKEN) fromEnv.token = process.env.SHAREPLAN_TOKEN;
  // The org join token is read from the environment only and never written to disk.
  if (process.env.SHAREPLAN_ORG_TOKEN) fromEnv.orgToken = process.env.SHAREPLAN_ORG_TOKEN;

  const p = configPath();
  if (!existsSync(p)) return fromEnv;

  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<CliConfig>;
    return {
      url: fromEnv.url ?? raw.url?.replace(/\/$/, ""),
      token: fromEnv.token ?? raw.token,
      ...(fromEnv.orgToken !== undefined ? { orgToken: fromEnv.orgToken } : {}),
    };
  } catch {
    return fromEnv;
  }
}

/** Writes url and token only, so an org join token can never end up in the file. */
export function saveCliConfig(cfg: CliConfig): void {
  const p = configPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const persisted: CliConfig = { url: cfg.url, token: cfg.token };
  writeFileSync(p, JSON.stringify(persisted, null, 2) + "\n", { mode: 0o600 });
}

export function requireConfig(): CliConfig {
  const cfg = loadCliConfig();
  if (!cfg.url || !cfg.token) {
    console.error(
      "Missing shareplan config. Run: shareplan login --url <url> --token <sp_...>\nor set SHAREPLAN_URL and SHAREPLAN_TOKEN.",
    );
    process.exit(1);
  }
  return { url: cfg.url, token: cfg.token };
}
