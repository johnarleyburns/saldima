// SPDX-License-Identifier: AGPL-3.0-only
import type { Random } from "../ports.ts";

export class CryptoRandom implements Random {
  bytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError("length must be a non-negative integer");
    }
    const out = new Uint8Array(length);
    crypto.getRandomValues(out);
    return out;
  }
}
