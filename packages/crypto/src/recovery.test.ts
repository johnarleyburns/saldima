// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { decryptPayload, encryptPayload } from "./envelope.ts";
import { deriveKekFromRecoveryCode, generateRecoveryCode } from "./recovery.ts";
import { generateDek, unwrapDek, wrapDek } from "./vault-key.ts";

const AAD = { bookId: "book-1", snapshotId: "snap-1", schemaVersion: "1" };

describe("recovery", () => {
  it("generates a grouped, unambiguous-alphabet code of the expected shape", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(
      /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/,
    );
    for (const ambiguous of ["I", "L", "O", "U"]) {
      expect(code).not.toContain(ambiguous);
    }
  });

  it("generates a different code every time", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(20);
  });

  it("wraps and unwraps a DEK under a recovery-code-derived key, case- and whitespace-insensitively", async () => {
    const code = generateRecoveryCode();
    const dek = await generateDek();
    const kek = await deriveKekFromRecoveryCode(code);
    const wrapped = await wrapDek(dek, kek);

    const unwrapped = await unwrapDek(
      wrapped,
      await deriveKekFromRecoveryCode(`  ${code.toLowerCase()}  `),
    );
    const envelope = await encryptPayload(dek, new TextEncoder().encode("ok"), AAD);
    expect(
      new TextDecoder().decode(await decryptPayload(unwrapped, envelope, AAD)),
    ).toBe("ok");
  });

  it("refuses to unwrap under a different recovery code", async () => {
    const dek = await generateDek();
    const kek = await deriveKekFromRecoveryCode(generateRecoveryCode());
    const wrapped = await wrapDek(dek, kek);
    const wrongKek = await deriveKekFromRecoveryCode(generateRecoveryCode());
    await expect(unwrapDek(wrapped, wrongKek)).rejects.toThrow();
  });

  it("lets either the passphrase KEK or the recovery-code KEK unwrap the same DEK", async () => {
    const dek = await generateDek();
    const code = generateRecoveryCode();
    const recoveryKek = await deriveKekFromRecoveryCode(code);
    const wrappedByRecovery = await wrapDek(dek, recoveryKek);

    const unwrapped = await unwrapDek(wrappedByRecovery, recoveryKek);
    const envelope = await encryptPayload(dek, new TextEncoder().encode("ok"), AAD);
    expect(
      new TextDecoder().decode(await decryptPayload(unwrapped, envelope, AAD)),
    ).toBe("ok");
  });
});
