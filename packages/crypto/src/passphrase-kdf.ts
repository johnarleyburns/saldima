// SPDX-License-Identifier: AGPL-3.0-only

import { toArrayBuffer, utf8Encode } from "./bytes.ts";

/**
 * PBKDF2-SHA256 iteration count, per OWASP's current guidance. Raising it
 * later only affects newly derived keys -- existing wrapped DEKs carry
 * their own iteration count (see `passphrase-kdf.test.ts`'s cross-version
 * expectations in the envelope module) so a bump never breaks old vaults.
 */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

/**
 * Derives a non-extractable AES-KW key-encryption-key from a passphrase.
 * The passphrase is never retained: only the derived `CryptoKey` is
 * returned, and WebCrypto never exposes a non-extractable key's raw bytes.
 */
export async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(utf8Encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    material,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}
