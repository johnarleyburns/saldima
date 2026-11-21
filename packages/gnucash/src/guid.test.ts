// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { generateGuid, guidFrom, isGuid } from "./guid.ts";

describe("Guid", () => {
  it("accepts exactly 32 lowercase hex characters", () => {
    expect(isGuid("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isGuid("0123456789ABCDEF0123456789abcdef")).toBe(false);
    expect(isGuid("0123456789abcdef0123456789abcde")).toBe(false);
    expect(isGuid("g123456789abcdef0123456789abcdef")).toBe(false);
    expect(isGuid("")).toBe(false);
  });

  it("refuses to cast invalid input", () => {
    expect(() => guidFrom("nope")).toThrow(RangeError);
    expect(guidFrom("0123456789abcdef0123456789abcdef")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
  });

  it("validates the injected generator's output", () => {
    expect(() => generateGuid({ next: () => "short" })).toThrow(RangeError);
    expect(generateGuid({ next: () => "fedcba9876543210fedcba9876543210" })).toBe(
      "fedcba9876543210fedcba9876543210",
    );
  });

  it("never produces the same GUID twice from the real generator", async () => {
    const { CryptoIdGenerator } = await import(
      "../../testkit/src/ids/crypto-id-generator.ts"
    );
    const source = new CryptoIdGenerator();
    const ids = Array.from({ length: 2000 }, () => generateGuid(source));
    expect(new Set(ids).size).toBe(2000);
  });
});
