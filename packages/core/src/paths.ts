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
  // S3 names keys in XML bodies (DeleteObjects, listings), and XML 1.0 cannot
  // carry C0 controls, U+FFFE/U+FFFF, or lone surrogates. A key like that
  // uploads fine (PutObject percent-encodes it into the URL) but can never be
  // deleted again, and a lone surrogate makes the SDK throw mid-upload.
  if (/[\u0001-\u001f\u007f\ufffe\uffff]/.test(raw)) {
    throw new PathError("path contains a control character");
  }
  if (LONE_SURROGATE_RE.test(raw)) {
    throw new PathError("path is not valid Unicode");
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
    // Filesystem-backed stores (MinIO, Garage) map each segment to a file
    // name, and those stop at 255 bytes.
    if (Buffer.byteLength(seg, "utf8") > MAX_SEGMENT_BYTES) {
      throw new PathError("path segment too long");
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

const MAX_SEGMENT_BYTES = 255;
// Matched on UTF-16 code units (no u flag): a high surrogate not followed by a
// low one, or a low surrogate not preceded by a high one.
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export class PathError extends Error {
  override readonly name = "PathError";
  constructor(message: string) {
    super(message);
  }
}

/** A site path as a relative URL: each segment percent-encoded. */
export function encodeSitePathForUrl(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
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
