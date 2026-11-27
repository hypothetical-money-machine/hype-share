import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

/**
 * IPv4 as-is; IPv6 reduced to the /64 so one home network is one bucket.
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is treated as IPv4.
 */
export function normalizeIp(raw: string): string | null {
  let ip = raw.trim().toLowerCase();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith("::ffff:")) {
    const v4 = ip.slice(7);
    if (isIP(v4) === 4) return v4;
  }
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) === 6) return `${expandIPv6(ip).slice(0, 4).join(":")}::`;
  return null;
}

export function hashIp(ip: string, pepper: string): string {
  const normalized = normalizeIp(ip) ?? "invalid";
  return createHmac("sha256", pepper).update(normalized, "utf8").digest("hex");
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set from SHAREPLAN_CLIENT_IP_HEADER when that is configured and trusted. */
    clientIp: string;
  }
}

/**
 * The client address for rate limits and audit fields. With
 * SHAREPLAN_CLIENT_IP_HEADER configured (and SHAREPLAN_TRUST_FORWARDED on),
 * that header's address; otherwise Fastify's `req.ip`. When `trustForwarded`
 * is on, `trustProxy` is 1 hop, so `req.ip` is the address the immediate proxy
 * added, not the leftmost client-supplied `X-Forwarded-For` entry. Behind
 * Cloudflare plus a local proxy that hop is a Cloudflare edge, shared by every
 * client on it, which is why the header exists.
 */
export function requestIp(req: FastifyRequest): string {
  return req.clientIp || req.ip || "0.0.0.0";
}

/** The header's address if it holds exactly one valid IP, else null. */
export function clientIpFromHeader(req: FastifyRequest, header: string): string | null {
  const raw = req.headers[header];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return isIP(value) === 0 ? null : value;
}

function expandIPv6(ip: string): string[] {
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  return [...headParts, ...Array(missing).fill("0"), ...tailParts].map((p) => p || "0");
}
