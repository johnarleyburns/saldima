// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { money } from "./money.ts";
import { amountInWords } from "./money-words.ts";

describe("amountInWords", () => {
  it("rejects zero and negative amounts", () => {
    expect(() => amountInWords(money(0n, 100n), 100n)).toThrow(RangeError);
    expect(() => amountInWords(money(-500n, 100n), 100n)).toThrow(RangeError);
  });

  it("rejects a non-positive fraction", () => {
    expect(() => amountInWords(money(100n, 100n), 0n)).toThrow(RangeError);
  });

  it("spells a single dollar, singular", () => {
    expect(amountInWords(money(100n, 100n), 100n)).toBe("One dollar and 00/100");
  });

  it("spells a plural whole-dollar amount with no cents", () => {
    expect(amountInWords(money(500n, 100n), 100n)).toBe("Five dollars and 00/100");
  });

  it("spells teens", () => {
    expect(amountInWords(money(1500n, 100n), 100n)).toBe("Fifteen dollars and 00/100");
  });

  it("spells a round hundred", () => {
    expect(amountInWords(money(10000n, 100n), 100n)).toBe(
      "One hundred dollars and 00/100",
    );
  });

  it("joins hundreds and ones with no 'and', matching check-writing convention", () => {
    expect(amountInWords(money(10800n, 100n), 100n)).toBe(
      "One hundred eight dollars and 00/100",
    );
  });

  it("hyphenates a compound tens-and-ones group", () => {
    expect(amountInWords(money(3400n, 100n), 100n)).toBe(
      "Thirty-four dollars and 00/100",
    );
  });

  it("spells thousands with cents", () => {
    expect(amountInWords(money(123456n, 100n), 100n)).toBe(
      "One thousand two hundred thirty-four dollars and 56/100",
    );
  });

  it("spells millions, skipping zero groups", () => {
    expect(amountInWords(money(123456700n, 100n), 100n)).toBe(
      "One million two hundred thirty-four thousand five hundred sixty-seven dollars and 00/100",
    );
  });

  it("rejects an amount too large to spell out", () => {
    expect(() => amountInWords(money(10n ** 18n, 100n), 100n)).toThrow(RangeError);
  });

  it("rounds a fractional-cent value to the nearest cent first", () => {
    // 10.005 rounds half-to-even to 10.00.
    expect(amountInWords(money(10005n, 1000n), 100n)).toBe("Ten dollars and 00/100");
  });
});
