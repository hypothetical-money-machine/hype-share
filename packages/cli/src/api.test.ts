import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, listSites, registerAccount } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respondWith(status: number, body: string, type = "text/html"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers: { "content-type": type } })),
  );
}

describe("request", () => {
  it("refuses a 2xx response that is not JSON", async () => {
    respondWith(200, "<html>captive portal</html>");
    await expect(registerAccount("https://example.test", "agent")).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid_response",
    });
  });

  it("refuses an empty 200", async () => {
    respondWith(200, "");
    await expect(listSites({ url: "https://example.test", token: "sp_x" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("still returns JSON bodies and maps API errors", async () => {
    respondWith(200, JSON.stringify({ sites: [] }), "application/json");
    await expect(listSites({ url: "https://example.test", token: "sp_x" })).resolves.toEqual({
      sites: [],
    });
    respondWith(429, JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }));
    await expect(listSites({ url: "https://example.test", token: "sp_x" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  });
});
