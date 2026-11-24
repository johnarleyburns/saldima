// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  bookCookie,
  bookExportFilename,
  clearedBookCookie,
  normaliseCurrency,
  resolveBookId,
} from "./books.ts";

describe("book scope", () => {
  it("prefers a known cookie and falls back to the first book", () => {
    expect(resolveBookId("b", ["a", "b"])).toBe("b");
    expect(resolveBookId("zzz", ["a", "b"])).toBe("a");
    expect(resolveBookId(null, ["a", "b"])).toBe("a");
    expect(resolveBookId("main", [])).toBe("main");
  });

  it("sets and clears a scoped book cookie", () => {
    expect(bookCookie("abc", false)).toContain("book=abc");
    expect(bookCookie("abc", true)).toContain("Secure");
    expect(clearedBookCookie(false)).toContain("Max-Age=0");
  });

  it("builds a portable export filename", () => {
    expect(bookExportFilename("My book")).toBe("My-book.gnucash");
    expect(bookExportFilename("  Acme / Ltd  ")).toBe("Acme-Ltd.gnucash");
    expect(bookExportFilename("")).toBe("book.gnucash");
  });

  it("accepts only three-letter currency codes", () => {
    expect(normaliseCurrency(" eur ")).toBe("EUR");
    expect(normaliseCurrency("US")).toBeNull();
    expect(normaliseCurrency("")).toBeNull();
  });
});
