import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SiteFileInput } from "@shareplan/core";
import { collectDirectory, collectSingleFile } from "./bundle.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "shareplan-bundle-"));
  dirs.push(dir);
  return dir;
}

function write(dir: string, rel: string, data: Buffer | string): string {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

/** Mirrors how the server turns a SiteFileInput back into stored bytes. */
function decode(file: SiteFileInput): Buffer {
  if (file.contentBase64 !== undefined) {
    return Buffer.from(file.contentBase64, "base64");
  }
  return Buffer.from(file.content ?? "", "utf8");
}

function pick(files: SiteFileInput[], sitePath: string): SiteFileInput {
  const found = files.find((f) => f.path === sitePath);
  if (!found) throw new Error(`missing ${sitePath} in ${files.map((f) => f.path).join(", ")}`);
  return found;
}

// Null-free, so the old "no nulls in the first 8k" sniff called it text.
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x41]);

describe("collectDirectory", () => {
  it("sends utf-8 text as content", () => {
    const dir = tempDir();
    const html = "<h1>héllo … 🌍</h1>\n";
    write(dir, "index.html", html);

    const file = pick(collectDirectory(dir), "index.html");
    expect(file.content).toBe(html);
    expect(file.contentBase64).toBeUndefined();
    expect(decode(file)).toEqual(Buffer.from(html, "utf8"));
  });

  it("sends null-free invalid utf-8 as base64 without mangling bytes", () => {
    const dir = tempDir();
    write(dir, "data.bin", PNG_HEADER);

    const file = pick(collectDirectory(dir), "data.bin");
    expect(file.content).toBeUndefined();
    expect(decode(file)).toEqual(PNG_HEADER);
  });

  it("sends invalid utf-8 as base64 even when the extension looks textual", () => {
    const dir = tempDir();
    const latin1 = Buffer.from("café naïve", "latin1");
    write(dir, "notes.txt", latin1);

    const file = pick(collectDirectory(dir), "notes.txt");
    expect(file.content).toBeUndefined();
    expect(decode(file)).toEqual(latin1);
  });

  it("detects invalid bytes past the first 8 KiB", () => {
    const dir = tempDir();
    const tail = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0xff, 0xfe])]);
    write(dir, "long.dat", tail);

    const file = pick(collectDirectory(dir), "long.dat");
    expect(file.content).toBeUndefined();
    expect(decode(file)).toEqual(tail);
  });

  it("sends files containing null bytes as base64", () => {
    const dir = tempDir();
    const withNulls = Buffer.from([0x61, 0x00, 0x62, 0x00, 0x00, 0x63]);
    write(dir, "nulls.dat", withNulls);

    const file = pick(collectDirectory(dir), "nulls.dat");
    expect(file.content).toBeUndefined();
    expect(decode(file)).toEqual(withNulls);
  });

  it("handles empty files", () => {
    const dir = tempDir();
    write(dir, "empty.css", "");

    const file = pick(collectDirectory(dir), "empty.css");
    expect(file.content).toBe("");
    expect(decode(file)).toHaveLength(0);
  });

  it("keeps a utf-8 BOM as text", () => {
    const dir = tempDir();
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi", "utf8")]);
    write(dir, "bom.html", bom);

    const file = pick(collectDirectory(dir), "bom.html");
    expect(file.contentBase64).toBeUndefined();
    expect(decode(file)).toEqual(bom);
  });

  it("walks nested directories with posix paths and skips vcs/deps", () => {
    const dir = tempDir();
    write(dir, "index.html", "<h1>hi</h1>");
    write(dir, path.join("assets", "img", "logo.png"), PNG_HEADER);
    write(dir, path.join(".git", "config"), "[core]");
    write(dir, path.join("node_modules", "pkg", "index.js"), "module.exports = 1;");

    const files = collectDirectory(dir);
    expect(files.map((f) => f.path).sort()).toEqual(["assets/img/logo.png", "index.html"]);
    expect(decode(pick(files, "assets/img/logo.png"))).toEqual(PNG_HEADER);
  });

  it("throws when the directory has no files", () => {
    const dir = tempDir();
    expect(() => collectDirectory(dir)).toThrow(/no files found/);
  });
});

describe("collectSingleFile", () => {
  it("sends an image as base64 under its basename", () => {
    const dir = tempDir();
    const abs = write(dir, path.join("nested", "chart.png"), PNG_HEADER);

    const files = collectSingleFile(abs);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("chart.png");
    expect(files[0]!.content).toBeUndefined();
    expect(decode(files[0]!)).toEqual(PNG_HEADER);
  });

  it("sends utf-8 text as content", () => {
    const dir = tempDir();
    const abs = write(dir, "page.html", "<p>ok ✓</p>");

    const files = collectSingleFile(abs);
    expect(files[0]!.content).toBe("<p>ok ✓</p>");
    expect(decode(files[0]!)).toEqual(Buffer.from("<p>ok ✓</p>", "utf8"));
  });

  it("sends an invalid-utf-8 file with a text extension as base64", () => {
    const dir = tempDir();
    const latin1 = Buffer.from("résumé", "latin1");
    const abs = write(dir, "resume.txt", latin1);

    const files = collectSingleFile(abs);
    expect(files[0]!.content).toBeUndefined();
    expect(decode(files[0]!)).toEqual(latin1);
  });

  it("handles an empty file", () => {
    const dir = tempDir();
    const abs = write(dir, "empty.txt", "");

    const files = collectSingleFile(abs);
    expect(files[0]!.content).toBe("");
    expect(decode(files[0]!)).toHaveLength(0);
  });
});
