import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPublishBody, isCliEntrypoint } from "./cli.js";
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

  it("rejects an unknown visibility client-side", () => {
    expect(() => buildPublishBody(files, { visibility: "bogus" })).toThrow(
      /invalid --visibility "bogus"/,
    );
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
