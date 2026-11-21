// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ObjectStore,
  StoredObject,
} from "../../../../packages/testkit/src/ports.ts";

export interface R2ObjectLike {
  readonly etag: string;
  readonly httpMetadata?: { readonly contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ objects: Array<{ key: string }> }>;
}

function toStoredObject(object: R2ObjectLike, bytes: Uint8Array): StoredObject {
  return {
    bytes,
    etag: object.etag.replaceAll('"', ""),
    contentType: object.httpMetadata?.contentType,
  };
}

export function cloudflareR2(bucket: R2BucketLike): ObjectStore {
  return {
    async put(key, bytes, contentType) {
      const object = await bucket.put(key, bytes, {
        httpMetadata: { contentType: contentType ?? "application/octet-stream" },
      });
      if (!object) throw new Error("R2 put returned no object");
      return toStoredObject(object, bytes.slice());
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return toStoredObject(object, new Uint8Array(await object.arrayBuffer()));
    },
    delete: (key) => bucket.delete(key),
    list: async (prefix) =>
      (await bucket.list({ prefix })).objects.map((object) => object.key).sort(),
  };
}
