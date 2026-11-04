import { describe, expect, it } from "vitest";
import {
  assertPublicBaseUrlIsApiHost,
  describeConfigGaps,
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

  it("leaves S3 credentials to the SDK chain unless both SHAREPLAN_S3 keys are set", () => {
    const aws = { ...base, AWS_ACCESS_KEY_ID: "ASIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "s" };
    expect(loadConfig(aws).s3.credentials).toBeUndefined();
    expect(
      loadConfig({ ...base, SHAREPLAN_S3_ACCESS_KEY: "k", SHAREPLAN_S3_SECRET_KEY: "s" }).s3
        .credentials,
    ).toEqual({ accessKeyId: "k", secretAccessKey: "s" });
    expect(() => loadConfig({ ...base, SHAREPLAN_S3_ACCESS_KEY: "k" })).toThrow(/set together/);
  });

  it("fails at startup on an unparseable default ttl", () => {
    expect(loadConfig({ ...base, SHAREPLAN_DEFAULT_TTL: "30d" }).defaultTtl).toBe("30d");
    expect(() => loadConfig({ ...base, SHAREPLAN_DEFAULT_TTL: "30 days" })).toThrow(
      /SHAREPLAN_DEFAULT_TTL/,
    );
  });

  it("keeps the sweep interval inside what setInterval honours", () => {
    expect(loadConfig({ ...base, SHAREPLAN_REAP_INTERVAL_SEC: "3000000" }).reapIntervalMs).toBe(
      2_147_483_647,
    );
    expect(loadConfig({ ...base, SHAREPLAN_REAP_INTERVAL_SEC: "60" }).reapIntervalMs).toBe(60_000);
  });

  it("reads the client ip header name", () => {
    expect(loadConfig(base).clientIpHeader).toBeNull();
    const trusted = { ...base, SHAREPLAN_TRUST_FORWARDED: "true" };
    expect(
      loadConfig({ ...trusted, SHAREPLAN_CLIENT_IP_HEADER: " CF-Connecting-IP " }).clientIpHeader,
    ).toBe("cf-connecting-ip");
    expect(() => loadConfig({ ...trusted, SHAREPLAN_CLIENT_IP_HEADER: "x y" })).toThrow(
      /SHAREPLAN_CLIENT_IP_HEADER/,
    );
    expect(() => loadConfig({ ...base, SHAREPLAN_CLIENT_IP_HEADER: "cf-connecting-ip" })).toThrow(
      /needs SHAREPLAN_TRUST_FORWARDED/,
    );
  });

  it("refuses numbers it would only misuse", () => {
    expect(() => loadConfig({ ...base, SHAREPLAN_MAX_SITE_BYTES: "0" })).toThrow(/MAX_SITE_BYTES/);
    expect(() => loadConfig({ ...base, SHAREPLAN_MAX_SITE_BYTES: "-5" })).toThrow(/MAX_SITE_BYTES/);
    expect(() => loadConfig({ ...base, SHAREPLAN_MAX_FILE_COUNT: "2.5" })).toThrow(/MAX_FILE_COUNT/);
    expect(() => loadConfig({ ...base, SHAREPLAN_PORT: "99999" })).toThrow(/SHAREPLAN_PORT/);
    expect(() => loadConfig({ ...base, SHAREPLAN_PORT: "87.5" })).toThrow(/SHAREPLAN_PORT/);
    expect(loadConfig({ ...base, SHAREPLAN_PORT: "8080" }).port).toBe(8080);
  });

  it("wants the public base URL as a bare origin", () => {
    for (const url of ["https://share.example.com/app", "https://u:p@share.example.com", "https://share.example.com?x=1", "ftp://share.example.com"]) {
      expect(() => loadConfig({ ...base, SHAREPLAN_PUBLIC_BASE_URL: url }), url).toThrow(/bare http/);
    }
    expect(loadConfig({ ...base, SHAREPLAN_PUBLIC_BASE_URL: "https://share.example.com/" }).publicBaseUrl).toBe(
      "https://share.example.com",
    );
  });

  it("refuses a short admin token", () => {
    expect(() => loadConfig({ ...base, SHAREPLAN_ADMIN_TOKEN: "x" })).toThrow(/at least 16/);
    expect(loadConfig({ ...base, SHAREPLAN_ADMIN_TOKEN: "a-long-random-secret" }).adminTokenHash).not.toBeNull();
  });

  it("takes the AWS region when no custom endpoint is set", () => {
    expect(loadConfig({ ...base, AWS_REGION: "us-west-2" }).s3.region).toBe("us-west-2");
    expect(loadConfig({ ...base, AWS_DEFAULT_REGION: "eu-west-1" }).s3.region).toBe("eu-west-1");
    expect(
      loadConfig({ ...base, AWS_REGION: "us-west-2", SHAREPLAN_S3_ENDPOINT: "http://minio:9000" }).s3.region,
    ).toBe("auto");
    expect(loadConfig({ ...base, AWS_REGION: "us-west-2", SHAREPLAN_S3_REGION: "ca-central-1" }).s3.region).toBe(
      "ca-central-1",
    );
  });

  it("names the features a config leaves off", () => {
    const gaps = describeConfigGaps(loadConfig({ ...base, SHAREPLAN_HOST: "0.0.0.0" }));
    expect(gaps.join("\n")).toMatch(/SITE_HOST_SUFFIX is unset/);
    expect(gaps.join("\n")).toMatch(/ADMIN_TOKEN is unset/);
    expect(gaps.join("\n")).toMatch(/IP_HASH_PEPPER is unset/);
    expect(gaps.join("\n")).toMatch(/0\.0\.0\.0/);
  });
});
