import type { S3Client } from "@aws-sdk/client-s3";

/**
 * In-memory stand-in for S3, for tests. Covers only the commands storage.ts
 * issues; anything else throws so an unhandled command shows up loudly.
 */
export interface FakeS3 {
  client: S3Client;
  objects: Map<string, { body: Buffer; contentType?: string }>;
  keysUnder(prefix: string): string[];
}

export function createFakeS3(): FakeS3 {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();

  const send = async (cmd: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<unknown> => {
    const input = cmd.input;
    switch (cmd.constructor.name) {
      case "HeadBucketCommand":
      case "CreateBucketCommand":
        return {};

      case "PutObjectCommand": {
        objects.set(input.Key as string, {
          body: Buffer.from(input.Body as Uint8Array),
          contentType: input.ContentType as string | undefined,
        });
        return {};
      }

      case "GetObjectCommand": {
        const hit = objects.get(input.Key as string);
        if (!hit) {
          const err = new Error(`no such key: ${String(input.Key)}`);
          err.name = "NoSuchKey";
          throw err;
        }
        return {
          ContentType: hit.contentType,
          Body: {
            transformToByteArray: async () => new Uint8Array(hit.body),
          },
        };
      }

      case "ListObjectsV2Command": {
        const prefix = (input.Prefix as string | undefined) ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }

      case "DeleteObjectsCommand": {
        const del = input.Delete as { Objects?: { Key: string }[] } | undefined;
        for (const o of del?.Objects ?? []) objects.delete(o.Key);
        return {};
      }

      default:
        throw new Error(`fake S3: unhandled ${cmd.constructor.name}`);
    }
  };

  return {
    client: { send } as unknown as S3Client,
    objects,
    keysUnder: (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}
