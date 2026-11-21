// SPDX-License-Identifier: AGPL-3.0-only
import type { Random } from "../ports.ts";

/** Deterministic xorshift32 stream. Test-only, never cryptographic. */
export class SeededRandom implements Random {
  private state: number;

  constructor(seed = 0x5a1d1a) {
    if (!Number.isInteger(seed) || seed === 0) {
      throw new RangeError("seed must be a non-zero integer");
    }
    this.state = seed >>> 0;
  }

  bytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError("length must be a non-negative integer");
    }
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      let x = this.state;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.state = x >>> 0;
      out[i] = this.state & 0xff;
    }
    return out;
  }
}
