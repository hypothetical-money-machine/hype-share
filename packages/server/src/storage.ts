import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  CreateBucketCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { Config } from "./config.js";
import {
  s3ObjectKey,
  s3SitePrefix,
  s3VersionPrefix,
  contentTypeForPath,
} from "@shareplan/core";

export interface StoredFile {
  path: string;
  body: Buffer;
  contentType?: string;
}

/**
 * Serving streams large objects to visitors, and a slow reader holds its S3
 * socket for as long as it reads. So serving gets its own client, with a
 * bigger pool, and every socket is dropped after a stretch with no traffic:
 * slow readers can then starve neither publishing nor the sweeper, and a
 * stalled one cannot hold a socket for ever.
 */
const S3_POOL = {
  serve: { maxSockets: 256, requestTimeout: 30_000 },
  write: { maxSockets: 50, requestTimeout: 120_000 },
} as const;

export function createS3Client(config: Config, purpose: keyof typeof S3_POOL = "write"): S3Client {
  const pool = S3_POOL[purpose];
  const agent = { keepAlive: true, maxSockets: pool.maxSockets };
  const cfg: S3ClientConfig = {
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    requestHandler: { requestTimeout: pool.requestTimeout, httpAgent: agent, httpsAgent: agent },
  };
  // Without explicit SHAREPLAN_S3_* keys, leave credentials to the SDK's
  // default chain: AWS_* env vars (with AWS_SESSION_TOKEN), profiles, and
  // ECS/EKS/EC2 roles all work that way, and a static pair would override them.
  if (config.s3.credentials) {
    cfg.credentials = config.s3.credentials;
  }
  if (config.s3.endpoint) {
    cfg.endpoint = config.s3.endpoint;
  }
  return new S3Client(cfg);
}

export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
      // Race or already exists — re-head
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      void err;
    }
  }
}

export async function putSiteFiles(
  client: S3Client,
  bucket: string,
  siteId: string,
  versionId: string,
  files: StoredFile[],
): Promise<void> {
  for (const file of files) {
    const Key = s3ObjectKey(siteId, versionId, file.path);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key,
        Body: file.body,
        ContentType: file.contentType ?? contentTypeForPath(file.path),
      }),
    );
  }
}

export interface StoredObject {
  /** The body as a stream, so serving never holds a whole file in memory. */
  body: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
}

/**
 * Objects at most this big are read in full before serving, which hands their
 * S3 socket back at once; most HTML, CSS and JS is far smaller. Bigger ones
 * stream, so memory stays flat however large the file.
 */
const BUFFER_UP_TO_BYTES = 1024 * 1024;

/** An object's body as a stream, or null if there is no such key. */
export async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<StoredObject | null> {
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) return null;
    let body = out.Body as Readable;
    if (out.ContentLength !== undefined && out.ContentLength <= BUFFER_UP_TO_BYTES) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
      body = Readable.from([Buffer.concat(chunks)]);
    }
    return { body, contentType: out.ContentType, contentLength: out.ContentLength };
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** An object's metadata, without its body, or null if there is no such key. */
export async function headObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Omit<StoredObject, "body"> | null> {
  try {
    const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { contentType: out.ContentType, contentLength: out.ContentLength };
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** S3 says "no such key" several ways; AWS SDK v3 sometimes only via status. */
function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

/** Whether an object exists, without downloading it. */
export async function objectExists(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  return (await headObject(client, bucket, key)) !== null;
}

export function deleteSiteObjects(
  client: S3Client,
  bucket: string,
  siteId: string,
): Promise<number> {
  return deletePrefix(client, bucket, s3SitePrefix(siteId));
}

export function deleteVersionObjects(
  client: S3Client,
  bucket: string,
  siteId: string,
  versionId: string,
): Promise<number> {
  return deletePrefix(client, bucket, s3VersionPrefix(siteId, versionId));
}

/**
 * Delete every object under a prefix. Returns how many were removed, and
 * throws if any key could not be: DeleteObjects answers 200 even when some
 * keys fail, listing them under Errors, and a caller that dropped its row on
 * a silent partial failure would orphan those objects for good.
 */
export async function deletePrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<number> {
  let deleted = 0;
  let ContinuationToken: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken,
      }),
    );
    const keys = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === "string");
    if (keys.length > 0) {
      const out = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const failed = out.Errors ?? [];
      if (failed.length > 0) {
        const first = failed[0]!;
        throw new Error(
          `could not delete ${failed.length} of ${keys.length} object(s) under ${prefix}` +
            ` (first: ${first.Key ?? "?"}: ${first.Code ?? "error"} ${first.Message ?? ""})`.trimEnd(),
        );
      }
      deleted += keys.length;
    }
    ContinuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return deleted;
}
