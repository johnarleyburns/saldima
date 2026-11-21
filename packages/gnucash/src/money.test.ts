// SPDX-License-Identifier: AGPL-3.0-only
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  addMoney,
  equalsMoney,
  formatMoney,
  money,
  multiplyMoney,
  negateMoney,
  normalizeMoney,
  parseMoney,
  roundToFraction,
  subtractMoney,
} from "./money.ts";

const cents = (n: bigint) => money(n, 100n);

describe("Money: exact arithmetic", () => {
  it("adds GnuCash integer pairs without floating point", () => {
    expect(equalsMoney(addMoney(money(1n, 3n), money(1n, 3n)), money(2n, 3n))).toBe(
      true,
    );
    expect(equalsMoney(addMoney(cents(1234n), cents(766n)), cents(2000n))).toBe(true);
    expect(equalsMoney(subtractMoney(cents(1n), cents(3n)), cents(-2n))).toBe(true);
    expect(equalsMoney(negateMoney(cents(5n)), cents(-5n))).toBe(true);
    expect(equalsMoney(multiplyMoney(cents(250n), money(2n, 1n)), cents(500n))).toBe(
      true,
    );
  });

  it("keeps exactness on large values beyond Number.MAX_SAFE_INTEGER", () => {
    const large = money(9_007_199_254_740_993n, 100n);
    expect(
      equalsMoney(
        addMoney(large, money(7n, 100n)),
        money(9_007_199_254_741_000n, 100n),
      ),
    ).toBe(true);
  });

  it("normalises sign and common factors", () => {
    expect(normalizeMoney({ num: 6n, denom: -9n })).toEqual({ num: -2n, denom: 3n });
    expect(normalizeMoney({ num: 0n, denom: -9n })).toEqual({ num: 0n, denom: 1n });
  });

  it("rejects a zero denominator", () => {
    expect(() => money(1n, 0n)).toThrow(RangeError);
  });
});

describe("Money: GnuCash half-even rounding", () => {
  const cases: Array<[string, bigint, bigint, bigint, bigint]> = [
    // [label, num, denom, fraction, expectedNum]
    ["exact", 1234n, 100n, 100n, 1234n],
    ["down", 12344n, 1000n, 100n, 1234n],
    ["up", 12346n, 1000n, 100n, 1235n],
    ["tie to even (down)", 12345n, 1000n, 100n, 1234n],
    ["tie to even (up)", 12355n, 1000n, 100n, 1236n],
    ["negative tie to even", -12345n, 1000n, 100n, -1234n],
    ["negative tie to even up", -12355n, 1000n, 100n, -1236n],
    ["zero", 0n, 100n, 100n, 0n],
  ];

  for (const [label, num, denom, fraction, expected] of cases) {
    it(`rounds ${label}`, () => {
      expect(roundToFraction(money(num, denom), fraction)).toEqual({
        num: expected,
        denom: fraction,
      });
    });
  }

  it("rejects a non-positive fraction", () => {
    expect(() => roundToFraction(cents(1n), 0n)).toThrow(RangeError);
  });
});

describe("Money: parse and format", () => {
  it("parses decimal strings exactly and rounds half-even", () => {
    expect(parseMoney("12.34", 100n)).toEqual(cents(1234n));
    expect(parseMoney("-12.345", 100n)).toEqual(cents(-1234n));
    expect(parseMoney("12.355", 100n)).toEqual(cents(1236n));
    expect(parseMoney("+7", 100n)).toEqual(cents(700n));
    expect(parseMoney("0.005", 100n)).toEqual(cents(0n));
  });

  it("formats with the commodity fraction", () => {
    expect(formatMoney(cents(1234n), 100n)).toBe("12.34");
    expect(formatMoney(cents(-1234n), 100n)).toBe("-12.34");
    expect(formatMoney(cents(5n), 100n)).toBe("0.05");
    expect(formatMoney(money(7n, 1n), 1n)).toBe("7");
    expect(formatMoney(money(12345n, 1000n), 100n)).toBe("12.34");
  });

  it("rejects junk instead of coercing it", () => {
    expect(() => parseMoney("1,234.56", 100n)).toThrow();
    expect(() => parseMoney("1e3", 100n)).toThrow();
    expect(() => parseMoney("", 100n)).toThrow();
    expect(() => formatMoney(cents(1n), 3n)).toThrow(RangeError);
  });
});

describe("Money: properties", () => {
  const rational = fc
    .tuple(
      fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
      fc.bigInt({ min: 1n, max: 1_000_000n }),
    )
    .map(([num, denom]) => money(num, denom));

  it("addition is commutative", () => {
    fc.assert(
      fc.property(rational, rational, (a, b) => {
        expect(equalsMoney(addMoney(a, b), addMoney(b, a))).toBe(true);
      }),
    );
  });

  it("addition is associative", () => {
    fc.assert(
      fc.property(rational, rational, rational, (a, b, c) => {
        expect(
          equalsMoney(addMoney(addMoney(a, b), c), addMoney(a, addMoney(b, c))),
        ).toBe(true);
      }),
    );
  });

  it("zero is the additive identity", () => {
    fc.assert(
      fc.property(rational, (a) => {
        expect(equalsMoney(addMoney(a, money(0n, 1n)), a)).toBe(true);
      }),
    );
  });

  it("rounding lands on the fraction and within half a unit", () => {
    fc.assert(
      fc.property(rational, (a) => {
        const rounded = roundToFraction(a, 100n);
        expect(rounded.denom).toBe(100n);
        const diff = subtractMoney(rounded, a);
        const half = money(1n, 200n);
        expect(equalsMoney(diff, half) || compareAbsolute(diff, half) <= 0).toBe(true);
      }),
    );
  });

  it("parse(format(round(x))) is stable", () => {
    fc.assert(
      fc.property(rational, (a) => {
        const rounded = roundToFraction(a, 100n);
        expect(parseMoney(formatMoney(a, 100n), 100n)).toEqual(rounded);
      }),
    );
  });
});

function compareAbsolute(
  a: { num: bigint; denom: bigint },
  b: { num: bigint; denom: bigint },
): number {
  const left = (a.num < 0n ? -a.num : a.num) * b.denom;
  const right = (b.num < 0n ? -b.num : b.num) * a.denom;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
