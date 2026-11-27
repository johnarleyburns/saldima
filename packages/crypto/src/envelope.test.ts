// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./bytes.ts";
import { decryptPayload, encryptPayload } from "./envelope.ts";
import { generateDek } from "./vault-key.ts";

const AAD = { bookId: "book-1", snapshotId: "snap-1", schemaVersion: "1" };

describe("envelope", () => {
  it("round-trips a real book-sized payload", async () => {
    const dek = await generateDek();
    const plaintext = utf8Encode("x".repeat(5000));

    const envelope = await encryptPayload(dek, plaintext, AAD);
    expect(envelope).toMatchObject({
      format: "saldima-vault-v1",
      version: 1,
      algorithm: "AES-256-GCM",
      aad: AAD,
    });

    const decrypted = await decryptPayload(dek, envelope, AAD);
    expect(utf8Decode(decrypted)).toBe("x".repeat(5000));
  });

  it("rejects decryption with the wrong DEK", async () => {
    const dek = await generateDek();
    const otherDek = await generateDek();
    const envelope = await encryptPayload(dek, utf8Encode("secret"), AAD);
    await expect(decryptPayload(otherDek, envelope, AAD)).rejects.toThrow();
  });

  it("rejects a tampered ciphertext byte", async () => {
    const dek = await generateDek();
    const envelope = await encryptPayload(dek, utf8Encode("secret"), AAD);
    const bytes = fromBase64(envelope.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = { ...envelope, ciphertext: toBase64(bytes) };
    await expect(decryptPayload(dek, tampered, AAD)).rejects.toThrow();
  });

  it("rejects a tampered IV", async () => {
    const dek = await generateDek();
    const envelope = await encryptPayload(dek, utf8Encode("secret"), AAD);
    const bytes = fromBase64(envelope.iv);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = { ...envelope, iv: toBase64(bytes) };
    await expect(decryptPayload(dek, tampered, AAD)).rejects.toThrow();
  });

  it("rejects decrypting under a different expected bookId, snapshotId or schemaVersion", async () => {
    const dek = await generateDek();
    const envelope = await encryptPayload(dek, utf8Encode("secret"), AAD);

    await expect(
      decryptPayload(dek, envelope, { ...AAD, bookId: "book-2" }),
    ).rejects.toThrow();
    await expect(
      decryptPayload(dek, envelope, { ...AAD, snapshotId: "snap-2" }),
    ).rejects.toThrow();
    await expect(
      decryptPayload(dek, envelope, { ...AAD, schemaVersion: "2" }),
    ).rejects.toThrow();
  });

  it("rejects a relabeled envelope whose stored aad was changed without re-encrypting", async () => {
    const dek = await generateDek();
    const envelope = await encryptPayload(dek, utf8Encode("secret"), AAD);
    const relabeled = { ...envelope, aad: { ...AAD, bookId: "book-2" } };

    // Decrypting as the relabeled claim fails the real AES-GCM tag check.
    await expect(decryptPayload(dek, relabeled, relabeled.aad)).rejects.toThrow();
    // Decrypting as the original claim fails the stored-aad consistency check.
    await expect(decryptPayload(dek, relabeled, AAD)).rejects.toThrow();
  });
});
