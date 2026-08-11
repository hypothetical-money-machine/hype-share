import { describe, expect, it } from "vitest";
import { PathError, sanitizeSitePath, s3ObjectKey } from "./paths.js";

describe("sanitizeSitePath", () => {
  it("normalizes relative paths", () => {
    expect(sanitizeSitePath("index.html")).toBe("index.html");
    expect(sanitizeSitePath("./assets/style.css")).toBe("assets/style.css");
    expect(sanitizeSitePath("a/b/c.js")).toBe("a/b/c.js");
  });

  it("rejects traversal and absolute paths", () => {
    expect(() => sanitizeSitePath("../etc/passwd")).toThrow(PathError);
    expect(() => sanitizeSitePath("/etc/passwd")).toThrow(PathError);
    expect(() => sanitizeSitePath("foo/../../bar")).toThrow(PathError);
    expect(() => sanitizeSitePath("")).toThrow(PathError);
  });

  it("rejects drive letters however they are dressed up", () => {
    // "./C:foo" used to normalize to "C:foo" and only fail on the next pass,
    // which meant a PathError from deep inside s3ObjectKey.
    for (const shape of ["C:foo", "./C:foo", ".\\C:foo", "././C:foo", "./x:y/z", "./D:"]) {
      expect(() => sanitizeSitePath(shape), shape).toThrow(PathError);
    }
  });

  it("is idempotent, so callers can re-sanitize what it returned", () => {
    const shapes = [
      "index.html",
      "./assets/style.css",
      "a//b/c.txt",
      "a/./b.txt",
      "docs ",
      " a/b ",
      "a/ b /c",
      "./ /x",
      "dot.name.v2.js",
      "foo..bar",
      "ünïcødé/naïve.txt",
      "space file.txt",
      "x".repeat(512),
      "C:foo",
      "../secret",
      "/etc/passwd",
      "a\0b",
      "",
      "   ",
      "x".repeat(600),
    ];
    for (const shape of shapes) {
      let once: string;
      try {
        once = sanitizeSitePath(shape);
      } catch (e) {
        expect(e, shape).toBeInstanceOf(PathError);
        continue;
      }
      expect(sanitizeSitePath(once), shape).toBe(once);
      expect(() => s3ObjectKey("abc", "v1", once), shape).not.toThrow();
    }
  });

  it("builds s3 keys", () => {
    expect(s3ObjectKey("abc", "v1", "index.html")).toBe("sites/abc/v/v1/index.html");
  });
});
