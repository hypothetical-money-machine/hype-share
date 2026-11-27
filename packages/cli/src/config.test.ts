import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveCliConfig } from "./config.js";

const dirs: string[] = [];
const saved = process.env.SHAREPLAN_CONFIG;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.SHAREPLAN_CONFIG;
  else process.env.SHAREPLAN_CONFIG = saved;
});

describe("saveCliConfig", () => {
  it("tightens an existing config file to 0600 on every save", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shareplan-config-"));
    dirs.push(dir);
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o644);
    process.env.SHAREPLAN_CONFIG = file;
    saveCliConfig({ url: "https://example.test", token: "sp_x" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
