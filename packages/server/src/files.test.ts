import { describe, expect, it } from "vitest";
import { ensureIndexHtml, prepareFiles, FileError } from "./files.js";

describe("prepareFiles", () => {
  it("prepares text files", () => {
    const files = prepareFiles(
      [{ path: "index.html", content: "<h1>hi</h1>" }],
      { maxSiteBytes: 10000, maxFileCount: 10 },
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("index.html");
    expect(files[0]!.body.toString("utf8")).toBe("<h1>hi</h1>");
  });

  it("rejects traversal", () => {
    expect(() =>
      prepareFiles([{ path: "../x", content: "a" }], {
        maxSiteBytes: 10000,
        maxFileCount: 10,
      }),
    ).toThrow(FileError);
  });
});

describe("ensureIndexHtml", () => {
  it("wraps a single image", () => {
    const out = ensureIndexHtml([
      { path: "photo.png", body: Buffer.from([1, 2, 3]) },
    ]);
    expect(out.some((f) => f.path === "index.html")).toBe(true);
    expect(out.some((f) => f.path === "photo.png")).toBe(true);
  });

  it("requires index for multi-file bundles", () => {
    expect(() =>
      ensureIndexHtml([
        { path: "a.css", body: Buffer.from("a") },
        { path: "b.js", body: Buffer.from("b") },
      ]),
    ).toThrow(FileError);
  });
});
