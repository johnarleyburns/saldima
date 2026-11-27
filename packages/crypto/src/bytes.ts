// SPDX-License-Identifier: AGPL-3.0-only

/** Cryptographically random bytes, via the platform's WebCrypto RNG. */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Copies into a plain, non-shared `ArrayBuffer`. WebCrypto's types want a
 * `BufferSource` backed by `ArrayBuffer` specifically; a `Uint8Array` view
 * is typed as possibly `SharedArrayBuffer`-backed, which TypeScript now
 * rejects even though no shared buffer is ever actually involved here.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
