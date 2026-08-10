/**
 * Sanitize a relative path for site bundle storage.
 * Rejects absolute paths, traversal, null bytes, and empty segments.
 */
export function sanitizeSitePath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new PathError("path is required");
  }
  if (raw.includes("\0")) {
    throw new PathError("path contains null byte");
  }

  let p = raw.replace(/\\/g, "/").trim();
  if (p.startsWith("/")) {
    throw new PathError("absolute paths are not allowed");
  }
  if (/^[a-zA-Z]:/.test(p)) {
    throw new PathError("drive-letter paths are not allowed");
  }

  // Strip leading ./
  while (p.startsWith("./")) {
    p = p.slice(2);
  }

  const segments = p.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) {
    throw new PathError("path is empty after normalization");
  }
  for (const seg of segments) {
    if (seg === "..") {
      throw new PathError("path traversal is not allowed");
    }
    if (seg === "." || seg.includes("\0")) {
      throw new PathError("invalid path segment");
    }
  }

  const normalized = segments.join("/");
  if (normalized.length > 512) {
    throw new PathError("path too long");
  }
  return normalized;
}

export class PathError extends Error {
  override readonly name = "PathError";
  constructor(message: string) {
    super(message);
  }
}

export function s3ObjectKey(siteId: string, versionId: string, relPath: string): string {
  const safe = sanitizeSitePath(relPath);
  return `sites/${siteId}/v/${versionId}/${safe}`;
}

export function s3VersionPrefix(siteId: string, versionId: string): string {
  return `sites/${siteId}/v/${versionId}/`;
}

export function s3SitePrefix(siteId: string): string {
  return `sites/${siteId}/`;
}
