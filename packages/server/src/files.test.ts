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

describe("prepareFiles base64", () => {
  const limits = { maxSiteBytes: 10000, maxFileCount: 10 };
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xbe, 0xef,
  ]);
  const standard = bytes.toString("base64");

  const decode = (contentBase64: string): Buffer =>
    prepareFiles([{ path: "photo.jpg", contentBase64 }], limits)[0]!.body;

  const failure = (contentBase64: string): FileError => {
    try {
      prepareFiles([{ path: "photo.jpg", contentBase64 }], limits);
    } catch (e) {
      if (e instanceof FileError) return e;
      throw e;
    }
    throw new Error(`expected a FileError for ${JSON.stringify(contentBase64)}`);
  };

  it("round-trips base64 to the exact bytes", () => {
    expect(decode(standard).equals(bytes)).toBe(true);
  });

  it("accepts line-wrapped base64", () => {
    const wrapped = `\n  ${standard.slice(0, 6)}\n  ${standard.slice(6)}\n`;
    expect(decode(wrapped).equals(bytes)).toBe(true);
  });

  it("accepts url-safe base64", () => {
    expect(standard).toMatch(/[+/]/);
    const urlSafe = standard
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(decode(urlSafe).equals(decode(standard))).toBe(true);
  });

  it("accepts unpadded base64", () => {
    expect(decode(standard.replace(/=+$/, "")).equals(bytes)).toBe(true);
  });

  it("rejects characters outside the base64 alphabet", () => {
    const err = failure(standard.replace("QSk", "Q$k"));
    expect(err.code).toBe("invalid_base64");
    expect(err.message).toContain("photo.jpg");
  });

  it("rejects a truncated payload of impossible length", () => {
    // 13 chars is 1 mod 4, which no encoder can produce.
    expect(failure(standard.slice(0, 13)).code).toBe("invalid_base64");
  });

  it("rejects misplaced padding", () => {
    expect(failure(`${standard.slice(0, 4)}==${standard.slice(4)}`).code).toBe(
      "invalid_base64",
    );
  });

  it("rejects payloads the raw decoder silently mangles", () => {
    const corrupt = standard.replace("QSk", "Q*k");
    // Node skips the stray character instead of throwing, so the old code stored
    // these bytes and reported success.
    const mangled = Buffer.from(corrupt, "base64");
    expect(mangled.byteLength).toBeGreaterThan(0);
    expect(mangled.equals(bytes)).toBe(false);

    expect(failure(corrupt).code).toBe("invalid_base64");
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
