// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockContract, idContract, randomContract } from "./contracts.ts";
import { CryptoIdGenerator } from "./ids/crypto-id-generator.ts";
import { CryptoRandom } from "./random/crypto-random.ts";
import { SystemClock } from "./time/system-clock.ts";
import { SystemScheduler } from "./time/system-scheduler.ts";

clockContract("SystemClock", () => new SystemClock());
idContract("CryptoIdGenerator", () => new CryptoIdGenerator());
randomContract("CryptoRandom", () => new CryptoRandom());

describe("SystemClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the current time", () => {
    expect(new SystemClock().now().toISOString()).toBe("2026-11-20T12:00:00.000Z");
  });
});

describe("CryptoRandom", () => {
  it("produces varying bytes", () => {
    const random = new CryptoRandom();
    expect(random.bytes(32)).not.toEqual(random.bytes(32));
  });
});

describe("SystemScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a task after the delay", () => {
    const scheduler = new SystemScheduler();
    const seen: string[] = [];
    scheduler.schedule(10, () => seen.push("ran"));
    vi.advanceTimersByTime(9);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["ran"]);
  });

  it("cancels a pending task without running it", () => {
    const scheduler = new SystemScheduler();
    const task = vi.fn();
    const handle = scheduler.schedule(10, task);
    handle.cancel();
    handle.cancel();
    vi.advanceTimersByTime(20);
    expect(task).not.toHaveBeenCalled();
  });

  it("rejects a negative delay", () => {
    expect(() => new SystemScheduler().schedule(-1, () => undefined)).toThrow(
      RangeError,
    );
  });
});
