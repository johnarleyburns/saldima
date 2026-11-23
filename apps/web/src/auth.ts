// SPDX-License-Identifier: AGPL-3.0-only

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return base64ToBytes(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    const leftByte = left[i] ?? 0;
    const rightByte = right[i] ?? 0;
    difference |= leftByte ^ rightByte;
  }
  return difference === 0;
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  return timingSafeEqual(encoder.encode(left), encoder.encode(right));
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await sha256(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function newSessionToken(): Promise<string> {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    bufferSource(encoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bufferSource(salt),
      iterations,
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

// Cloudflare's WebCrypto rejects PBKDF2 iteration counts above 100,000.
// Keep the stored format versioned so this can move if the platform does.
export const PASSWORD_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(
  password: string,
  iterations: number = PASSWORD_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, iterations);
  return `pbkdf2$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const saltPart = parts[2];
  const hashPart = parts[3];
  if (!saltPart || !hashPart) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlToBytes(saltPart);
    expected = base64UrlToBytes(hashPart);
  } catch {
    return false;
  }
  const actual = await derivePassword(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  const output: number[] = [];
  let value = 0;
  let bits = 0;
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new RangeError("invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function totpUri(
  secret: string,
  accountName: string,
  issuer = "Saldima",
): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

async function totpCodeAt(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    bufferSource(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, bufferSource(message)),
  );
  const offset = (digest[19] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export async function totpCode(secretBase32: string, nowMs: number): Promise<string> {
  const counter = Math.floor(nowMs / 1000 / 30);
  return totpCodeAt(base32Decode(secretBase32), counter);
}

export async function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  window = 1,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  let secret: Uint8Array;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  const counter = Math.floor(nowMs / 1000 / 30);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = await totpCodeAt(secret, counter + offset);
    if (timingSafeStringEqual(candidate, code)) return true;
  }
  return false;
}

async function totpEncryptionKey(
  masterKeyBase64: string,
  tenantId: string,
): Promise<CryptoKey> {
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
      info: bufferSource(encoder.encode("saldima/totp/v1")),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptTotpSecret(
  masterKeyBase64: string,
  tenantId: string,
  secret: string,
): Promise<string> {
  const key = await totpEncryptionKey(masterKeyBase64, tenantId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bufferSource(iv) },
      key,
      bufferSource(encoder.encode(secret)),
    ),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

export async function decryptTotpSecret(
  masterKeyBase64: string,
  tenantId: string,
  payload: string,
): Promise<string> {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== "v1")
    throw new RangeError("invalid secret payload");
  const ivPart = parts[1];
  const ciphertextPart = parts[2];
  if (!ivPart || !ciphertextPart) throw new RangeError("invalid secret payload");
  const key = await totpEncryptionKey(masterKeyBase64, tenantId);
  const iv = base64UrlToBytes(ivPart);
  const ciphertext = base64UrlToBytes(ciphertextPart);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bufferSource(iv) },
    key,
    bufferSource(ciphertext),
  );
  return decoder.decode(plaintext);
}

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-saldima_session" : "saldima_session";
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(
  name: string,
  token: string,
  secure: boolean,
  maxAgeSeconds = 30 * 24 * 60 * 60,
): string {
  const attributes = [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedSessionCookie(name: string, secure: boolean): string {
  return sessionCookie(name, "", secure, 0);
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
