// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { randomBytes } from "./bytes.ts";
import { decryptPayload, encryptPayload } from "./envelope.ts";
import { DEFAULT_PBKDF2_ITERATIONS, deriveKek } from "./passphrase-kdf.ts";
import { generateDek, unwrapDek, wrapDek } from "./vault-key.ts";

const AAD = { bookId: "book-1", snapshotId: "snap-1", schemaVersion: "1" };

describe("passphrase-kdf", () => {
  it("derives a usable AES-KW key from a passphrase and salt", async () => {
    const kek = await deriveKek("correct horse battery staple", randomBytes(16));
    const dek = await generateDek();
    const unwrapped = await unwrapDek(await wrapDek(dek, kek), kek);

    const envelope = await encryptPayload(dek, new TextEncoder().encode("ok"), AAD);
    expect(
      new TextDecoder().decode(await decryptPayload(unwrapped, envelope, AAD)),
    ).toBe("ok");
  });

  it("derives a different key for the same passphrase under a different salt", async () => {
    const passphrase = "correct horse battery staple";
    const dek = await generateDek();
    const saltA = randomBytes(16);
    const saltB = randomBytes(16);

    const kekA = await deriveKek(passphrase, saltA);
    const kekB = await deriveKek(passphrase, saltB);
    const wrapped = await wrapDek(dek, kekA);

    await expect(unwrapDek(wrapped, kekB)).rejects.toThrow();
  });

  it("respects an explicit iteration count distinct from the default", async () => {
    const passphrase = "correct horse battery staple";
    const salt = randomBytes(16);
    const dek = await generateDek();

    const kekDefault = await deriveKek(passphrase, salt);
    const kekExplicit = await deriveKek(passphrase, salt, 100_000);
    expect(DEFAULT_PBKDF2_ITERATIONS).not.toBe(100_000);

    const wrapped = await wrapDek(dek, kekDefault);
    await expect(unwrapDek(wrapped, kekExplicit)).rejects.toThrow();
  });
});
