import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCreateOrgBody,
  buildPublishBody,
  deletedLine,
  isCliEntrypoint,
  printable,
  removedLine,
  resolveOrgToken,
} from "./cli.js";
import { loadCliConfig, saveCliConfig, type CliConfig } from "./config.js";
import type { SiteFileInput } from "@shareplan/core";

const files: SiteFileInput[] = [{ path: "index.html", content: "<h1>hi</h1>" }];

describe("buildPublishBody", () => {
  it("omits visibility when the flag is absent", () => {
    const body = buildPublishBody(files, {});
    expect("visibility" in body).toBe(false);
    expect(body.files).toBe(files);
  });

  it("omits visibility on update so an existing site keeps its own", () => {
    const body = buildPublishBody(files, { site: "s_abc", note: "v2" });
    expect("visibility" in body).toBe(false);
    expect(body.note).toBe("v2");
  });

  it("sends an explicit visibility", () => {
    for (const visibility of ["public", "unlisted", "private"] as const) {
      expect(buildPublishBody(files, { visibility }).visibility).toBe(visibility);
    }
  });

  it("passes through the other publish options", () => {
    const body = buildPublishBody(files, {
      title: "Demo",
      ttl: "7d",
      note: "first",
      slug: "demo",
    });
    expect(body).toMatchObject({ title: "Demo", ttl: "7d", note: "first", slug: "demo" });
  });

  it("sends ttl: null for --ttl none and omits ttl when absent", () => {
    expect(buildPublishBody(files, { ttl: "none" }).ttl).toBeNull();
    expect(buildPublishBody(files, { ttl: "7d" }).ttl).toBe("7d");
    expect("ttl" in buildPublishBody(files, {})).toBe(false);
  });

  it("rejects an unknown visibility client-side", () => {
    expect(() => buildPublishBody(files, { visibility: "bogus" })).toThrow(
      /invalid --visibility "bogus"/,
    );
  });
});

describe("buildCreateOrgBody", () => {
  it("rejects --publish-per-hour without --tier client-side", () => {
    expect(() => buildCreateOrgBody({ name: "SkySlope", publishPerHour: 5 })).toThrow(
      /--publish-per-hour needs --tier/,
    );
  });

  it("sends the pool with its tier and omits absent options", () => {
    expect(buildCreateOrgBody({ name: "SkySlope", tier: "paid", publishPerHour: 5 })).toEqual({
      name: "SkySlope",
      compTier: "paid",
      publishPerHour: 5,
    });
    expect(buildCreateOrgBody({ name: "SkySlope" })).toEqual({ name: "SkySlope" });
  });
});

describe("resolveOrgToken", () => {
  it("prefers the flag over the environment", () => {
    expect(resolveOrgToken("org_flag", "org_env")).toBe("org_flag");
  });

  it("falls back to the environment", () => {
    expect(resolveOrgToken(undefined, "org_env")).toBe("org_env");
  });

  it("is undefined when neither is set", () => {
    expect(resolveOrgToken(undefined, undefined)).toBeUndefined();
    expect(resolveOrgToken("", "")).toBeUndefined();
  });
});

describe("printable", () => {
  it("replaces C0, DEL and C1 control characters with U+FFFD", () => {
    // ESC-driven erase-and-redraw, the sequence a rogue key name would use.
    expect(printable("bot\x1b[2K\rfake row")).toBe("bot�[2K�fake row");
    expect(printable("a\x00b\nc\td\x7fe")).toBe("a�b�c�d�e");
    // C1: NEL and the 8-bit CSI.
    expect(printable("x\x85y\x9bz")).toBe("x�y�z");
  });

  it("leaves printable text, including non-ASCII, untouched", () => {
    for (const s of ["deploy-bot", "café  ~!@#", "日本語", "emoji 🚀", ""]) {
      expect(printable(s)).toBe(s);
    }
  });
});

