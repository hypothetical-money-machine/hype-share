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

  it("builds s3 keys", () => {
    expect(s3ObjectKey("abc", "v1", "index.html")).toBe("sites/abc/v/v1/index.html");
  });
});
