// SPDX-License-Identifier: AGPL-3.0-only

export const BOOK_COOKIE = "book";
export const DEFAULT_BOOK_ID = "main";
export const DEFAULT_BOOK_NAME = "My book";

export const BOOK_CURRENCIES = ["USD", "EUR", "GBP"] as const;
export type BookCurrency = (typeof BOOK_CURRENCIES)[number];

const BOOK_COOKIE_SECONDS = 365 * 24 * 60 * 60;

/**
 * The cookie wins only when it names a book that still exists; otherwise the
 * oldest book is the safe fallback. A cookie can never point at another tenant
 * because book ids are resolved inside this tenant's Durable Object.
 */
export function resolveBookId(
  cookieValue: string | null,
  bookIds: readonly string[],
): string {
  if (cookieValue && bookIds.includes(cookieValue)) return cookieValue;
  return bookIds[0] ?? DEFAULT_BOOK_ID;
}

export function bookCookie(id: string, secure: boolean): string {
  const attributes = [
    `${BOOK_COOKIE}=${id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${BOOK_COOKIE_SECONDS}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedBookCookie(secure: boolean): string {
  const attributes = [
    `${BOOK_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** A filename GnuCash users can recognise, safe for Content-Disposition. */
export function bookExportFilename(name: string): string {
  const safe = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safe || "book"}.gnucash`;
}

export function normaliseCurrency(value: string): string | null {
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}
