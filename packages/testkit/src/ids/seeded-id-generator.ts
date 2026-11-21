// SPDX-License-Identifier: AGPL-3.0-only
import { guidFrom } from "@saldima/gnucash";
import type { Guid, IdGenerator } from "../ports.ts";

/** Deterministic 32-hex GUIDs. Never use in production. */
export class SeededIdGenerator implements IdGenerator {
  private counter: bigint;

  constructor(start = 0n) {
    this.counter = start;
  }

  next(): Guid {
    const value = this.counter;
    this.counter += 1n;
    return guidFrom(value.toString(16).padStart(32, "0"));
  }
}
