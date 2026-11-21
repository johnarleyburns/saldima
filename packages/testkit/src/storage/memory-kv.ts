// SPDX-License-Identifier: AGPL-3.0-only

import { FaultInjector } from "../faults.ts";
import type { KeyValueStore } from "../ports.ts";

export class InMemoryKeyValueStore implements KeyValueStore {
  readonly values = new Map<string, string>();

  constructor(readonly faults = new FaultInjector()) {}

  async get(key: string): Promise<string | null> {
    this.faults.throwIfPlanned("kv.get");
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.faults.throwIfPlanned("kv.put");
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.faults.throwIfPlanned("kv.delete");
    this.values.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    this.faults.throwIfPlanned("kv.list");
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
