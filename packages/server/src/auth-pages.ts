import type { FastifyReply } from "fastify";

export function claimRedirectPage(reply: FastifyReply, authorizationUrl: string, action = "sign-in"): FastifyReply {
  // Chromium applies the confirmation form's form-action policy to HTTP redirects.
  // Finish the same-origin POST before navigating to the external sign-in page.
  setAuthPageHeaders(reply, false);
  const url = escapeHtml(authorizationUrl);
  const safeAction = escapeHtml(action);
  return reply.type("text/html; charset=utf-8").status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${url}">
  <title>Opening ${safeAction} · shareplan</title>
</head>
<body>
  <p><a href="${url}">Continue to ${safeAction.replace(/-/g, " ")}</a></p>
</body>
</html>`);
}

export function setAuthPageHeaders(reply: FastifyReply, allowForm: boolean): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action ${allowForm ? "'self'" : "'none'"}; frame-ancestors 'none'`,
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
