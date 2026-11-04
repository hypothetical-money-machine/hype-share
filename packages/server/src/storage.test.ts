import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { getObject, type BodyLimits } from "./storage.js";

const LIMITS: BodyLimits = { idleMs: 40, maxMs: 5_000, bufferUpToBytes: 1024, bufferBudgetBytes: 1500 };

/** A client whose GetObject returns `body` as the object, `length` bytes long. */
function clientFor(makeBody: () => Readable, length: number): S3Client {
  return {
    send: async () => ({ Body: makeBody(), ContentLength: length, ContentType: "text/plain" }),
  } as unknown as S3Client;
}

/** A body that sends one chunk and then nothing, ever, like a stalled S3. */
function stallsAfterFirstChunk(): Readable {
  let sent = false;
  const body = new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(Buffer.from("x"));
      }
    },
  });
  return body;
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

describe("getObject body limits", () => {
  it("destroys a streamed body, and its source, once it stalls", async () => {
    const sources: Readable[] = [];
    const client = clientFor(() => {
      const s = stallsAfterFirstChunk();
      sources.push(s);
      return s;
    }, 10_000);
    const obj = (await getObject(client, "b", "k", LIMITS))!;
    expect(obj.buffered).toBe(false);
    const started = Date.now();
    await expect(drain(obj.body)).rejects.toThrow(/idle/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sources[0]!.destroyed).toBe(true);
  });

  it("gives up on a buffered read that stalls instead of waiting for ever", async () => {
    const client = clientFor(stallsAfterFirstChunk, 500);
    await expect(getObject(client, "b", "k", LIMITS)).rejects.toThrow(/idle/);
  });

  it("ends a body that keeps trickling past the total limit", async () => {
    const client = clientFor(
      () =>
        new Readable({
          read() {
            setTimeout(() => this.push(Buffer.from("y")), 10);
          },
        }),
      10_000,
    );
    const obj = (await getObject(client, "b", "k", { ...LIMITS, maxMs: 150 }))!;
    await expect(drain(obj.body)).rejects.toThrow(/longer than/);
  });

  it("streams instead of buffering once the buffer budget is spent, and frees it after", async () => {
    const client = clientFor(() => Readable.from([Buffer.alloc(800, 1)]), 800);
    const first = (await getObject(client, "b", "a", LIMITS))!;
    const second = (await getObject(client, "b", "b", LIMITS))!;
    expect(first.buffered).toBe(true);
    expect(second.buffered).toBe(false);
    await drain(first.body);
    await drain(second.body);
    await new Promise((r) => setImmediate(r));
    const third = (await getObject(client, "b", "c", LIMITS))!;
    expect(third.buffered).toBe(true);
    expect((await drain(third.body)).length).toBe(800);
  });

  it("does not buffer objects over the size limit", async () => {
    const client = clientFor(() => Readable.from([Buffer.alloc(2000, 1)]), 2000);
    const obj = (await getObject(client, "b", "k", LIMITS))!;
    expect(obj.buffered).toBe(false);
    expect((await drain(obj.body)).length).toBe(2000);
  });
});
