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

test("print check: a bank-account transaction gets a Print check link that renders payee/date/amount/words", async ({
  page,
}, testInfo) => {
  const book = "remy";
  const email = `remy-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Checking");
  await page.getByLabel("Type").selectOption("BANK");
  await page.getByRole("button", { name: "Add account" }).click();

  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Rent Expense");
  await page.getByLabel("Type").selectOption("EXPENSE");
  await page.getByRole("button", { name: "Add account" }).click();

  await page.goto(bookUrl(book, testInfo, "/app/journal/new"));
  await page.getByLabel("Description").fill("Landlord LLC");
  await page.locator("#split-account-0").selectOption({ label: "Rent Expense" });
  await page.locator("#split-amount-0").fill("1200.00");
  await page.locator("#split-account-1").selectOption({ label: "Checking" });
  await page.locator("#split-amount-1").fill("-1200.00");
  await page.getByRole("button", { name: "Post transaction" }).click();
  await expect(page.getByText("Landlord LLC")).toBeVisible();

  await page
    .locator(".card")
    .filter({ hasText: "Landlord LLC" })
    .getByRole("link", { name: "Print check" })
    .click();
  await expect(page.getByText("Landlord LLC")).toBeVisible();
  await expect(page.getByText("1200.00")).toBeVisible();
  await expect(
    page.getByText(/One thousand two hundred dollars and 00\/100/),
  ).toBeVisible();
});

test("print check: a deposit (money coming in) has nothing to print", async ({
  page,
}, testInfo) => {
  const book = "sage";
  const email = `sage-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Checking");
  await page.getByLabel("Type").selectOption("BANK");
  await page.getByRole("button", { name: "Add account" }).click();

  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Salary");
  await page.getByLabel("Type").selectOption("INCOME");
  await page.getByRole("button", { name: "Add account" }).click();

  await page.goto(bookUrl(book, testInfo, "/app/journal/new"));
  await page.getByLabel("Description").fill("Paycheck");
  await page.locator("#split-account-0").selectOption({ label: "Checking" });
  await page.locator("#split-amount-0").fill("2500.00");
  await page.locator("#split-account-1").selectOption({ label: "Salary" });
  await page.locator("#split-amount-1").fill("-2500.00");
  await page.getByRole("button", { name: "Post transaction" }).click();
  await expect(page.getByText("Paycheck")).toBeVisible();

  await page
    .locator(".card")
    .filter({ hasText: "Paycheck" })
    .getByRole("link", { name: "Print check" })
    .click();
  await expect(page.getByText("doesn't lose money in this transaction")).toBeVisible();
});
