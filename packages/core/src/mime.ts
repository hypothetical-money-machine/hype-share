const EXT_MAP: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  xml: "application/xml",
  zip: "application/zip",
};

const ALLOWED_UPLOAD_EXTS = new Set([
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "json",
  "txt",
  "md",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
  "woff",
  "woff2",
]);

function extensionOf(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return ext.length > 0 ? ext : null;
}

export function contentTypeForPath(path: string): string {
  const ext = extensionOf(path);
  if (!ext) return "application/octet-stream";
  return EXT_MAP[ext] ?? "application/octet-stream";
}

export function isAllowedUploadPath(path: string): boolean {
  const ext = extensionOf(path);
  return ext !== null && ALLOWED_UPLOAD_EXTS.has(ext);
}

export function isHtmlPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}
