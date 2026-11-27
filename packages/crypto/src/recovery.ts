// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes, toArrayBuffer, utf8Encode } from "./bytes.ts";

/**
 * Crockford base32's 32-symbol alphabet: digits plus A-Z excluding I, L, O
 * and U (each dropped for looking like another symbol -- I/L look like 1,
 * O looks like 0, U looks like V), so a user can transcribe it by hand
 * without guessing. Must be exactly 32 characters for 5-bit encoding.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP_SIZE = 5;
const GROUP_COUNT = 5;

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * Generates a high-entropy recovery code, grouped for readability (e.g.
 * `C04KV-31VF8-0K0JW-R7NPT-007DW`). Shown once at vault setup; never
 * uploaded. Losing both the vault passphrase and this code makes the
 * vault permanently unrecoverable -- an intentional consequence of
 * zero-knowledge encryption, not a bug.
 */
export function generateRecoveryCode(): string {
  const raw = encodeBase32(randomBytes(20)).slice(0, GROUP_SIZE * GROUP_COUNT);
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP_SIZE) {
    groups.push(raw.slice(i, i + GROUP_SIZE));
  }
  return groups.join("-");
}

/**
 * Derives a non-extractable AES-KW key-encryption-key directly from a
 * recovery code's own entropy -- no PBKDF2 needed, the code is already
 * high-entropy random output, not a human-chosen passphrase.
 */
export async function deriveKekFromRecoveryCode(code: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(utf8Encode(code.trim().toUpperCase())),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(new Uint8Array(0)),
      info: toArrayBuffer(utf8Encode("saldima/vault/recovery/v1")),
    },
    material,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}
