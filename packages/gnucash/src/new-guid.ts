// SPDX-License-Identifier: AGPL-3.0-only

import { type Guid, guidFrom } from "./guid.ts";

/** Production GUID source. 32 lowercase hex, never sequential. */
export function newGuid(): Guid {
  return guidFrom(crypto.randomUUID().replaceAll("-", ""));
}
