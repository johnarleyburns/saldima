// SPDX-License-Identifier: AGPL-3.0-only
import type { IdGenerator } from "../ports.ts";

/** Deterministic 32-hex GUIDs. Never use in production. */
export class SeededIdGenerator implements IdGenerator {
  private counter: bigint;

  constructor(start = 0n) {
    this.counter = start;
  }

  next(): string {
    const value = this.counter;
    this.counter += 1n;
    return value.toString(16).padStart(32, "0");
  }
}
