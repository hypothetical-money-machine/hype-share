import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { siteUrl } from "./site-url.js";

function config(base: string, suffix?: string) {
  return loadConfig({
    SHAREPLAN_DATA_DIR: "/tmp/shareplan-site-url-test",
    SHAREPLAN_PUBLIC_BASE_URL: base,
    ...(suffix ? { SHAREPLAN_SITE_HOST_SUFFIX: suffix } : {}),
  });
}

describe("siteUrl", () => {
  it("uses the API host's scheme and no port behind a proxy", () => {
    expect(siteUrl(config("https://share.example.com", "share.example.com"), "abc")).toBe(
      "https://abc.share.example.com/",
    );
  });

  it("keeps the API host's port so a directly reached server prints links that load", () => {
    expect(siteUrl(config("http://localtest.me:8788", "localtest.me"), "abc")).toBe(
      "http://abc.localtest.me:8788/",
    );
  });

  it("reads the scheme case-insensitively", () => {
    expect(siteUrl(config("HTTP://localtest.me:8788", "localtest.me"), "abc")).toBe(
      "http://abc.localtest.me:8788/",
    );
  });

  it("falls back to paths on the API host without a suffix", () => {
    expect(siteUrl(config("http://127.0.0.1:8788"), "abc")).toBe("http://127.0.0.1:8788/s/abc/");
  });
});
