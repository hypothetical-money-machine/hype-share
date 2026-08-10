import type { CreateSiteRequest, SiteListItem, SiteResponse } from "@shareplan/core";
import type { CliConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  cfg: CliConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { code: "invalid_json", message: text.slice(0, 200) } };
    }
  }

  if (!res.ok) {
    const err = data as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      res.status,
      err?.error?.code ?? "http_error",
      err?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return data as T;
}

export function createSite(cfg: CliConfig, body: CreateSiteRequest): Promise<SiteResponse> {
  return request(cfg, "POST", "/api/v1/sites", body);
}

export function updateSite(
  cfg: CliConfig,
  id: string,
  body: CreateSiteRequest,
): Promise<SiteResponse> {
  return request(cfg, "PUT", `/api/v1/sites/${encodeURIComponent(id)}`, body);
}

export function listSites(cfg: CliConfig): Promise<{ sites: SiteListItem[] }> {
  return request(cfg, "GET", "/api/v1/sites");
}

export function getSite(cfg: CliConfig, id: string): Promise<SiteResponse> {
  return request(cfg, "GET", `/api/v1/sites/${encodeURIComponent(id)}`);
}

export function deleteSite(cfg: CliConfig, id: string): Promise<void> {
  return request(cfg, "DELETE", `/api/v1/sites/${encodeURIComponent(id)}`);
}

export function createKey(
  baseUrl: string,
  adminToken: string,
  name: string,
): Promise<{ id: string; name: string; token: string; createdAt: string }> {
  return request({ url: baseUrl.replace(/\/$/, ""), token: adminToken }, "POST", "/api/v1/admin/keys", {
    name,
  });
}