describe("removedLine", () => {
  it("reports clamped sites and revoked keys from the single removal response", () => {
    expect(removedLine({ userId: "u_1", clampedSites: 3, revokedKeys: 2 })).toBe(
      "removed u_1 (clamped 3 sites, revoked 2 keys)",
    );
  });

  it("still prints revoked 0 keys when --revoke-keys was not passed", () => {
    expect(removedLine({ userId: "u_1", clampedSites: 1, revokedKeys: 0 })).toBe(
      "removed u_1 (clamped 1 site, revoked 0 keys)",
    );
    expect(removedLine({ userId: "u_2", clampedSites: 0, revokedKeys: 1 })).toBe(
      "removed u_2 (clamped 0 sites, revoked 1 key)",
    );
  });
});

describe("deletedLine", () => {
  it("counts skipped members as detached, since the server detaches every member", () => {
    expect(deletedLine("org_1", { users: 4, sites: 6, skipped: 1 })).toBe(
      "deleted org_1 (detached 5 users, clamped 6 sites, skipped 1 user)",
    );
  });

  it("omits the skipped part when nobody was skipped", () => {
    expect(deletedLine("org_1", { users: 1, sites: 0, skipped: 0 })).toBe(
      "deleted org_1 (detached 1 user, clamped 0 sites)",
    );
  });
});

describe("org token and the config file", () => {
  const saved = {
    SHAREPLAN_CONFIG: process.env.SHAREPLAN_CONFIG,
    SHAREPLAN_ORG_TOKEN: process.env.SHAREPLAN_ORG_TOKEN,
    SHAREPLAN_URL: process.env.SHAREPLAN_URL,
    SHAREPLAN_TOKEN: process.env.SHAREPLAN_TOKEN,
  };
  const dirs: string[] = [];

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function configFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "shareplan-config-"));
    dirs.push(dir);
    const file = path.join(dir, "config.json");
    process.env.SHAREPLAN_CONFIG = file;
    return file;
  }

  it("leaves SHAREPLAN_ORG_TOKEN out of the loaded config; commands read it themselves", () => {
    const file = configFile();
    delete process.env.SHAREPLAN_URL;
    delete process.env.SHAREPLAN_TOKEN;
    process.env.SHAREPLAN_ORG_TOKEN = "org_" + "a".repeat(43);
    writeFileSync(file, JSON.stringify({ url: "https://x.test", token: "sp_saved" }));
    expect(loadCliConfig()).toEqual({ url: "https://x.test", token: "sp_saved" });
  });

  it("never writes the org token to the config file", () => {
    const file = configFile();
    process.env.SHAREPLAN_ORG_TOKEN = "org_" + "b".repeat(43);
    saveCliConfig({ url: "https://x.test", token: "sp_new" });
    expect(readFileSync(file, "utf8")).not.toContain("org_");

    // A config object carrying extra fields is written back as url and token only.
    const widened = { url: "https://x.test", token: "sp_new", orgToken: "org_" + "b".repeat(43) };
    saveCliConfig(widened as CliConfig);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("org_");
    expect(JSON.parse(raw)).toEqual({ url: "https://x.test", token: "sp_new" });
  });
});

describe("isCliEntrypoint", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(): { target: string; link: string; other: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "shareplan-entry-"));
    dirs.push(dir);
    const target = path.join(dir, "cli.js");
    const link = path.join(dir, "shareplan");
    const other = path.join(dir, "other.js");
    writeFileSync(target, "");
    writeFileSync(other, "");
    symlinkSync(target, link);
    return { target, link, other };
  }

  it("recognizes the entrypoint through a bin symlink", () => {
    const { target, link } = fixture();
    expect(isCliEntrypoint(target, target)).toBe(true);
    expect(isCliEntrypoint(link, target)).toBe(true);
  });

  it("recognizes it when the module path is itself unresolved", () => {
    // --preserve-symlinks-main leaves import.meta.filename as the symlink, so
    // resolving only argv[1] made the CLI a silent no-op.
    const { link } = fixture();
    expect(isCliEntrypoint(link, link)).toBe(true);
  });

  it("stays quiet when another module is the entrypoint", () => {
    const { target, other } = fixture();
    expect(isCliEntrypoint(other, target)).toBe(false);
    expect(isCliEntrypoint(undefined, target)).toBe(false);
    expect(isCliEntrypoint(path.join(path.dirname(target), "gone.js"), target)).toBe(false);
  });
});
