import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CliConfig {
  url: string;
  token: string;
}

export function configPath(): string {
  const base =
    process.env.SHAREPLAN_CONFIG ??
    path.join(os.homedir(), ".config", "shareplan", "config.json");
  return base;
}

export function loadCliConfig(): Partial<CliConfig> {
  const fromEnv: Partial<CliConfig> = {};
  if (process.env.SHAREPLAN_URL) fromEnv.url = process.env.SHAREPLAN_URL.replace(/\/$/, "");
  if (process.env.SHAREPLAN_TOKEN) fromEnv.token = process.env.SHAREPLAN_TOKEN;

  const p = configPath();
  if (!existsSync(p)) return fromEnv;

  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<CliConfig>;
    return {
      url: fromEnv.url ?? raw.url?.replace(/\/$/, ""),
      token: fromEnv.token ?? raw.token,
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
