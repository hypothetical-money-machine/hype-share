import type { Config } from "./config.js";

/** Sites use the API host's scheme, including plain HTTP in development. */
export function siteScheme(config: Config): "http" | "https" {
  return config.publicBaseUrl.startsWith("http://") ? "http" : "https";
}

export function siteUrl(config: Config, id: string): string {
  if (config.siteHostSuffix === null) {
    return `${config.publicBaseUrl}/s/${id}/`;
  }
  return `${siteScheme(config)}://${id}.${config.siteHostSuffix}/`;
}
