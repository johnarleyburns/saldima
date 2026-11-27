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

/** First of the current month, so a transaction posted today always falls in period 0. */
function firstOfThisMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

test("budgets: create, set a per-period amount, see the computed actual, edit, and delete", async ({
  page,
}, testInfo) => {
  const book = "zara";
  const email = `zara-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Budget Checking");
  await page.getByLabel("Type").selectOption("BANK");
  await page.getByRole("button", { name: "Add account" }).click();

  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Budget Groceries");
  await page.getByLabel("Type").selectOption("EXPENSE");
  await page.getByRole("button", { name: "Add account" }).click();

  await page.goto(bookUrl(book, testInfo, "/app/budgets/new"));
  await page.getByLabel("Name").fill("Household");
  await page.locator("#description").fill("Monthly household budget");
  await page.locator("#start").fill(firstOfThisMonth());
  await page.locator("#period_type").selectOption("month");
  await page.locator("#period_count").fill("3");
  await page.getByRole("button", { name: "Create budget" }).click();
  await expect(page.getByRole("heading", { name: "Budgets" })).toBeVisible();
  await expect(page.getByText("Household")).toBeVisible();

  await page
    .locator(".card")
    .filter({ hasText: "Household" })
    .getByRole("link", { name: "Open" })
    .click();
  await expect(page.getByRole("heading", { name: "Household" })).toBeVisible();

  const groceriesRow = page.locator("tr").filter({ hasText: "Budget Groceries" });
  await groceriesRow.locator("input").first().fill("200.00");
  await page.getByRole("button", { name: "Save amounts" }).click();
  await expect(page.getByRole("heading", { name: "Household" })).toBeVisible();
  await expect(
    page.locator("tr").filter({ hasText: "Budget Groceries" }).locator("input").first(),
  ).toHaveValue("200.00");

  // Post a transaction inside period 0 touching the budgeted account.
  await page.goto(bookUrl(book, testInfo, "/app/journal/new"));
  await page.getByLabel("Description").fill("Grocery run");
  await page.locator("#split-account-0").selectOption({ label: "Budget Groceries" });
  await page.locator("#split-amount-0").fill("45.00");
  await page.locator("#split-account-1").selectOption({ label: "Budget Checking" });
  await page.locator("#split-amount-1").fill("-45.00");
  await page.getByRole("button", { name: "Post transaction" }).click();
  await expect(page.getByText("Grocery run")).toBeVisible();

  await page.goto(bookUrl(book, testInfo, "/app/budgets"));
  await page
    .locator(".card")
    .filter({ hasText: "Household" })
    .getByRole("link", { name: "Open" })
    .click();
  const groceriesActualRow = page
    .locator("tr")
    .filter({ hasText: "Budget Groceries" })
    .locator("xpath=following-sibling::tr[1]");
  await expect(groceriesActualRow).toContainText("45.00");

  // Edit: rename and shrink the period count.
  await page.goto(bookUrl(book, testInfo, "/app/budgets"));
  await page
    .locator(".card")
    .filter({ hasText: "Household" })
    .getByRole("link", { name: "Edit" })
    .click();
  await page.getByLabel("Name").fill("Household (renamed)");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Budgets" })).toBeVisible();
  await expect(page.getByText("Household (renamed)")).toBeVisible();

  // Delete.
  await page
    .locator(".card")
    .filter({ hasText: "Household (renamed)" })
    .getByRole("link", { name: "Edit" })
    .click();
  await page.getByRole("button", { name: "Delete budget" }).click();
  await expect(page.getByText("Household (renamed)")).toHaveCount(0);
});
