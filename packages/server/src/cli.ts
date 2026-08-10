#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createS3Client, ensureBucket } from "./storage.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const s3 = createS3Client(config);

  try {
    await ensureBucket(s3, config.s3.bucket);
  } catch (err) {
    console.error(
      "Warning: could not ensure S3 bucket (is MinIO/S3 reachable?):",
      err instanceof Error ? err.message : err,
    );
  }

  const app = await buildApp({ config, db, s3 });
  await app.listen({ host: config.host, port: config.port });
  console.log(`shareplan listening on http://${config.host}:${config.port}`);
  console.log(`public base URL: ${config.publicBaseUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
