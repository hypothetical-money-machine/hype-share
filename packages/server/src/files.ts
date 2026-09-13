import {
  PathError,
  isAllowedUploadPath,
  sanitizeSitePath,
  type SiteFileInput,
} from "@shareplan/core";

export interface PreparedFile {
  path: string;
  body: Buffer;
}

export function prepareFiles(
  inputs: SiteFileInput[],
  limits: { maxSiteBytes: number; maxFileCount: number },
): PreparedFile[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new FileError("files_required", "at least one file is required");
  }
  if (inputs.length > limits.maxFileCount) {
    throw new FileError(
      "too_many_files",
      `at most ${limits.maxFileCount} files allowed`,
    );
  }

  const seen = new Set<string>();
  const out: PreparedFile[] = [];
  let total = 0;

  for (const input of inputs) {
    let path: string;
    try {
      path = sanitizeSitePath(input.path);
    } catch (e) {
      const msg = e instanceof PathError ? e.message : "invalid path";
      throw new FileError("invalid_path", msg);
    }
    if (seen.has(path)) {
      throw new FileError("duplicate_path", `duplicate path: ${path}`);
    }
    seen.add(path);
    if (!isAllowedUploadPath(path)) {
      throw new FileError(
        "file_type_not_allowed",
        `file type not allowed: ${path}`,
      );
    }

    let body: Buffer;
    if (input.contentBase64 !== undefined && input.contentBase64 !== null) {
      body = decodeBase64(input.contentBase64, path);
    } else if (input.content !== undefined && input.content !== null) {
      body = Buffer.from(input.content, "utf8");
    } else {
      throw new FileError("empty_file", `file ${path} has no content`);
    }

    total += body.byteLength;
    if (total > limits.maxSiteBytes) {
      throw new FileError(
        "site_too_large",
        `site exceeds max size of ${limits.maxSiteBytes} bytes`,
      );
    }
    out.push({ path, body });
  }

  return out;
}

export function ensureIndexHtml(files: PreparedFile[]): PreparedFile[] {
  const hasIndex = files.some(
    (f) => f.path === "index.html" || f.path === "index.htm",
  );
  if (hasIndex) return files;

  // Single non-html file: wrap or leave as-is (serve will use first html or direct)
  if (files.length === 1) {
    const only = files[0]!;
    const lower = only.path.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      // Rename to index.html for clean URL
      return [{ path: "index.html", body: only.body }];
    }
    const isImage = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(only.path);
    let body: string;
    if (isImage) {
      body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(only.path)}</title><style>body{margin:0;background:#111;display:grid;place-items:center;min-height:100vh}img{max-width:100%;max-height:100vh}</style><img src="${escapeAttr(only.path)}" alt="">`;
    } else {
      body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(only.path)}</title><style>body{font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem}</style><p><a href="${escapeAttr(only.path)}">Download ${escapeHtml(only.path)}</a></p>`;
    }
    return [only, { path: "index.html", body: Buffer.from(body, "utf8") }];
  }

  throw new FileError(
    "index_required",
    "site bundles with multiple files require index.html",
  );
}

/**
 * Node's base64 decoder never throws: it drops characters outside the alphabet and
 * truncates, so a corrupt payload would be stored as mangled bytes and reported as a
 * successful upload. Validate before decoding instead.
 */
function decodeBase64(value: string, path: string): Buffer {
  // Agents routinely line-wrap long base64 inside JSON, and both the standard (+/) and
  // url-safe (-_) alphabets decode to the same bytes here, so tolerate both rather than
  // failing payloads that are perfectly recoverable.
  const unpadded = value.replace(/\s+/g, "").replace(/={1,2}$/, "");
  // A length of 1 mod 4 carries a lone leftover sextet, which no encoder can emit.
  if (!/^[A-Za-z0-9+/\-_]*$/.test(unpadded) || unpadded.length % 4 === 1) {
    throw new FileError("invalid_base64", `invalid base64 for ${path}`);
  }
  return Buffer.from(unpadded, "base64");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

export class FileError extends Error {
  override readonly name = "FileError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
