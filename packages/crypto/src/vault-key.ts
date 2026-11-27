// SPDX-License-Identifier: AGPL-3.0-only

import { toArrayBuffer } from "./bytes.ts";

/**
 * The data-encryption-key (DEK): one per vault, generated once and never
 * re-derived. Wrapped (never stored raw) under one key-encryption-key per
 * unlock method -- a passphrase-derived KEK and a recovery-code-derived
 * KEK both wrap the *same* DEK, so either one unlocks the vault.
 */
export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function wrapDek(dek: CryptoKey, kek: CryptoKey): Promise<Uint8Array> {
  const wrapped = await crypto.subtle.wrapKey("raw", dek, kek, "AES-KW");
  return new Uint8Array(wrapped);
}

export async function unwrapDek(
  wrapped: Uint8Array,
  kek: CryptoKey,
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    toArrayBuffer(wrapped),
    kek,
    "AES-KW",
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}
