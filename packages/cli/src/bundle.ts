import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SiteFileInput } from "@shareplan/core";

/**
 * Choose the wire form that reproduces `buf` byte for byte on the server.
 *
 * The server rebuilds a text upload with Buffer.from(content, "utf8"), so text
 * is safe only when that exact round-trip is lossless; sniffing by extension or
 * by absence of null bytes silently turns invalid UTF-8 into U+FFFD. base64 is
 * lossless for anything, so it is the fallback rather than the exception.
 */
function encodeFile(sitePath: string, buf: Buffer): SiteFileInput {
  // A null byte does survive the round-trip, but it has no business in a JSON
  // string; the scan also lets ordinary binaries skip the allocations below.
  if (!buf.includes(0)) {
    const text = buf.toString("utf8");
    if (Buffer.from(text, "utf8").equals(buf)) {
      return { path: sitePath, content: text };
    }
  }
  return { path: sitePath, contentBase64: buf.toString("base64") };
}

export function collectDirectory(dir: string): SiteFileInput[] {
  const root = path.resolve(dir);
  const files: SiteFileInput[] = [];

  function walk(current: string, relBase: string): void {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === "." || ent.name === ".." || ent.name === ".git" || ent.name === "node_modules") {
        continue;
      }
      const abs = path.join(current, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile()) {
        const buf = readFileSync(abs);
        const posixRel = rel.split(path.sep).join("/");
        files.push(encodeFile(posixRel, buf));
      }
    }
  }

  walk(root, "");
  if (files.length === 0) {
    throw new Error(`no files found in ${dir}`);
  }
  return files;
}

export function collectSingleFile(filePath: string): SiteFileInput[] {
  const abs = path.resolve(filePath);
  const buf = readFileSync(abs);
  const name = path.basename(abs);
  return [encodeFile(name, buf)];
}
