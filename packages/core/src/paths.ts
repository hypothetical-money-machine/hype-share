/**
 * Sanitize a relative path for site bundle storage.
 * Rejects absolute paths, traversal, null bytes, and empty segments.
 *
 * Idempotent: sanitizing an already-sanitized path returns it unchanged and
 * never throws. Callers rely on that — prepareFiles and the serve route both
 * sanitize, then hand the result to s3ObjectKey, which sanitizes again — so a
 * shape that only fails on the second pass surfaces as an uncaught PathError.
 * Every check below therefore runs against the normalized form.
 */
export function sanitizeSitePath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new PathError("path is required");
  }
  if (raw.includes("\0")) {
    throw new PathError("path contains null byte");
  }

  const p = raw.replace(/\\/g, "/").trim();
  if (p.startsWith("/")) {
    throw new PathError("absolute paths are not allowed");
  }

  // Segments are trimmed individually, not just the path as a whole: a
  // whitespace-only segment ("./ /x") would otherwise survive into the result
  // and be read as a leading slash — an absolute path — on the next pass.
  const segments = p
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) {
    throw new PathError("path is empty after normalization");
  }
  for (const seg of segments) {
    if (seg === "..") {
      throw new PathError("path traversal is not allowed");
    }
  }

  const normalized = segments.join("/");
  // After normalization, not before: "./C:foo" normalizes to "C:foo", so a
  // check on the raw input would let it through here and reject it on re-entry.
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new PathError("drive-letter paths are not allowed");
  }
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
