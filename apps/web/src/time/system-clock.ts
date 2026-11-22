// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one place in apps/web allowed to read the wall clock. Product code calls
 * `nowIso()`; tests pass explicit times to pure functions.
 */
export function now(): Date {
  return new Date(Date.now());
}

export function nowIso(): string {
  return now().toISOString();
}

export function epochMs(): number {
  return now().getTime();
}

export function isoAfterSeconds(seconds: number): string {
  return new Date(epochMs() + seconds * 1000).toISOString();
}
