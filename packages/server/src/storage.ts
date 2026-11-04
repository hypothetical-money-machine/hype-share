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

export function createS3Client(config: Config): S3Client {
  const cfg: S3ClientConfig = {
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
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

export async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<{ body: Buffer; contentType: string | undefined } | null> {
  try {
    const out = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    if (!out.Body) return null;
    const bytes = await out.Body.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: out.ContentType,
    };
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    // AWS SDK v3 sometimes uses $metadata.httpStatusCode
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (status === 404) return null;
    throw err;
  }
}

/** Whether an object exists, without downloading it. */
export async function objectExists(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (name === "NotFound" || name === "NoSuchKey" || status === 404) return false;
    throw err;
  }
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
