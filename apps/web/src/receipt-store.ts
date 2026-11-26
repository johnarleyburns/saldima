// SPDX-License-Identifier: AGPL-3.0-only

import { decryptBookBytes, encryptBookBytes } from "./book-encryption.ts";
import type { R2BucketLike } from "./ports/cloudflare-r2.ts";

function objectKey(tenantId: string, bookId: string, relativePath: string): string {
  return `tenants/${tenantId}/books/${bookId}/${relativePath}`;
}

/**
 * Captured receipt images, encrypted at rest the same way the book itself
 * is (reusing `book-encryption.ts`'s per-tenant key -- the encryption is
 * generic byte encryption, not XML-specific). Each image is addressed by a
 * path relative to the book, the same convention `GncXmlDocument`'s
 * `assoc_uri` doc-link stores on the transaction it documents.
 */
export class ReceiptStore {
  constructor(
    private readonly bucket: R2BucketLike,
    private readonly tenantId: string,
    private readonly masterKey: string,
  ) {}

  /** Encrypts and stores the image, returning its relative path. */
  async save(bookId: string, bytes: Uint8Array, extension: string): Promise<string> {
    const relativePath = `receipts/${crypto.randomUUID()}.${extension}`;
    const encrypted = await encryptBookBytes(this.masterKey, this.tenantId, bytes);
    await this.bucket.put(objectKey(this.tenantId, bookId, relativePath), encrypted, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    return relativePath;
  }

  async load(bookId: string, relativePath: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(
      objectKey(this.tenantId, bookId, relativePath),
    );
    if (!object) return null;
    const encrypted = new Uint8Array(await object.arrayBuffer());
    return decryptBookBytes(this.masterKey, this.tenantId, encrypted);
  }

  async delete(bookId: string, relativePath: string): Promise<void> {
    await this.bucket.delete(objectKey(this.tenantId, bookId, relativePath));
  }
}
