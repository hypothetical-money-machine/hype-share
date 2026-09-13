import { describe, expect, it } from "vitest";
import { contentTypeForPath, isAllowedUploadPath } from "./mime.js";

describe("isAllowedUploadPath", () => {
  it("allows html and page assets", () => {
    const allowed = [
      "index.html",
      "page.HTM",
      "assets/style.css",
      "app.js",
      "mod.mjs",
      "data.json",
      "notes.txt",
      "readme.md",
      "photo.png",
      "photo.jpg",
      "photo.jpeg",
      "anim.gif",
      "shot.webp",
      "shot.avif",
      "icon.svg",
      "favicon.ico",
      "font.woff",
      "font.woff2",
    ];
    for (const path of allowed) {
      expect(isAllowedUploadPath(path), path).toBe(true);
    }
  });

  it("rejects video, audio, archives, wasm, pdf, and unknown types", () => {
    const rejected = [
      "clip.mp4",
      "clip.webm",
      "clip.mov",
      "track.mp3",
      "track.wav",
      "track.ogg",
      "site.zip",
      "app.wasm",
      "doc.pdf",
      "file.exe",
      "blob",
      "Makefile",
      "photo.",
      "source.map",
      "font.ttf",
    ];
    for (const path of rejected) {
      expect(isAllowedUploadPath(path), path).toBe(false);
    }
  });
});

describe("contentTypeForPath", () => {
  it("still maps types that cannot be uploaded", () => {
    expect(contentTypeForPath("clip.mp4")).toBe("video/mp4");
    expect(contentTypeForPath("site.zip")).toBe("application/zip");
    expect(contentTypeForPath("blob")).toBe("application/octet-stream");
  });
});
