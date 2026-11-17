import type { Config } from "./config.js";

/** Sites use the API host's scheme, including plain HTTP in development. */
export function siteScheme(config: Config): "http" | "https" {
  // Parsed rather than prefix-matched, so `HTTP://` agrees with the cookie code.
  return new URL(config.publicBaseUrl).protocol === "http:" ? "http" : "https";
}

/**
 * Sites also use the API host's port, so a server reached directly on a port
 * like 8788 prints links that load. Behind a proxy on 443 the port is empty.
 */
function sitePort(config: Config): string {
  const port = new URL(config.publicBaseUrl).port;
  return port === "" ? "" : `:${port}`;
}

/** The host part of a site URL: `<label>.<suffix>` plus the API host's port. */
export function siteHost(config: Config, label: string): string {
  return `${label}.${config.siteHostSuffix}${sitePort(config)}`;
}

export function siteUrl(config: Config, id: string): string {
  if (config.siteHostSuffix === null) {
    return `${config.publicBaseUrl}/s/${id}/`;
  }
  return `${siteScheme(config)}://${siteHost(config, id)}/`;
}
