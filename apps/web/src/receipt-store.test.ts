// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { R2BucketLike, R2ObjectLike } from "./ports/cloudflare-r2.ts";
import { ReceiptStore } from "./receipt-store.ts";

const MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

class FakeR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<R2ObjectLike | null> {
    this.objects.set(key, value.slice());
    return this.get(key);
  }

  async get(key: string): Promise<R2ObjectLike | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      etag: "fake",
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(options: {
    prefix: string;
  }): Promise<{ objects: Array<{ key: string }> }> {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(options.prefix))
        .map((key) => ({ key })),
    };
  }

  get size(): number {
    return this.objects.size;
  }
}

describe("ReceiptStore", () => {
  it("saves and loads an image round-trip", async () => {
    const bucket = new FakeR2Bucket();
    const store = new ReceiptStore(bucket, "tenant-1", MASTER_KEY);
    const bytes = new TextEncoder().encode("not actually a jpeg, just bytes");

    const relativePath = await store.save("book-1", bytes, "jpg");
    expect(relativePath).toMatch(/^receipts\/.+\.jpg$/);

    const loaded = await store.load("book-1", relativePath);
    expect(loaded).toEqual(bytes);
  });

  it("never stores the image bytes in plaintext", async () => {
    const bucket = new FakeR2Bucket();
    const store = new ReceiptStore(bucket, "tenant-1", MASTER_KEY);
    const bytes = new TextEncoder().encode("a secret receipt detail");

    await store.save("book-1", bytes, "jpg");
    const listing = await bucket.list({ prefix: "tenants/tenant-1/" });
    for (const { key } of listing.objects) {
      const object = await bucket.get(key);
      if (!object) throw new Error(`missing object ${key}`);
      const stored = new Uint8Array(await object.arrayBuffer());
      const text = new TextDecoder("utf-8", { fatal: false }).decode(stored);
      expect(text).not.toContain("a secret receipt detail");
    }
  });

  it("returns null for a path that was never saved", async () => {
    const store = new ReceiptStore(new FakeR2Bucket(), "tenant-1", MASTER_KEY);
    expect(await store.load("book-1", "receipts/missing.jpg")).toBeNull();
  });

  it("delete removes the image", async () => {
    const bucket = new FakeR2Bucket();
    const store = new ReceiptStore(bucket, "tenant-1", MASTER_KEY);
    const relativePath = await store.save("book-1", new Uint8Array([1, 2, 3]), "jpg");
    await store.delete("book-1", relativePath);
    expect(await store.load("book-1", relativePath)).toBeNull();
  });

  it("keeps different books' receipts isolated", async () => {
    const bucket = new FakeR2Bucket();
    const store = new ReceiptStore(bucket, "tenant-1", MASTER_KEY);
    const path = await store.save("book-1", new Uint8Array([1]), "jpg");
    expect(await store.load("book-2", path)).toBeNull();
    expect(await store.load("book-1", path)).toEqual(new Uint8Array([1]));
  });
});
