// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  base32Decode,
  base32Encode,
  base64UrlToBytes,
  bytesToBase64Url,
  clearedSessionCookie,
  decryptTotpSecret,
  encryptTotpSecret,
  hashPassword,
  isSameOrigin,
  newTotpSecret,
  readCookie,
  sessionCookie,
  sha256Hex,
  totpCode,
  totpUri,
  verifyPassword,
  verifyTotp,
} from "./auth.ts";

describe("password hashing", () => {
  it("verifies only the right password", async () => {
    const stored = await hashPassword("correct horse battery staple", 1_000);
    expect(stored.startsWith("pbkdf2$1000$")).toBe(true);
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(
      true,
    );
    await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    await expect(verifyPassword("x", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("x", "pbkdf2$0$a$b")).resolves.toBe(false);
    await expect(verifyPassword("x", "pbkdf2$1000$!!!$b")).resolves.toBe(false);
  });
});

describe("base32 and TOTP", () => {
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("round-trips base32", () => {
    expect(base32Encode(new TextEncoder().encode("hello"))).toBe("NBSWY3DP");
    expect(new TextDecoder().decode(base32Decode("NBSWY3DP"))).toBe("hello");
  });

  it("matches the RFC 6238 SHA-1 vector", async () => {
    // T = 59 seconds -> counter 1, 6-digit code.
    await expect(totpCode(rfcSecret, 59_000)).resolves.toBe("287082");
    await expect(verifyTotp(rfcSecret, "287082", 59_000)).resolves.toBe(true);
  });

  it("accepts one period of clock drift and rejects bad codes", async () => {
    const code = await totpCode(rfcSecret, 59_000);
    await expect(verifyTotp(rfcSecret, code, 89_000)).resolves.toBe(true);
    await expect(verifyTotp(rfcSecret, code, 119_000)).resolves.toBe(false);
    await expect(verifyTotp(rfcSecret, code, 150_000)).resolves.toBe(false);
    await expect(verifyTotp(rfcSecret, "000000", 59_000)).resolves.toBe(false);
    await expect(verifyTotp(rfcSecret, "12345", 59_000)).resolves.toBe(false);
  });

  it("builds a secret and otpauth URI", () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(totpUri(secret, "owner@example.test")).toContain("otpauth://totp/Saldima:");
  });
});

describe("TOTP secret encryption", () => {
  const master = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));

  it("round-trips for the same tenant only", async () => {
    const payload = await encryptTotpSecret(master, "tenant-alice", "JBSWY3DPEHPK3PXP");
    await expect(decryptTotpSecret(master, "tenant-alice", payload)).resolves.toBe(
      "JBSWY3DPEHPK3PXP",
    );
    await expect(decryptTotpSecret(master, "tenant-bob", payload)).rejects.toThrow();
  });

  it("rejects malformed payloads", async () => {
    await expect(decryptTotpSecret(master, "t", "nope")).rejects.toThrow();
  });
});

describe("tokens and cookies", () => {
  it("hashes deterministically", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("encodes base64url without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(bytesToBase64Url(bytes)).not.toContain("=");
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });

  it("writes and reads secure cookies", () => {
    const cookie = sessionCookie("__Host-saldima_session", "token", true);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(
      readCookie("a=1; __Host-saldima_session=token", "__Host-saldima_session"),
    ).toBe("token");
    expect(clearedSessionCookie("__Host-saldima_session", true)).toContain("Max-Age=0");
  });

  it("checks the Origin against the request host", () => {
    const same = new Request("https://alice.example/app/login", {
      method: "POST",
      headers: { Origin: "https://alice.example" },
    });
    const cross = new Request("https://alice.example/app/login", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(isSameOrigin(same)).toBe(true);
    expect(isSameOrigin(cross)).toBe(false);
  });
});
