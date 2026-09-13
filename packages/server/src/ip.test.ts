import { describe, expect, it } from "vitest";
import { hashIp, normalizeIp } from "./ip.js";

describe("normalizeIp", () => {
  it("keeps IPv4", () => {
    expect(normalizeIp("203.0.113.10")).toBe("203.0.113.10");
  });

  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(normalizeIp("::ffff:203.0.113.10")).toBe("203.0.113.10");
  });

  it("reduces IPv6 to a /64", () => {
    expect(normalizeIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::");
    expect(normalizeIp("2001:db8:1:2::9")).toBe("2001:db8:1:2::");
  });
});

describe("hashIp", () => {
  it("is stable for the same address and pepper", () => {
    const a = hashIp("203.0.113.10", "pepper");
    const b = hashIp("203.0.113.10", "pepper");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("changes with the pepper", () => {
    expect(hashIp("203.0.113.10", "a")).not.toBe(hashIp("203.0.113.10", "b"));
  });
});
