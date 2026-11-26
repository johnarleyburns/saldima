// SPDX-License-Identifier: AGPL-3.0-only

import { base64UrlToBytes } from "./auth.ts";

const encoder = new TextEncoder();
const IV_BYTES = 12;

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function bookEncryptionKey(
  masterKeyBase64: string,
  tenantId: string,
): Promise<CryptoKey> {
  if (!masterKeyBase64) {
    throw new RangeError("MASTER_KEY is not configured; cannot encrypt book data");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    bufferSource(base64UrlToBytes(masterKeyBase64)),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bufferSource(encoder.encode(tenantId)),
      info: bufferSource(encoder.encode("saldima/book/v1")),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypts book bytes (gzip XML) for storage at rest in R2, so the cloud
 * copy is never plaintext -- only a tenant's own `MASTER_KEY`-derived key
 * (scoped by tenant and HKDF "info") can decrypt it. Wire format is
 * `[12-byte IV][AES-256-GCM ciphertext+tag]`.
 */
export async function encryptBookBytes(
  masterKeyBase64: string,
  tenantId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await bookEncryptionKey(masterKeyBase64, tenantId);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bufferSource(iv) },
      key,
      bufferSource(plaintext),
    ),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return combined;
}

export async function decryptBookBytes(
  masterKeyBase64: string,
  tenantId: string,
  combined: Uint8Array,
): Promise<Uint8Array> {
  if (combined.length <= IV_BYTES) {
    throw new RangeError("encrypted book payload is too short");
  }
  const key = await bookEncryptionKey(masterKeyBase64, tenantId);
  const iv = combined.subarray(0, IV_BYTES);
  const ciphertext = combined.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bufferSource(iv) },
    key,
    bufferSource(ciphertext),
  );
  return new Uint8Array(plaintext);
}
