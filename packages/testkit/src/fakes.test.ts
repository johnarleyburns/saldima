// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { FakeBook } from "./book/fake-book.ts";
import {
  bookContract,
  clockContract,
  converterContract,
  emailContract,
  fetchContract,
  idContract,
  keyValueContract,
  objectStoreContract,
  randomContract,
  stripeContract,
} from "./contracts.ts";
import { FakeConverter } from "./converter/fake-converter.ts";
import { createFakePorts } from "./create-fake-ports.ts";
import { FakeEmail } from "./email/fake-email.ts";
import { FakeFetch } from "./fetch/fake-fetch.ts";
import { SeededIdGenerator } from "./ids/seeded-id-generator.ts";
import { SeededRandom } from "./random/seeded-random.ts";
import { InMemoryKeyValueStore } from "./storage/memory-kv.ts";
import { InMemoryObjectStore } from "./storage/memory-object-store.ts";
import { FakeStripe } from "./stripe/fake-stripe.ts";
import { ManualClock } from "./time/manual-clock.ts";
import { ManualScheduler } from "./time/manual-scheduler.ts";

clockContract("ManualClock", () => new ManualClock());
idContract("SeededIdGenerator", () => new SeededIdGenerator());
randomContract("SeededRandom", () => new SeededRandom());
objectStoreContract("InMemoryObjectStore", () => new InMemoryObjectStore());
keyValueContract("InMemoryKeyValueStore", () => new InMemoryKeyValueStore());
bookContract("FakeBook", () => new FakeBook());
converterContract("FakeConverter", () => new FakeConverter());
stripeContract("FakeStripe", () => new FakeStripe());
emailContract("FakeEmail", () => new FakeEmail());
fetchContract("FakeFetch", () => {
  const transport = new FakeFetch();
  transport.route("https://quotes.test/latest", 200, '{"price":"1.00"}');
  return transport;
});

describe("ManualClock", () => {
  it("moves only forwards and validates input", () => {
    const clock = new ManualClock("2026-11-20T12:00:00.000Z");
    clock.advance(1_000);
    expect(clock.now().toISOString()).toBe("2026-11-20T12:00:01.000Z");
    clock.set("2026-11-21T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.set("not a date")).toThrow(RangeError);
    expect(() => new ManualClock("not a date")).toThrow(RangeError);
  });
});

describe("ManualScheduler", () => {
  it("runs due tasks in order and honours cancel", () => {
    const scheduler = new ManualScheduler();
    const seen: string[] = [];
    scheduler.schedule(20, () => seen.push("late"));
    const cancelled = scheduler.schedule(5, () => seen.push("cancelled"));
    scheduler.schedule(10, () => seen.push("first"));
    scheduler.schedule(10, () => seen.push("second"));
    cancelled.cancel();
    expect(scheduler.pending()).toBe(3);
    scheduler.advance(9);
    expect(seen).toEqual([]);
    scheduler.advance(1);
    expect(seen).toEqual(["first", "second"]);
    scheduler.advance(10);
    expect(seen).toEqual(["first", "second", "late"]);
    expect(scheduler.pending()).toBe(0);
  });

  it("propagates task errors and rejects negative delays", () => {
    const scheduler = new ManualScheduler();
    scheduler.schedule(1, () => {
      throw new Error("boom");
    });
    expect(() => scheduler.advance(1)).toThrow("boom");
    expect(() => scheduler.schedule(-1, () => undefined)).toThrow(RangeError);
    expect(() => scheduler.advance(-1)).toThrow(RangeError);
  });
});

describe("seeded values are deterministic", () => {
  it("replays the same random stream for the same seed", () => {
    expect(new SeededRandom(42).bytes(16)).toEqual(new SeededRandom(42).bytes(16));
    expect(new SeededRandom(42).bytes(16)).not.toEqual(new SeededRandom(43).bytes(16));
    expect(() => new SeededRandom(0)).toThrow(RangeError);
  });

  it("starts GUIDs at the requested offset", () => {
    expect(new SeededIdGenerator(255n).next()).toBe(`${"0".repeat(30)}ff`);
  });

  it("creates a fully wired fake Ports object", () => {
    const ports = createFakePorts();
    expect(ports.ids.next()).toMatch(/^[0-9a-f]{32}$/);
    expect(ports.faults.pending("kv.get")).toBe(0);
  });
});

describe("fault injection", () => {
  it("fails the next matching call and then recovers", async () => {
    const store = new InMemoryObjectStore();
    store.faults.failNext("r2.put", new Error("timeout"));
    await expect(store.put("k", new Uint8Array([1]))).rejects.toThrow("timeout");
    await expect(store.put("k", new Uint8Array([1]))).resolves.toBeDefined();
    expect(store.faults.pending("r2.put")).toBe(0);
  });

  it("can fail several times", async () => {
    const kv = new InMemoryKeyValueStore();
    kv.faults.failNext("kv.get", new Error("5xx"), 2);
    await expect(kv.get("k")).rejects.toThrow("5xx");
    await expect(kv.get("k")).rejects.toThrow("5xx");
    await expect(kv.get("k")).resolves.toBeNull();
    expect(() => kv.faults.failNext("kv.get", new Error("x"), 0)).toThrow(RangeError);
  });

  it("reaches every fake through the shared injector", async () => {
    const ports = createFakePorts();
    ports.faults.failNext("book.request", new Error("book down"));
    ports.faults.failNext("converter.convert", new Error("container down"));
    ports.faults.failNext("stripe.createCheckoutSession", new Error("stripe down"));
    ports.faults.failNext("email.send", new Error("mail down"));
    ports.faults.failNext("fetch.fetch", new Error("net down"));

    await expect(
      ports.book.request({ method: "GET", path: "/health" }),
    ).rejects.toThrow();
    await expect(
      ports.converter.convert({ from: "sqlite", to: "xml", bytes: new Uint8Array() }),
    ).rejects.toThrow();
    await expect(
      ports.stripe.createCheckoutSession({
        tenantId: "t",
        email: "e@example.test",
        plan: "monthly",
        successUrl: "https://x.test",
        cancelUrl: "https://y.test",
      }),
    ).rejects.toThrow();
    await expect(
      ports.email.send({ to: "e@example.test", subject: "s", text: "t" }),
    ).rejects.toThrow();
    await expect(ports.fetch.fetch("https://x.test")).rejects.toThrow();
  });
});

describe("fake transports record calls", () => {
  it("records fetch calls including init", async () => {
    const transport = new FakeFetch();
    transport.route("https://x.test", 201, "created");
    const response = await transport.fetch("https://x.test", { method: "POST" });
    expect(response.status).toBe(201);
    expect(transport.calls).toEqual([
      { url: "https://x.test", init: { method: "POST" } },
    ]);
  });

  it("records email, converter and stripe inputs", async () => {
    const email = new FakeEmail();
    await email.send({ to: "a@b.test", subject: "s", text: "t" });
    expect(email.messages).toHaveLength(1);

    const converter = new FakeConverter();
    await converter.convert({
      from: "xml",
      to: "sqlite",
      bytes: new TextEncoder().encode("xml:x"),
    });
    expect(converter.calls).toHaveLength(1);

    const stripe = new FakeStripe();
    await stripe.createCheckoutSession({
      tenantId: "t",
      email: "a@b.test",
      plan: "yearly",
      successUrl: "https://x.test",
      cancelUrl: "https://y.test",
    });
    expect(stripe.sessions).toHaveLength(1);
  });
});
