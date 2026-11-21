// SPDX-License-Identifier: AGPL-3.0-only

import { FaultInjector } from "../faults.ts";
import type { ObjectStore, StoredObject } from "../ports.ts";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  constructor(readonly faults = new FaultInjector()) {}

  async put(
    key: string,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<StoredObject> {
    this.faults.throwIfPlanned("r2.put");
    const copy = bytes.slice();
    const object: StoredObject = {
      bytes: copy,
      etag: await sha256Hex(copy),
      contentType: contentType ?? "application/octet-stream",
    };
    this.objects.set(key, object);
    return object;
  }

  async get(key: string): Promise<StoredObject | null> {
    this.faults.throwIfPlanned("r2.get");
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.faults.throwIfPlanned("r2.delete");
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    this.faults.throwIfPlanned("r2.list");
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
