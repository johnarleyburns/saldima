// SPDX-License-Identifier: AGPL-3.0-only

/** Deterministic, scripted failures for contract tests. */
export class FaultInjector {
  private readonly plans = new Map<string, Error[]>();

  failNext(method: string, error: Error, times = 1): void {
    if (!Number.isInteger(times) || times < 1) {
      throw new RangeError("times must be a positive integer");
    }
    const queue = this.plans.get(method) ?? [];
    for (let i = 0; i < times; i += 1) queue.push(error);
    this.plans.set(method, queue);
  }

  take(method: string): Error | undefined {
    return this.plans.get(method)?.shift();
  }

  throwIfPlanned(method: string): void {
    const error = this.take(method);
    if (error) throw error;
  }

  pending(method: string): number {
    return this.plans.get(method)?.length ?? 0;
  }
}
