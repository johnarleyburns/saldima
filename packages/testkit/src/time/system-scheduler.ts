// SPDX-License-Identifier: AGPL-3.0-only
import type { CancelHandle, Scheduler } from "../ports.ts";

interface Timer {
  readonly id: ReturnType<typeof setTimeout>;
}

/** Production scheduler. Tests use ManualScheduler, never this. */
export class SystemScheduler implements Scheduler {
  private readonly timers = new Set<Timer>();

  schedule(delayMs: number, task: () => void): CancelHandle {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("delay must be a non-negative number");
    }
    const timer: Timer = {
      id: setTimeout(() => {
        this.timers.delete(timer);
        task();
      }, delayMs),
    };
    this.timers.add(timer);
    return {
      cancel: () => {
        if (!this.timers.delete(timer)) return;
        clearTimeout(timer.id);
      },
    };
  }
}
