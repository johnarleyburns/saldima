// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { fromBase64, randomBytes, toBase64, utf8Decode, utf8Encode } from "./bytes.ts";

describe("bytes", () => {
  it("generates random bytes of the requested length, not all zero", () => {
    const bytes = randomBytes(32);
    expect(bytes).toHaveLength(32);
    expect(bytes.some((b) => b !== 0)).toBe(true);
  });

  it("round-trips base64 for empty, short and binary-unsafe byte sequences", () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([255, 0, 128, 1, 254]),
      randomBytes(257), // crosses typical chunking boundaries
    ]) {
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });

  it("round-trips UTF-8 text including multi-byte characters", () => {
    for (const text of ["", "hello", "café ☕ 日本語", "a".repeat(1000)]) {
      expect(utf8Decode(utf8Encode(text))).toBe(text);
    }
  });
});
