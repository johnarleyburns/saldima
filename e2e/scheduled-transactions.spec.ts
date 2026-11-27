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

/**
 * Recent enough that today's "due" check always picks up exactly its
 * first instance (not a backlog of months) for a monthly recurrence --
 * the next monthly occurrence is safely still in the future.
 */
function recentPastDate(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

test("scheduled transactions: auto-posts one schedule on journal open, and another needs approval", async ({
  page,
}, testInfo) => {
  const book = "yara";
  const email = `yara-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Sched Bank");
  await page.getByLabel("Type").selectOption("BANK");
  await page.getByRole("button", { name: "Add account" }).click();

  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill("Sched Income");
  await page.getByLabel("Type").selectOption("INCOME");
  await page.getByRole("button", { name: "Add account" }).click();

  // An auto-created monthly schedule, starting safely in the past so its
  // first instance is already due the moment the journal next loads.
  await page.goto(bookUrl(book, testInfo, "/app/scheduled/new"));
  await page.getByLabel("Name").fill("Auto Salary");
  await page.getByLabel("Description").fill("Monthly salary");
  await page.locator("#start").fill(recentPastDate(20));
  await page.locator("#period_type").selectOption("month");
  await page.getByLabel("Post automatically when due").check();
  await page.locator("#split-account-0").selectOption({ label: "Sched Bank" });
  await page.locator("#split-amount-0").fill("500.00");
  await page.locator("#split-account-1").selectOption({ label: "Sched Income" });
  await page.locator("#split-amount-1").fill("-500.00");
  await page.getByRole("button", { name: "Create scheduled transaction" }).click();
  await expect(
    page.getByRole("heading", { name: "Scheduled transactions" }),
  ).toBeVisible();
  await expect(page.getByText("Auto Salary")).toBeVisible();

  // A manual-approval monthly schedule, also starting in the past.
  await page.goto(bookUrl(book, testInfo, "/app/scheduled/new"));
  await page.getByLabel("Name").fill("Manual Rent");
  await page.getByLabel("Description").fill("Monthly rent");
  await page.locator("#start").fill(recentPastDate(15));
  await page.locator("#period_type").selectOption("month");
  await page.locator("#split-account-0").selectOption({ label: "Sched Income" });
  await page.locator("#split-amount-0").fill("1200.00");
  await page.locator("#split-account-1").selectOption({ label: "Sched Bank" });
  await page.locator("#split-amount-1").fill("-1200.00");
  await page.getByRole("button", { name: "Create scheduled transaction" }).click();
  await expect(page.getByText("Manual Rent")).toBeVisible();

  // Opening the journal checks for due instances: the auto-create schedule
  // posts silently, and the manual one shows up for review.
  await page.goto(bookUrl(book, testInfo, "/app/journal"));
  await expect(page.getByText("posted automatically")).toBeVisible();
  await expect(page.getByText("Monthly salary")).toBeVisible();
  const reviewCard = page
    .locator(".card")
    .filter({ hasText: "Scheduled transactions due" });
  await expect(reviewCard.getByText("Manual Rent")).toBeVisible();
  await expect(page.getByText("Monthly rent")).toHaveCount(0); // not posted yet

  await reviewCard.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Monthly rent")).toBeVisible();

  await page.goto(bookUrl(book, testInfo, "/app/scheduled"));
  await expect(page.getByText("Auto Salary")).toBeVisible();
  await expect(page.getByText("Manual Rent")).toBeVisible();

  // Editing a schedule's simple fields and disabling it.
  const autoSalaryCard = page.locator(".card").filter({ hasText: "Auto Salary" });
  await autoSalaryCard.getByRole("link", { name: "Edit" }).click();
  await page.getByLabel("Enabled").uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("heading", { name: "Scheduled transactions" }),
  ).toBeVisible();
  const disabledCard = page.locator(".card").filter({ hasText: "Auto Salary" });
  await expect(disabledCard.getByText("Disabled")).toBeVisible();

  // Deleting a schedule removes it from the list.
  const manualRentCard = page.locator(".card").filter({ hasText: "Manual Rent" });
  await manualRentCard.getByRole("link", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Delete scheduled transaction" }).click();
  await expect(page.getByText("Manual Rent")).toHaveCount(0);
});
