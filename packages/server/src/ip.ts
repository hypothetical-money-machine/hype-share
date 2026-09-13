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

/**
 * Fastify's `req.ip`. When `trustForwarded` is on, `trustProxy` is 1 hop so
 * this is the address the immediate proxy added, not the leftmost
 * client-supplied `X-Forwarded-For` entry.
 */
export function requestIp(req: FastifyRequest): string {
  return req.ip || "0.0.0.0";
}

function expandIPv6(ip: string): string[] {
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  return [...headParts, ...Array(missing).fill("0"), ...tailParts].map((p) => p || "0");
}
