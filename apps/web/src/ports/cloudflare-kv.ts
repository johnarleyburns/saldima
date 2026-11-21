// SPDX-License-Identifier: AGPL-3.0-only
import type { KeyValueStore } from "../../../../packages/testkit/src/ports.ts";

export interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>;
}

export function cloudflareKv(namespace: KvNamespaceLike): KeyValueStore {
  return {
    get: (key) => namespace.get(key),
    put: (key, value) => namespace.put(key, value),
    delete: (key) => namespace.delete(key),
    list: async (prefix) =>
      (await namespace.list({ prefix })).keys.map((key) => key.name).sort(),
  };
}
