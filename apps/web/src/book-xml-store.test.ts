// SPDX-License-Identifier: AGPL-3.0-only

import { type BookSnapshot, guidFrom } from "@saldima/gnucash";
import { describe, expect, it } from "vitest";
import { BookXmlStore } from "./book-xml-store.ts";
import type { R2BucketLike, R2ObjectLike } from "./ports/cloudflare-r2.ts";

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

function snapshot(): BookSnapshot {
  return {
    bookGuid: "a".repeat(32),
    currencyCode: "USD",
    fraction: 100,
    accounts: [
      {
        guid: "b".repeat(32),
        name: "Bank",
        type: "BANK",
        parentGuid: null,
        commodityCode: "USD",
        code: "",
        description: "",
      },
      {
        guid: "c".repeat(32),
        name: "Salary",
        type: "INCOME",
        parentGuid: null,
        commodityCode: "USD",
        code: "",
        description: "",
      },
    ],
    transactions: [
      {
        guid: "d".repeat(32),
        date: "2026-01-15",
        description: "Opening deposit",
        currencyCode: "USD",
        splits: [
          { accountGuid: "b".repeat(32), value: { num: 250000n, denom: 100n } },
          { accountGuid: "c".repeat(32), value: { num: -250000n, denom: 100n } },
        ],
      },
    ],
  };
}

function store(bucket: R2BucketLike): BookXmlStore {
  return new BookXmlStore(bucket, "tenant-1", MASTER_KEY);
}

describe("BookXmlStore", () => {
  it("returns null for a book that has never been saved", async () => {
    expect(await store(new FakeR2Bucket()).get("book-1")).toBeNull();
  });

  it("replaces a book, then reads it back through a fresh instance", async () => {
    const bucket = new FakeR2Bucket();
    await store(bucket).replace("book-1", snapshot(), "2026-01-15T00:00:00.000Z");

    const document = await store(bucket).get("book-1");
    expect(document).not.toBeNull();
    expect(document?.transactions()).toHaveLength(1);
    expect(document?.accounts().some((account) => account.name === "Bank")).toBe(true);
  });

  it("never writes plaintext XML to the bucket", async () => {
    const bucket = new FakeR2Bucket();
    await store(bucket).replace("book-1", snapshot(), "2026-01-15T00:00:00.000Z");
    const listing = await bucket.list({ prefix: "tenants/tenant-1/" });
    for (const { key } of listing.objects) {
      const object = await bucket.get(key);
      if (!object) throw new Error(`missing object ${key}`);
      const bytes = new Uint8Array(await object.arrayBuffer());
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      expect(text).not.toContain("gnc-v2");
      expect(text).not.toContain("Opening deposit");
    }
  });

  it("caches in memory, so a second get does not touch the bucket again", async () => {
    const bucket = new FakeR2Bucket();
    const theStore = store(bucket);
    await theStore.replace("book-1", snapshot(), "2026-01-15T00:00:00.000Z");
    const first = await theStore.get("book-1");
    const second = await theStore.get("book-1");
    expect(first).toBe(second);
  });

  it("save writes a new version rather than overwriting the old one", async () => {
    const bucket = new FakeR2Bucket();
    const theStore = store(bucket);
    const document = await theStore.replace(
      "book-1",
      snapshot(),
      "2026-01-15T00:00:00.000Z",
    );
    document.createAccount(
      {
        name: "Rent",
        type: "EXPENSE",
        parentGuid: null,
        commodity: { space: "CURRENCY", id: "USD" },
      },
      guidFrom("e".repeat(32)),
    );
    await theStore.save("book-1", document, "2026-01-16T00:00:00.000Z");

    expect(bucket.size).toBe(2);
    const reread = await store(bucket).get("book-1");
    expect(reread?.accounts().some((account) => account.name === "Rent")).toBe(true);
  });

  it("prunes versions beyond the retention limit, keeping the newest", async () => {
    const bucket = new FakeR2Bucket();
    const theStore = store(bucket);
    let document = await theStore.replace(
      "book-1",
      snapshot(),
      "2026-01-01T00:00:00.000Z",
    );
    for (let day = 2; day <= 35; day += 1) {
      const current = await theStore.get("book-1");
      if (!current) throw new Error("expected book-1 to exist");
      document = current;
      await theStore.save(
        "book-1",
        document,
        `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      );
    }
    expect(bucket.size).toBe(30);
  });

  it("delete removes every version and the cache entry", async () => {
    const bucket = new FakeR2Bucket();
    const theStore = store(bucket);
    const document = await theStore.replace(
      "book-1",
      snapshot(),
      "2026-01-15T00:00:00.000Z",
    );
    await theStore.save("book-1", document, "2026-01-16T00:00:00.000Z");
    await theStore.delete("book-1");
    expect(await store(bucket).get("book-1")).toBeNull();
    expect(bucket.size).toBe(0);
  });

  it("keeps separate books isolated by key", async () => {
    const bucket = new FakeR2Bucket();
    const theStore = store(bucket);
    await theStore.replace("book-1", snapshot(), "2026-01-15T00:00:00.000Z");
    await theStore.replace(
      "book-2",
      { ...snapshot(), bookGuid: "f".repeat(32) },
      "2026-01-15T00:00:00.000Z",
    );
    expect(await store(bucket).get("book-1")).not.toBeNull();
    expect(await store(bucket).get("book-2")).not.toBeNull();
    await theStore.delete("book-1");
    expect(await store(bucket).get("book-1")).toBeNull();
    expect(await store(bucket).get("book-2")).not.toBeNull();
  });
});
