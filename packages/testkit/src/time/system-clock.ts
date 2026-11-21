// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from "../ports.ts";

/** The only production adapter allowed to read the wall clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date(Date.now());
  }
}
