import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SiteFileInput } from "@shareplan/core";

const TEXT_EXT = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".svg",
  ".txt",
  ".md",
  ".xml",
  ".map",
  ".csv",
]);

function isProbablyText(filePath: string, buf: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  // Heuristic: no null bytes in first 8k
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return !sample.includes(0);
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
        const st = statSync(abs);
        if (st.size === 0 && !rel.endsWith(".html")) {
          // allow empty files but still include
        }
        const buf = readFileSync(abs);
        const posixRel = rel.split(path.sep).join("/");
        if (isProbablyText(posixRel, buf)) {
          files.push({ path: posixRel, content: buf.toString("utf8") });
        } else {
          files.push({ path: posixRel, contentBase64: buf.toString("base64") });
        }
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
  if (isProbablyText(name, buf)) {
    return [{ path: name, content: buf.toString("utf8") }];
  }
  return [{ path: name, contentBase64: buf.toString("base64") }];
}
