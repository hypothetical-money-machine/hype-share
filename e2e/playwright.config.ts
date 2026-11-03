import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "../test-results/e2e",
  fullyParallel: true,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
});
