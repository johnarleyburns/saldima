// SPDX-License-Identifier: AGPL-3.0-only
import type { CancelHandle, Scheduler } from "../ports.ts";

interface ScheduledTask {
  readonly dueMs: number;
  readonly sequence: number;
  readonly task: () => void;
  cancelled: boolean;
}

export class ManualScheduler implements Scheduler {
  private currentMs = 0;
  private sequence = 0;
  private readonly tasks: ScheduledTask[] = [];

  schedule(delayMs: number, task: () => void): CancelHandle {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("delay must be a non-negative number");
    }
    const entry: ScheduledTask = {
      dueMs: this.currentMs + delayMs,
      sequence: this.sequence,
      task,
      cancelled: false,
    };
    this.sequence += 1;
    this.tasks.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  /** Fire due tasks in (due, insertion) order. Errors propagate to the caller. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("cannot move the scheduler backwards");
    }
    const target = this.currentMs + ms;
    for (;;) {
      const due = this.tasks
        .filter((entry) => !entry.cancelled && entry.dueMs <= target)
        .sort((a, b) => a.dueMs - b.dueMs || a.sequence - b.sequence)[0];
      if (!due) break;
      this.tasks.splice(this.tasks.indexOf(due), 1);
      this.currentMs = due.dueMs;
      due.task();
    }
    this.currentMs = target;
  }

  pending(): number {
    return this.tasks.filter((entry) => !entry.cancelled).length;
  }
}
