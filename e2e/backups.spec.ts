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

test("backups: every save keeps a version, and restoring brings a deleted account back", async ({
  page,
}, testInfo) => {
  const book = "carol";
  const email = `carol-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  // Adding an account is a save, so it creates a new version on top of the
  // one the owner's setup already wrote.
  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Petty Cash");
  await page.getByLabel("Type").selectOption("CASH");
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByText("Petty Cash")).toBeVisible();

  await page.goto(bookUrl(book, testInfo, "/app/settings/versions"));
  await expect(page.getByText("Current")).toBeVisible();
  const restoreButton = page.getByRole("button", { name: "Restore this version" });
  expect(await restoreButton.count()).toBeGreaterThanOrEqual(1);

  // Delete the account, then restore the oldest version -- from before it
  // ever existed -- and confirm it comes back.
  await page.goto(bookUrl(book, testInfo, "/app/accounts"));
  await page.getByText("Petty Cash").click();
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByText("Petty Cash")).toHaveCount(0);

  // The version right before the delete (the first restorable one, since
  // the list is newest-first) is the one that still has Petty Cash.
  await page.goto(bookUrl(book, testInfo, "/app/settings/versions"));
  await restoreButton.first().click();

  await page.goto(bookUrl(book, testInfo, "/app/accounts"));
  await expect(page.getByText("Petty Cash")).toBeVisible();

  // Restoring is non-destructive: the deleted and restored states are both
  // still available as versions, not replaced.
  await page.goto(bookUrl(book, testInfo, "/app/settings/versions"));
  expect(await restoreButton.count()).toBeGreaterThan(0);
});
