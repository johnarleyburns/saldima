// SPDX-License-Identifier: AGPL-3.0-only

import { type BookSnapshot, GncXmlDocument, writeGnuCashXml } from "@saldima/gnucash";
import { decryptBookBytes, encryptBookBytes } from "./book-encryption.ts";
import type { R2BucketLike } from "./ports/cloudflare-r2.ts";

/** How many past versions of a book are kept for rollback; older ones are pruned. */
const MAX_VERSIONS = 30;

function versionPrefix(tenantId: string, bookId: string): string {
  return `tenants/${tenantId}/books/${bookId}/`;
}

function versionKey(tenantId: string, bookId: string, now: string): string {
  const nonce = crypto.randomUUID();
  return `${versionPrefix(tenantId, bookId)}${now}-${nonce}.gnucash.gz.enc`;
}

function arrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([arrayBufferCopy(bytes)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([arrayBufferCopy(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The live, per-book GnuCash XML document for one tenant's Book Durable
 * Object. The cloud copy (R2) is always an encrypted, versioned object --
 * never plaintext at rest. Opening a book downloads and decrypts its latest
 * version into the Durable Object's own (in-memory) working copy; saving
 * re-encrypts and writes a *new* version rather than overwriting, so earlier
 * versions stay available as backups, pruned to the most recent
 * `MAX_VERSIONS`. Documents are cached in memory for the life of the DO
 * instance and reloaded from R2 (never recreated) after an eviction.
 */
export class BookXmlStore {
  private readonly cache = new Map<string, GncXmlDocument>();

  constructor(
    private readonly bucket: R2BucketLike,
    private readonly tenantId: string,
    private readonly masterKey: string,
  ) {}

  async get(bookId: string): Promise<GncXmlDocument | null> {
    const cached = this.cache.get(bookId);
    if (cached) return cached;
    const latest = await this.latestVersionKey(bookId);
    if (!latest) return null;
    const object = await this.bucket.get(latest);
    if (!object) return null;
    const encrypted = new Uint8Array(await object.arrayBuffer());
    const gzipped = await decryptBookBytes(this.masterKey, this.tenantId, encrypted);
    const xml = new TextDecoder().decode(await gunzip(gzipped));
    const document = GncXmlDocument.parse(xml);
    this.cache.set(bookId, document);
    return document;
  }

  /** Replaces the whole book (a new company, or an import) with a fresh document. */
  async replace(
    bookId: string,
    snapshot: BookSnapshot,
    now: string,
  ): Promise<GncXmlDocument> {
    const document = GncXmlDocument.parse(writeGnuCashXml(snapshot));
    await this.save(bookId, document, now);
    return document;
  }

  /** Persists a new version (never overwrites) and prunes beyond `MAX_VERSIONS`. */
  async save(bookId: string, document: GncXmlDocument, now: string): Promise<void> {
    const gzipped = await gzip(new TextEncoder().encode(document.serialize()));
    const encrypted = await encryptBookBytes(this.masterKey, this.tenantId, gzipped);
    await this.bucket.put(versionKey(this.tenantId, bookId, now), encrypted, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    this.cache.set(bookId, document);
    await this.pruneOldVersions(bookId);
  }

  async delete(bookId: string): Promise<void> {
    this.cache.delete(bookId);
    const keys = await this.allVersionKeys(bookId);
    for (const key of keys) await this.bucket.delete(key);
  }

  private async allVersionKeys(bookId: string): Promise<string[]> {
    const listing = await this.bucket.list({
      prefix: versionPrefix(this.tenantId, bookId),
    });
    return listing.objects.map((object) => object.key).sort();
  }

  private async latestVersionKey(bookId: string): Promise<string | null> {
    const keys = await this.allVersionKeys(bookId);
    return keys.length > 0 ? (keys[keys.length - 1] ?? null) : null;
  }

  private async pruneOldVersions(bookId: string): Promise<void> {
    const keys = await this.allVersionKeys(bookId);
    const stale = keys.slice(0, Math.max(0, keys.length - MAX_VERSIONS));
    for (const key of stale) await this.bucket.delete(key);
  }
}
