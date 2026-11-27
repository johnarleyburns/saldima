// SPDX-License-Identifier: AGPL-3.0-only

import type { R2BucketLike } from "./ports/cloudflare-r2.ts";

function keyEnvelopeObjectKey(tenantId: string, bookId: string): string {
  return `tenants/${tenantId}/books/${bookId}/vault-keys.json`;
}

function snapshotObjectKey(
  tenantId: string,
  bookId: string,
  snapshotId: string,
): string {
  return `tenants/${tenantId}/books/${bookId}/vault-snapshots/${snapshotId}.enc`;
}

/**
 * Opaque storage for the zero-knowledge vault (see `docs/architecture/
 * TECHNICAL-DESIGN.md` §8 and issue #88). Unlike `BookXmlStore` and
 * `ReceiptStore`, this never calls any crypto function on what it's
 * handed -- the bytes arriving here are already client-encrypted (or, for
 * the key envelope, already wrapped), so there is nothing for the server
 * to encrypt or decrypt. It only stores and serves opaque blobs.
 */
export class VaultStore {
  constructor(
    private readonly bucket: R2BucketLike,
    private readonly tenantId: string,
  ) {}

  async saveKeyEnvelope(bookId: string, json: string): Promise<void> {
    await this.bucket.put(
      keyEnvelopeObjectKey(this.tenantId, bookId),
      new TextEncoder().encode(json),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  async loadKeyEnvelope(bookId: string): Promise<string | null> {
    const object = await this.bucket.get(keyEnvelopeObjectKey(this.tenantId, bookId));
    if (!object) return null;
    return new TextDecoder().decode(await object.arrayBuffer());
  }

  async saveSnapshot(
    bookId: string,
    snapshotId: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.bucket.put(snapshotObjectKey(this.tenantId, bookId, snapshotId), bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  }

  async loadSnapshot(bookId: string, snapshotId: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(
      snapshotObjectKey(this.tenantId, bookId, snapshotId),
    );
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }
}
