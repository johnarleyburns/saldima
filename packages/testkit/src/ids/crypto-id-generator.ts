// SPDX-License-Identifier: AGPL-3.0-only
import type { IdGenerator } from "../ports.ts";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** GnuCash-style GUID: 16 random bytes, lowercase hex, never sequential. */
export class CryptoIdGenerator implements IdGenerator {
  next(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return toHex(bytes);
  }
}
