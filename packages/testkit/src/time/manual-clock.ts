// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from "../ports.ts";

export class ManualClock implements Clock {
  private currentMs: number;

  constructor(start: string | Date = "2026-01-01T00:00:00.000Z") {
    this.currentMs = new Date(start).getTime();
    if (Number.isNaN(this.currentMs)) throw new RangeError("invalid start time");
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("cannot move the clock backwards");
    }
    this.currentMs += ms;
  }

  set(at: string | Date): void {
    const next = new Date(at).getTime();
    if (Number.isNaN(next)) throw new RangeError("invalid time");
    this.currentMs = next;
  }
}
