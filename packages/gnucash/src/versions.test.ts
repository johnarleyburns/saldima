// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { isTestedGnuCashRelease } from "./versions.ts";

describe("GnuCash schema-version gate", () => {
  it("accepts the two tested release lines", () => {
    expect(isTestedGnuCashRelease(4, 14)).toBe(true);
    expect(isTestedGnuCashRelease(5, 0)).toBe(true);
    expect(isTestedGnuCashRelease(5, 16)).toBe(true);
    expect(isTestedGnuCashRelease(5, 99)).toBe(true);
  });

  it("refuses older and unreleased schema lines", () => {
    expect(isTestedGnuCashRelease(4, 13)).toBe(false);
    expect(isTestedGnuCashRelease(6, 0)).toBe(false);
    expect(isTestedGnuCashRelease(3, 8)).toBe(false);
  });

  it("refuses nonsense input instead of coercing it", () => {
    expect(isTestedGnuCashRelease(-1, 4)).toBe(false);
    expect(isTestedGnuCashRelease(5, Number.NaN)).toBe(false);
  });
});
