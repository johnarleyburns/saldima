// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { decryptBookBytes, encryptBookBytes } from "./book-encryption.ts";

const MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

describe("book encryption", () => {
  it("round-trips bytes for the same tenant", async () => {
    const plaintext = new TextEncoder().encode("<gnc-v2>hello</gnc-v2>");
    const encrypted = await encryptBookBytes(MASTER_KEY, "tenant-1", plaintext);
    expect(encrypted).not.toEqual(plaintext);
    const decrypted = await decryptBookBytes(MASTER_KEY, "tenant-1", encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it("never emits recognisable plaintext in the ciphertext bytes", async () => {
    const plaintext = new TextEncoder().encode("Opening deposit".repeat(10));
    const encrypted = await encryptBookBytes(MASTER_KEY, "tenant-1", plaintext);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(encrypted);
    expect(text).not.toContain("Opening deposit");
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", async () => {
    const plaintext = new TextEncoder().encode("same content");
    const first = await encryptBookBytes(MASTER_KEY, "tenant-1", plaintext);
    const second = await encryptBookBytes(MASTER_KEY, "tenant-1", plaintext);
    expect(first).not.toEqual(second);
  });

  it("refuses to decrypt with a different tenant's derived key", async () => {
    const plaintext = new TextEncoder().encode("tenant-1's data");
    const encrypted = await encryptBookBytes(MASTER_KEY, "tenant-1", plaintext);
    await expect(decryptBookBytes(MASTER_KEY, "tenant-2", encrypted)).rejects.toThrow();
  });

  it("refuses to decrypt tampered ciphertext", async () => {
    const plaintext = new TextEncoder().encode("tamper check");
    const encrypted = await encryptBookBytes(MASTER_KEY, "tenant-1", plaintext);
    const tampered = encrypted.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await expect(decryptBookBytes(MASTER_KEY, "tenant-1", tampered)).rejects.toThrow();
  });

  it("rejects an empty or too-short payload", async () => {
    await expect(
      decryptBookBytes(MASTER_KEY, "tenant-1", new Uint8Array(5)),
    ).rejects.toThrow(RangeError);
  });

  it("throws clearly when no master key is configured", async () => {
    const plaintext = new TextEncoder().encode("x");
    await expect(encryptBookBytes("", "tenant-1", plaintext)).rejects.toThrow(
      RangeError,
    );
  });
});
