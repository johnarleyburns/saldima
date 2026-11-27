// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { randomBytes } from "./bytes.ts";
import { decryptPayload, encryptPayload } from "./envelope.ts";
import { deriveKek } from "./passphrase-kdf.ts";
import { generateDek, unwrapDek, wrapDek } from "./vault-key.ts";

const AAD = { bookId: "book-1", snapshotId: "snap-1", schemaVersion: "1" };

describe("vault-key", () => {
  it("wraps and unwraps a DEK under a passphrase-derived KEK, and the unwrapped DEK still decrypts", async () => {
    const dek = await generateDek();
    const kek = await deriveKek("correct horse battery staple", randomBytes(16));

    const wrapped = await wrapDek(dek, kek);
    const unwrapped = await unwrapDek(wrapped, kek);

    const plaintext = new TextEncoder().encode("hello vault");
    const envelope = await encryptPayload(dek, plaintext, AAD);
    const decrypted = await decryptPayload(unwrapped, envelope, AAD);
    expect(new TextDecoder().decode(decrypted)).toBe("hello vault");
  });

  it("refuses to unwrap a DEK under the wrong KEK", async () => {
    const dek = await generateDek();
    const salt = randomBytes(16);
    const rightKek = await deriveKek("correct horse battery staple", salt);
    const wrongKek = await deriveKek("a different passphrase", salt);

    const wrapped = await wrapDek(dek, rightKek);
    await expect(unwrapDek(wrapped, wrongKek)).rejects.toThrow();
  });

  it("refuses to unwrap a tampered wrapped-key blob", async () => {
    const dek = await generateDek();
    const kek = await deriveKek("correct horse battery staple", randomBytes(16));
    const wrapped = await wrapDek(dek, kek);
    const tampered = new Uint8Array(wrapped);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await expect(unwrapDek(tampered, kek)).rejects.toThrow();
  });

  it("generates DEKs that are each independently usable for encrypt/decrypt", async () => {
    const dekA = await generateDek();
    const dekB = await generateDek();
    const plaintext = new TextEncoder().encode("secret");
    const envelope = await encryptPayload(dekA, plaintext, AAD);
    await expect(decryptPayload(dekB, envelope, AAD)).rejects.toThrow();
  });
});
