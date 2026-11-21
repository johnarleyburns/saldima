// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type {
  BookStub,
  Clock,
  Converter,
  EmailPort,
  FetchPort,
  IdGenerator,
  KeyValueStore,
  ObjectStore,
  Random,
  StripePort,
} from "./ports.ts";

export type Factory<T> = () => T | Promise<T>;

export function clockContract(name: string, make: Factory<Clock>): void {
  describe(`Clock contract: ${name}`, () => {
    it("returns independent Date instances", async () => {
      const clock = await make();
      const first = clock.now();
      const second = clock.now();
      expect(first).toBeInstanceOf(Date);
      expect(second.getTime()).toBe(first.getTime());
      expect(first).not.toBe(second);
    });
  });
}

export function idContract(name: string, make: Factory<IdGenerator>): void {
  describe(`IdGenerator contract: ${name}`, () => {
    it("returns 32 lowercase hex characters, never reused", async () => {
      const ids = await make();
      const seen = new Set<string>();
      for (let i = 0; i < 500; i += 1) {
        const id = ids.next();
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    });
  });
}

export function randomContract(name: string, make: Factory<Random>): void {
  describe(`Random contract: ${name}`, () => {
    it("fills exactly the requested length", async () => {
      const random = await make();
      expect(random.bytes(0)).toHaveLength(0);
      expect(random.bytes(32)).toHaveLength(32);
    });

    it("rejects invalid lengths", async () => {
      const random = await make();
      expect(() => random.bytes(-1)).toThrow(RangeError);
      expect(() => random.bytes(1.5)).toThrow(RangeError);
    });
  });
}

export function objectStoreContract(name: string, make: Factory<ObjectStore>): void {
  describe(`ObjectStore contract: ${name}`, () => {
    it("round-trips bytes and reports a content hash", async () => {
      const store = await make();
      const bytes = new Uint8Array([1, 2, 3, 255]);
      const stored = await store.put(
        "tenant/book.gnucash",
        bytes,
        "application/x-sqlite3",
      );
      expect(stored.etag.length).toBeGreaterThan(0);
      expect(stored.contentType).toBe("application/x-sqlite3");
      const read = await store.get("tenant/book.gnucash");
      expect(read?.bytes).toEqual(bytes);
      expect(read?.etag).toBe(stored.etag);
    });

    it("returns null for a missing key and deletes", async () => {
      const store = await make();
      expect(await store.get("missing")).toBeNull();
      await store.put("a/one", new Uint8Array([1]));
      await store.delete("a/one");
      expect(await store.get("a/one")).toBeNull();
    });

    it("lists a prefix sorted and changes the etag on overwrite", async () => {
      const store = await make();
      const first = await store.put("p/b", new Uint8Array([2]));
      await store.put("p/a", new Uint8Array([1]));
      await store.put("q/c", new Uint8Array([3]));
      expect(await store.list("p/")).toEqual(["p/a", "p/b"]);
      const second = await store.put("p/b", new Uint8Array([9]));
      expect(second.etag).not.toBe(first.etag);
    });
  });
}

export function keyValueContract(name: string, make: Factory<KeyValueStore>): void {
  describe(`KeyValueStore contract: ${name}`, () => {
    it("round-trips strings and lists sorted", async () => {
      const store = await make();
      expect(await store.get("missing")).toBeNull();
      await store.put("host/b", "tenant-b");
      await store.put("host/a", "tenant-a");
      await store.put("other", "x");
      expect(await store.get("host/a")).toBe("tenant-a");
      expect(await store.list("host/")).toEqual(["host/a", "host/b"]);
    });

    it("overwrites and deletes", async () => {
      const store = await make();
      await store.put("k", "one");
      await store.put("k", "two");
      expect(await store.get("k")).toBe("two");
      await store.delete("k");
      expect(await store.get("k")).toBeNull();
    });
  });
}

export function bookContract(name: string, make: Factory<BookStub>): void {
  describe(`BookStub contract: ${name}`, () => {
    it("answers a health request", async () => {
      const book = await make();
      const response = await book.request({ method: "GET", path: "/health" });
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(response.body)).toContain('"ok":true');
    });

    it("echoes a request body byte for byte", async () => {
      const book = await make();
      const body = new Uint8Array([0, 1, 2, 250]);
      const response = await book.request({ method: "POST", path: "/echo", body });
      expect(response.status).toBe(200);
      expect(response.body).toEqual(body);
    });

    it("returns 404 for an unknown route", async () => {
      const book = await make();
      const response = await book.request({ method: "GET", path: "/nope" });
      expect(response.status).toBe(404);
    });
  });
}

export function converterContract(name: string, make: Factory<Converter>): void {
  describe(`Converter contract: ${name}`, () => {
    it("round-trips sqlite to xml and back", async () => {
      const converter = await make();
      const sqlite = new TextEncoder().encode("sqlite:book-bytes");
      const xml = await converter.convert({ from: "sqlite", to: "xml", bytes: sqlite });
      expect(new TextDecoder().decode(xml)).toBe("xml:book-bytes");
      const back = await converter.convert({ from: "xml", to: "sqlite", bytes: xml });
      expect(back).toEqual(sqlite);
    });

    it("rejects input in the wrong format", async () => {
      const converter = await make();
      await expect(
        converter.convert({
          from: "sqlite",
          to: "xml",
          bytes: new TextEncoder().encode("xml:nope"),
        }),
      ).rejects.toThrow("input is not sqlite");
    });
  });
}

export function stripeContract(name: string, make: Factory<StripePort>): void {
  describe(`Stripe contract: ${name}`, () => {
    it("creates distinct checkout sessions", async () => {
      const stripe = await make();
      const request = {
        tenantId: "t1",
        email: "owner@example.test",
        plan: "yearly" as const,
        successUrl: "https://t1.localhost/app",
        cancelUrl: "https://saldima.test/",
      };
      const first = await stripe.createCheckoutSession(request);
      const second = await stripe.createCheckoutSession(request);
      expect(first.id).not.toBe(second.id);
      expect(first.url).toMatch(/^https:\/\//);
    });

    it("verifies a webhook and rejects a bad signature", async () => {
      const stripe = await make();
      const payload = JSON.stringify({
        type: "checkout.session.completed",
        sessionId: "cs_1",
      });
      await expect(stripe.verifyWebhook(payload, "test_signature")).resolves.toEqual({
        type: "checkout.session.completed",
        sessionId: "cs_1",
      });
      await expect(stripe.verifyWebhook(payload, "bad")).rejects.toThrow(
        "invalid signature",
      );
      await expect(stripe.verifyWebhook("{}", "test_signature")).rejects.toThrow(
        "invalid event",
      );
    });
  });
}

export function emailContract(name: string, make: Factory<EmailPort>): void {
  describe(`Email contract: ${name}`, () => {
    it("accepts a message", async () => {
      const email = await make();
      await expect(
        email.send({ to: "owner@example.test", subject: "Welcome", text: "Hi" }),
      ).resolves.toBeUndefined();
    });
  });
}

export function fetchContract(name: string, make: Factory<FetchPort>): void {
  describe(`Fetch contract: ${name}`, () => {
    it("returns the routed response and reports misses", async () => {
      const transport = await make();
      const response = await transport.fetch("https://quotes.test/latest");
      expect(response.status).toBe(200);
      const missing = await transport.fetch("https://quotes.test/missing");
      expect(missing.status).toBe(404);
    });
  });
}
