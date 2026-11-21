// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Release-level schema gate. GnuCash stores per-table versions in `versions`;
 * that deeper check arrives with the introspected schema. This guard refuses
 * whole release lines we have never tested.
 */
export function isTestedGnuCashRelease(major: number, minor: number): boolean {
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major < 0 || minor < 0) return false;
  if (major === 4) return minor === 14;
  if (major === 5) return minor >= 0 && minor <= 99;
  return false;
}
