import { describe, expect, it } from "vitest";
import {
  assertPublicBaseUrlIsApiHost,
  loadConfig,
  normalizeSiteHostSuffix,
  normalizeWorkOSConfig,
  WORKOS_CALLBACK_PATH,
} from "./config.js";

describe("normalizeSiteHostSuffix", () => {
  it("accepts a bare domain and tidies it", () => {
    expect(normalizeSiteHostSuffix("share.example.com")).toBe("share.example.com");
    expect(normalizeSiteHostSuffix(" .Share.Example.COM. ")).toBe("share.example.com");
  });

  it("treats unset and blank as disabled", () => {
    expect(normalizeSiteHostSuffix(undefined)).toBeNull();
    expect(normalizeSiteHostSuffix("")).toBeNull();
    expect(normalizeSiteHostSuffix("  ")).toBeNull();
  });

  it("rejects schemes, wildcards, single labels, and bad dns labels", () => {
    const bad = [
      "https://share.example.com",
      "*.share.example.com",
      "localhost",
      "a b.com",
      "sites.example.org/",
      "-bad.example",
      "bad-.example",
      "a..b",
      `${"x".repeat(64)}.example`,
      `${"y".repeat(63)}.`.repeat(3) + "example",
    ];
    for (const b of bad) {
      expect(() => normalizeSiteHostSuffix(b), b).toThrow(/bare domain/);
    }
    expect(normalizeSiteHostSuffix(`${"x".repeat(63)}.example`)).toBe(`${"x".repeat(63)}.example`);
  });
});

describe("normalizeWorkOSConfig", () => {
  const publicBaseUrl = "https://share.example.com";

  it("keeps AuthKit disabled when no WorkOS settings are present", () => {
    expect(normalizeWorkOSConfig({}, publicBaseUrl)).toBeNull();
  });

  it("requires the complete WorkOS configuration", () => {
    expect(() =>
      normalizeWorkOSConfig({ apiKey: "sk_test" }, publicBaseUrl),
    ).toThrow(/must all be set/);
  });

  it("accepts a callback on the public API origin", () => {
    expect(
      normalizeWorkOSConfig(
        {
          apiKey: "sk_test",
          clientId: "client_test",
          redirectUri: "https://share.example.com/v1/auth/workos/callback",
        },
        publicBaseUrl,
      ),
    ).toEqual({
      apiKey: "sk_test",
      clientId: "client_test",
      redirectUri: "https://share.example.com/v1/auth/workos/callback",
    });
  });

  it("preserves the configured redirect URI after validating it", () => {
    const redirectUri = `https://Share.Example.com${WORKOS_CALLBACK_PATH}`;
    expect(
      normalizeWorkOSConfig(
        { apiKey: "sk_test", clientId: "client_test", redirectUri },
        publicBaseUrl,
      )?.redirectUri,
    ).toBe(redirectUri);
  });

  it("rejects a callback on another origin", () => {
    expect(() =>
      normalizeWorkOSConfig(
        {
          apiKey: "sk_test",
          clientId: "client_test",
          redirectUri: "https://other.example.com/callback",
        },
        publicBaseUrl,
      ),
    ).toThrow(/public_base_url origin/i);
  });

  it("rejects the wrong callback path, query, or fragment", () => {
    const bad = [
      "https://share.example.com/api/v1/auth/workos/callback",
      `https://share.example.com${WORKOS_CALLBACK_PATH}/`,
      `https://share.example.com${WORKOS_CALLBACK_PATH}?next=/`,
      `https://share.example.com${WORKOS_CALLBACK_PATH}#done`,
    ];
    for (const redirectUri of bad) {
      expect(() =>
        normalizeWorkOSConfig(
          { apiKey: "sk_test", clientId: "client_test", redirectUri },
          publicBaseUrl,
        ),
      ).toThrow(new RegExp(WORKOS_CALLBACK_PATH));
    }
  });
});

describe("assertPublicBaseUrlIsApiHost", () => {
  it("rejects an API URL that hostname serving intercepts as a site", () => {
    expect(() =>
      assertPublicBaseUrlIsApiHost("https://api.example.com", "example.com"),
    ).toThrow(/public_base_url.*site host.*site_host_suffix/i);
  });

  it("accepts the suffix apex and configurations without hostname serving", () => {
    expect(() =>
      assertPublicBaseUrlIsApiHost("https://example.com", "example.com"),
    ).not.toThrow();
    expect(() =>
      assertPublicBaseUrlIsApiHost("https://api.example.com", null),
    ).not.toThrow();
  });
});

describe("loadConfig", () => {
  const base = { SHAREPLAN_DATA_DIR: "/tmp" };

  it("reads the org register limit with a default of 100 and a floor of 1", () => {
    expect(loadConfig(base).orgRegisterPerDay).toBe(100);
    expect(loadConfig({ ...base, SHAREPLAN_ORG_REGISTER_PER_DAY: "5" }).orgRegisterPerDay).toBe(5);
    expect(loadConfig({ ...base, SHAREPLAN_ORG_REGISTER_PER_DAY: "0" }).orgRegisterPerDay).toBe(1);
    expect(() => loadConfig({ ...base, SHAREPLAN_ORG_REGISTER_PER_DAY: "x" })).toThrow(
      /must be a number/,
    );
  });
});
