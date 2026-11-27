// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { nextInstance, type Recurrence } from "./recurrence.ts";

function recurrence(overrides: Partial<Recurrence> & { start: string }): Recurrence {
  return {
    periodType: "day",
    multiplier: 1,
    weekendAdjust: "none",
    ...overrides,
  };
}

describe("nextInstance", () => {
  it("'once' fires exactly once: the start date before it, then never again", () => {
    const r = recurrence({ periodType: "once", start: "2026-03-01" });
    expect(nextInstance(r, "2026-02-01")).toBe("2026-03-01");
    expect(nextInstance(r, "2026-03-01")).toBeNull();
    expect(nextInstance(r, "2026-03-02")).toBeNull();
  });

  it("'day' with a multiplier steps by whole multiples from start, not from refDate", () => {
    const r = recurrence({ periodType: "day", multiplier: 3, start: "2026-01-01" });
    expect(nextInstance(r, "2025-12-31")).toBe("2026-01-01");
    expect(nextInstance(r, "2026-01-01")).toBe("2026-01-04");
    expect(nextInstance(r, "2026-01-03")).toBe("2026-01-04");
    expect(nextInstance(r, "2026-01-04")).toBe("2026-01-07");
  });

  it("'week' with a multiplier steps by multiples of 7 days", () => {
    const r = recurrence({ periodType: "week", multiplier: 2, start: "2026-01-05" });
    expect(nextInstance(r, "2026-01-05")).toBe("2026-01-19");
    expect(nextInstance(r, "2026-01-18")).toBe("2026-01-19");
  });

  it("'month' keeps the start day-of-month, clamped to shorter months", () => {
    const r = recurrence({ periodType: "month", multiplier: 1, start: "2026-01-31" });
    // January 31 + 1 month has no 31st in February -- clamps to the 28th.
    expect(nextInstance(r, "2026-01-31")).toBe("2026-02-28");
  });

  it("'month' with a multiplier > 1 steps by whole multiples of months", () => {
    const r = recurrence({ periodType: "month", multiplier: 3, start: "2026-01-15" });
    expect(nextInstance(r, "2026-01-15")).toBe("2026-04-15");
    expect(nextInstance(r, "2026-03-01")).toBe("2026-04-15");
  });

  it("'end_of_month' always lands on the last day of the target month", () => {
    const r = recurrence({
      periodType: "end_of_month",
      multiplier: 1,
      start: "2026-01-15",
    });
    expect(nextInstance(r, "2026-01-10")).toBe("2026-01-31");
    expect(nextInstance(r, "2026-01-31")).toBe("2026-02-28");
  });

  it("'nth_weekday' keeps the same occurrence of the same weekday each month", () => {
    // 2026-01-13 is the 2nd Tuesday of January 2026.
    const r = recurrence({
      periodType: "nth_weekday",
      multiplier: 1,
      start: "2026-01-13",
    });
    expect(nextInstance(r, "2026-01-13")).toBe("2026-02-10"); // 2nd Tuesday of February
  });

  it("'nth_weekday' falls back to the last occurrence when the nth doesn't exist", () => {
    // 2026-12-29 is the 5th Tuesday of December 2026; January 2027 only has 4.
    const r = recurrence({
      periodType: "nth_weekday",
      multiplier: 1,
      start: "2026-12-29",
    });
    expect(nextInstance(r, "2026-12-29")).toBe("2027-01-26"); // last Tuesday of January
  });

  it("'last_weekday' always lands on the last occurrence of the weekday in the target month", () => {
    // 2026-01-27 is the last Tuesday of January 2026.
    const r = recurrence({
      periodType: "last_weekday",
      multiplier: 1,
      start: "2026-01-27",
    });
    expect(nextInstance(r, "2026-01-27")).toBe("2026-02-24"); // last Tuesday of February
  });

  it("'year' keeps the month and day, clamping Feb 29 to Feb 28 off a leap year", () => {
    const r = recurrence({ periodType: "year", multiplier: 1, start: "2024-02-29" });
    expect(nextInstance(r, "2024-02-29")).toBe("2025-02-28");
  });

  it("'year' with a multiplier > 1 steps by whole multiples of years", () => {
    const r = recurrence({ periodType: "year", multiplier: 2, start: "2026-06-01" });
    expect(nextInstance(r, "2026-06-01")).toBe("2028-06-01");
  });

  it("weekend adjustment moves a Saturday/Sunday instance to Friday or Monday", () => {
    const forward = recurrence({
      periodType: "day",
      multiplier: 7,
      start: "2026-01-03", // a Saturday
      weekendAdjust: "forward",
    });
    expect(nextInstance(forward, "2026-01-03")).toBe("2026-01-12"); // Saturday -> Monday

    const back = recurrence({
      periodType: "day",
      multiplier: 7,
      start: "2026-01-03",
      weekendAdjust: "back",
    });
    expect(nextInstance(back, "2026-01-03")).toBe("2026-01-09"); // Saturday -> Friday

    const sunday = recurrence({
      periodType: "day",
      multiplier: 7,
      start: "2026-01-04", // a Sunday
      weekendAdjust: "forward",
    });
    expect(nextInstance(sunday, "2026-01-04")).toBe("2026-01-12"); // Sunday -> Monday

    const sundayBack = recurrence({
      periodType: "day",
      multiplier: 7,
      start: "2026-01-04",
      weekendAdjust: "back",
    });
    expect(nextInstance(sundayBack, "2026-01-04")).toBe("2026-01-09"); // Sunday -> Friday
  });

  it("does not weekend-adjust a weekday instance", () => {
    const r = recurrence({
      periodType: "day",
      multiplier: 1,
      start: "2026-01-05", // a Monday
      weekendAdjust: "forward",
    });
    expect(nextInstance(r, "2026-01-05")).toBe("2026-01-06");
  });

  it("rejects a multiplier under 1", () => {
    const r = recurrence({ periodType: "day", multiplier: 0, start: "2026-01-01" });
    expect(() => nextInstance(r, "2026-01-01")).toThrow(RangeError);
  });

  it("rejects a malformed date", () => {
    const r = recurrence({ periodType: "day", multiplier: 1, start: "not-a-date" });
    expect(() => nextInstance(r, "2026-01-01")).toThrow(RangeError);
  });
});
