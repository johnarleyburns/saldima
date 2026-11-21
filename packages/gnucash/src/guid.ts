// SPDX-License-Identifier: AGPL-3.0-only

declare const guidBrand: unique symbol;

/** A GnuCash GUID: exactly 32 lowercase hexadecimal characters. */
export type Guid = string & { readonly [guidBrand]: true };

const GUID_PATTERN = /^[0-9a-f]{32}$/;

export function isGuid(value: string): value is Guid {
  return GUID_PATTERN.test(value);
}

export function guidFrom(value: string): Guid {
  if (!isGuid(value)) throw new RangeError(`invalid GUID: ${value}`);
  return value;
}

export interface GuidSource {
  next(): string;
}

/** Validate generator output at the boundary so a bad generator cannot leak in. */
export function generateGuid(source: GuidSource): Guid {
  return guidFrom(source.next());
}
