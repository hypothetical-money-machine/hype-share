import { describe, expect, it } from "vitest";
import { siteLabelFromHost } from "./hostnames.js";

describe("siteLabelFromHost", () => {
  it("returns one lowercased label under the suffix", () => {
    expect(siteLabelFromHost("Api.Example.com:443", "example.com")).toBe("api");
  });

  it("accepts a trailing DNS dot", () => {
    expect(siteLabelFromHost("site.example.com.", "example.com")).toBe("site");
  });

  it("rejects the apex and multi-label subdomains", () => {
    expect(siteLabelFromHost("example.com", "example.com")).toBeNull();
    expect(siteLabelFromHost("one.two.example.com", "example.com")).toBeNull();
  });
});
