// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from "node:crypto";

import { expect, type Page, type TestInfo, test } from "@playwright/test";

const PORT = 8789;
const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "local-setup-token";
const PASSWORD = "correct horse battery staple";

test.setTimeout(60_000);

function bookUrl(name: string, testInfo: TestInfo, path = ""): string {
  return `http://${name}-${testInfo.project.name}.localhost:${PORT}${path}`;
}

function base32Decode(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.toUpperCase().replace(/=+$/, "");
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error(`invalid base32 character ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

async function setUpOwnerAndSignIn(
  page: Page,
  testInfo: TestInfo,
  book: string,
  email: string,
): Promise<void> {
  await page.goto(bookUrl(book, testInfo, "/app/setup"));
  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByLabel("Name").fill(`Owner ${book}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Create owner" }).click();

  await expect(page.getByRole("heading", { name: "Set up two-factor" })).toBeVisible();
  const secret = await page.locator("[data-secret]").getAttribute("data-secret");
  expect(secret).toBeTruthy();
  if (!secret) throw new Error("missing TOTP secret");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Enable two-factor" }).click();
  await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();
}

test("vault: set up a passphrase and recovery code, back up and verify a real book client-side", async ({
  page,
}, testInfo) => {
  const book = "violet";
  const email = `violet-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  // Give the book some real content so the backup isn't an empty shell.
  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Vault Bank");
  await page.getByLabel("Type").selectOption("BANK");
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByText("Vault Bank")).toBeVisible();

  await page.goto(bookUrl(book, testInfo, "/app/vault/setup"));
  await expect(
    page.getByRole("heading", { name: "Zero-knowledge vault" }),
  ).toBeVisible();

  const passphrase = "a passphrase only this browser ever sees";

  await page.locator("#vault-setup-passphrase").fill(passphrase);
  await page.locator("#vault-setup-button").click();
  const setupResult = page.locator("#vault-setup-result");
  await expect(setupResult).toHaveAttribute("data-vault-setup-result", "ok");
  const recoveryCode = await setupResult.getAttribute("data-recovery-code");
  expect(recoveryCode).toMatch(
    /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/,
  );

  // The server only ever sees ciphertext: the raw passphrase and recovery
  // code must never appear in a request body.
  const requestBodies: string[] = [];
  page.on("request", (request) => {
    const body = request.postData();
    if (body) requestBodies.push(body);
  });

  await page.locator("#vault-backup-passphrase").fill(passphrase);
  await page.locator("#vault-backup-button").click();
  const backupResult = page.locator("#vault-backup-result");
  await expect(backupResult).toHaveAttribute("data-vault-backup-result", "ok");
  const snapshotId = await backupResult.getAttribute("data-snapshot-id");
  expect(snapshotId).toBeTruthy();

  // Verify with the passphrase.
  await page.locator("#vault-verify-snapshot").fill(snapshotId ?? "");
  await page.locator("#vault-verify-secret-kind").selectOption("passphrase");
  await page.locator("#vault-verify-secret").fill(passphrase);
  await page.locator("#vault-verify-button").click();
  await expect(page.locator("#vault-verify-result")).toHaveAttribute(
    "data-verify-result",
    "match",
  );

  // Verify again with the recovery code instead -- either one unlocks the
  // same DEK.
  await page.locator("#vault-verify-secret-kind").selectOption("recovery");
  await page.locator("#vault-verify-secret").fill(recoveryCode ?? "");
  await page.locator("#vault-verify-button").click();
  await expect(page.locator("#vault-verify-result")).toHaveAttribute(
    "data-verify-result",
    "match",
  );

  // A wrong passphrase must not unlock the vault.
  await page.locator("#vault-verify-secret-kind").selectOption("passphrase");
  await page.locator("#vault-verify-secret").fill("the wrong passphrase entirely");
  await page.locator("#vault-verify-button").click();
  await expect(page.locator("#vault-verify-result")).toHaveAttribute(
    "data-verify-result",
    "error",
  );

  for (const body of requestBodies) {
    expect(body).not.toContain(passphrase);
    if (recoveryCode) expect(body).not.toContain(recoveryCode);
  }
});
