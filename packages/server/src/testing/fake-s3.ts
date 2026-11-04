import type { S3Client } from "@aws-sdk/client-s3";

/**
 * In-memory stand-in for S3, for tests. Covers only the commands storage.ts
 * issues; anything else throws so an unhandled command shows up loudly.
 */
export interface FakeS3 {
  client: S3Client;
  objects: Map<string, { body: Buffer; contentType?: string }>;
  keysUnder(prefix: string): string[];
  /** Test hooks: run before each PutObject (throw to fail it, await to stall it),
   * and pick keys DeleteObjects reports under Errors instead of deleting. */
  hooks: {
    beforePut?: (key: string) => void | Promise<void>;
    deleteError?: (key: string) => boolean;
  };
}

export function createFakeS3(): FakeS3 {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  const hooks: FakeS3["hooks"] = {};

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
        await hooks.beforePut?.(input.Key as string);
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

      case "HeadObjectCommand": {
        if (!objects.has(input.Key as string)) {
          const err = new Error(`no such key: ${String(input.Key)}`);
          err.name = "NotFound";
          throw err;
        }
        return {};
      }

      case "ListObjectsV2Command": {
        const prefix = (input.Prefix as string | undefined) ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }

      case "DeleteObjectsCommand": {
        const del = input.Delete as { Objects?: { Key: string }[] } | undefined;
        const Errors: { Key: string; Code: string; Message: string }[] = [];
        for (const o of del?.Objects ?? []) {
          if (hooks.deleteError?.(o.Key)) {
            Errors.push({ Key: o.Key, Code: "AccessDenied", Message: "Access Denied" });
          } else {
            objects.delete(o.Key);
          }
        }
        return Errors.length > 0 ? { Errors } : {};
      }

      default:
        throw new Error(`fake S3: unhandled ${cmd.constructor.name}`);
    }
  };

  return {
    client: { send } as unknown as S3Client,
    objects,
    hooks,
    keysUnder: (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}
