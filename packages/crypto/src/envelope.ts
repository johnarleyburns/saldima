// SPDX-License-Identifier: AGPL-3.0-only

import {
  fromBase64,
  randomBytes,
  toArrayBuffer,
  toBase64,
  utf8Encode,
} from "./bytes.ts";

/** Binds a ciphertext to the record it claims to be, so a valid envelope
 * for one snapshot can't be silently replayed as another. */
export interface EnvelopeAad {
  readonly bookId: string;
  readonly snapshotId: string;
  readonly schemaVersion: string;
}

export interface DataEnvelopeV1 {
  readonly format: "saldima-vault-v1";
  readonly version: 1;
  readonly algorithm: "AES-256-GCM";
  readonly iv: string;
  readonly ciphertext: string;
  readonly aad: EnvelopeAad;
}

function canonicalAad(aad: EnvelopeAad): Uint8Array {
  return utf8Encode(
    JSON.stringify({
      bookId: aad.bookId,
      snapshotId: aad.snapshotId,
      schemaVersion: aad.schemaVersion,
    }),
  );
}

/** Encrypts `plaintext` under `dek`, authenticating `aad` as additional data. */
export async function encryptPayload(
  dek: CryptoKey,
  plaintext: Uint8Array,
  aad: EnvelopeAad,
): Promise<DataEnvelopeV1> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(canonicalAad(aad)),
    },
    dek,
    toArrayBuffer(plaintext),
  );
  return {
    format: "saldima-vault-v1",
    version: 1,
    algorithm: "AES-256-GCM",
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    aad,
  };
}

/**
 * Decrypts `envelope` under `dek`. `expectedAad` must match the envelope's
 * own `aad` field exactly -- a mismatch is rejected before any crypto runs
 * -- and is independently re-authenticated as AES-GCM additional data, so
 * tampering with either the ciphertext or the stored `aad` field (without
 * the DEK) is detected rather than silently accepted.
 */
export async function decryptPayload(
  dek: CryptoKey,
  envelope: DataEnvelopeV1,
  expectedAad: EnvelopeAad,
): Promise<Uint8Array> {
  if (
    envelope.aad.bookId !== expectedAad.bookId ||
    envelope.aad.snapshotId !== expectedAad.snapshotId ||
    envelope.aad.schemaVersion !== expectedAad.schemaVersion
  ) {
    throw new Error("envelope aad does not match the expected book/snapshot");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(fromBase64(envelope.iv)),
      additionalData: toArrayBuffer(canonicalAad(expectedAad)),
    },
    dek,
    toArrayBuffer(fromBase64(envelope.ciphertext)),
  );
  return new Uint8Array(plaintext);
}
