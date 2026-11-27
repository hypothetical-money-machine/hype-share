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

export interface CollectOptions {
  /** Told about each entry left out, so the caller can say so on stderr. */
  onSkip?: (relPath: string, reason: "hidden" | "symlink" | "special") => void;
}

/**
 * Every regular file under `dir`. Hidden entries (".DS_Store", ".vscode",
 * ".claude", ".env") are left out: they are editor and tool state, never page
 * assets, and the server's allowlist would reject most of them, failing the
 * whole publish. Symlinks are left out too, rather than followed out of the
 * directory; both are reported through `onSkip`.
 */
export function collectDirectory(dir: string, opts: CollectOptions = {}): SiteFileInput[] {
  const root = path.resolve(dir);
  const files: SiteFileInput[] = [];

  function walk(current: string, relBase: string): void {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === "node_modules") continue;
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      const posixRel = rel.split(path.sep).join("/");
      if (ent.name.startsWith(".")) {
        // .git is always noise; anything else hidden is worth a mention.
        if (ent.name !== ".git") opts.onSkip?.(posixRel, "hidden");
        continue;
      }
      const abs = path.join(current, ent.name);
      if (ent.isSymbolicLink()) {
        opts.onSkip?.(posixRel, "symlink");
      } else if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile()) {
        files.push(encodeFile(posixRel, readFileSync(abs)));
      } else {
        opts.onSkip?.(posixRel, "special");
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
