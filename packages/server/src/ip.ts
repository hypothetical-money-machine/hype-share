import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

/**
 * IPv4 as-is; IPv6 reduced to the /64 so one home network is one bucket.
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is treated as IPv4.
 */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith("::ffff:")) {
    const v4 = ip.slice(7);
    if (isIP(v4) === 4) return v4;
  }
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) === 6) return `${expandIPv6(ip).slice(0, 4).join(":")}::`;
  return ip;
}

export function hashIp(ip: string, pepper: string): string {
  return createHmac("sha256", pepper).update(normalizeIp(ip), "utf8").digest("hex");
}

/**
 * Socket address by default. `CF-Connecting-IP` / `X-Forwarded-For` only when
 * `trustForwarded` is on; otherwise a client could pick its own bucket.
 */
export function requestIp(req: FastifyRequest, trustForwarded: boolean): string {
  if (trustForwarded) {
    const cf = headerValue(req.headers["cf-connecting-ip"]);
    if (cf) return cf;
    const xff = headerValue(req.headers["x-forwarded-for"]);
    if (xff) return xff.split(",")[0]!.trim();
  }
  return req.ip || "0.0.0.0";
}

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v === "" ? null : v;
}

function expandIPv6(ip: string): string[] {
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  return [...headParts, ...Array(missing).fill("0"), ...tailParts].map((p) => p || "0");
}
