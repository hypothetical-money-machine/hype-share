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
import { Readable, Transform, pipeline } from "node:stream";
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
 * bigger pool: slow readers cannot starve publishing or the sweeper. What
 * bounds how long a body can hold a socket is getObject's own deadlines; the
 * SDK's requestTimeout only covers waiting for response headers (and only
 * aborts with throwOnRequestTimeout), so it is not relied on for bodies.
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
    requestHandler: {
      requestTimeout: pool.requestTimeout,
      throwOnRequestTimeout: true,
      httpAgent: agent,
      httpsAgent: agent,
    },
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
  /** Read in full (and counted against the buffer budget) rather than streamed. */
  buffered?: boolean;
}

/** How a served body is bounded. Tests shorten these. */
export interface BodyLimits {
  /** Destroy a body that moves no bytes for this long (an S3 stall, or a visitor who stopped reading). */
  idleMs: number;
  /** Destroy a body that is still going after this long, however it trickles. */
  maxMs: number;
  /** Objects up to this size are read in full, handing their S3 socket back at once. */
  bufferUpToBytes: number;
  /** Bytes all buffered bodies may hold at once; past it, objects stream instead. */
  bufferBudgetBytes: number;
}

export const DEFAULT_BODY_LIMITS: BodyLimits = {
  idleMs: 30_000,
  maxMs: 10 * 60_000,
  bufferUpToBytes: 256 * 1024,
  bufferBudgetBytes: 64 * 1024 * 1024,
};

/** Bytes held by buffered bodies not yet sent or abandoned, process-wide. */
let bufferedBytes = 0;

/**
 * Pass `source` through, destroying both if no chunk moves for `idleMs` or the
 * whole body takes longer than `maxMs`. Backpressure is kept: a visitor who
 * stops reading pauses the source, the idle timer then fires, and the S3
 * socket goes back to the pool.
 */
function withDeadlines(source: Readable, limits: BodyLimits): Readable {
  let idle: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(fail(`idle for ${limits.idleMs} ms`), limits.idleMs);
  };
  // Every chunk that gets through counts as progress.
  const out = new Transform({
    transform(chunk, _enc, done) {
      resetIdle();
      done(null, chunk);
    },
  });
  function fail(why: string) {
    return () => out.destroy(new Error(`S3 body ${why}`));
  }
  const total = setTimeout(fail(`took longer than ${limits.maxMs} ms`), limits.maxMs);
  resetIdle();
  out.on("close", () => {
    clearTimeout(idle);
    clearTimeout(total);
  });
  // pipeline destroys the source when `out` is destroyed, and vice versa.
  pipeline(source, out, () => {});
  return out;
}

/** An object's body as a stream, or null if there is no such key. */
export async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
  limits: BodyLimits = DEFAULT_BODY_LIMITS,
): Promise<StoredObject | null> {
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) return null;
    const body = withDeadlines(out.Body as Readable, limits);
    const length = out.ContentLength;
    if (
      length !== undefined &&
      length <= limits.bufferUpToBytes &&
      bufferedBytes + length <= limits.bufferBudgetBytes
    ) {
      bufferedBytes += length;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          bufferedBytes -= length;
        }
      };
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
        const buffered = Readable.from([Buffer.concat(chunks)]);
        buffered.on("close", release);
        return { body: buffered, contentType: out.ContentType, contentLength: length, buffered: true };
      } catch (err) {
        release();
        throw err;
      }
    }
    return { body, contentType: out.ContentType, contentLength: length, buffered: false };
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
