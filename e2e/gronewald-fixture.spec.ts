// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, type Page, type TestInfo, test } from "@playwright/test";

const PORT = 8789;
const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "local-setup-token";
const PASSWORD = "correct horse battery staple";

test.setTimeout(120_000);

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

async function setUpOwner(
  page: Page,
  testInfo: TestInfo,
  book: string,
  email: string,
): Promise<string> {
  await page.goto(bookUrl(book, testInfo, "/app/setup"));
  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByLabel("Name").fill(`Owner ${book}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Create owner" }).click();
  await expect(page.getByRole("heading", { name: "Set up two-factor" })).toBeVisible();
  const secret = await page.locator("[data-secret]").getAttribute("data-secret");
  if (!secret) throw new Error("missing TOTP secret");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Enable two-factor" }).click();
  await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();
  return secret;
}

test("gronewald: bulk-imports a complex German SME ledger and the numbers tie out", async ({
  page,
}, testInfo) => {
  const email = `gronewald-${testInfo.project.name}@example.test`;
  await setUpOwner(page, testInfo, "gronewald", email);

  // Import into its own company so the seeded default book is untouched.
  // Creating a company activates it immediately and lands on its Accounts
  // page, so no separate "Select" step is needed here.
  await page.getByRole("navigation").getByRole("link", { name: "Books" }).click();
  await page.getByLabel("Company name").fill("Gronewald GL Demo");
  await page.getByLabel("Chart of accounts").selectOption("personal");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();

  await page.goto(bookUrl("gronewald", testInfo, "/app/import"));
  await page.getByLabel("Book file").setInputFiles({
    name: "gronewald-gl-2023-01.gnucash",
    mimeType: "application/gzip",
    buffer: readFileSync("fixtures/books/gronewald-gl-2023-01.gnucash"),
  });
  await page.getByRole("button", { name: "Import" }).click();

  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  await expect(page.getByText("Bank (Postbank)")).toBeVisible();
  await expect(page.getByText("Trade payables")).toBeVisible();
  await expect(page.getByText("Revenue, 19%")).toBeVisible();

  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { name: "Trial balance" })).toBeVisible();
  // 3,305 balanced journal entries across 22 real GnuCash accounts must still
  // balance once rolled up into a trial balance by this app's own engine.
  await expect(page.getByText("Balanced")).toBeVisible();

  await page.getByRole("link", { name: "Journal" }).click();
  await expect(
    page.getByText("Showing the most recent 200 of 3305 transactions."),
  ).toBeVisible();
});

test("journal: a simple two-leg payment posts through the UI", async ({
  page,
}, testInfo) => {
  const email = `journal2-${testInfo.project.name}@example.test`;
  await setUpOwner(page, testInfo, "journal2", email);
  await page.getByRole("link", { name: "Accounts" }).click();

  await page.getByRole("link", { name: "Journal" }).click();
  await page.getByRole("link", { name: "New transaction" }).click();
  await page.getByLabel("Description").fill("Coffee for the office");
  await page.locator("#split-account-0").selectOption({ label: "Checking" });
  await page.locator("#split-amount-0").fill("-18.50");
  await page.locator("#split-account-1").selectOption({ label: "Groceries" });
  await page.locator("#split-amount-1").fill("18.50");
  await page.getByRole("button", { name: "Post transaction" }).click();

  await expect(page.getByRole("heading", { name: "General Journal" })).toBeVisible();
  await expect(page.getByText("Coffee for the office")).toBeVisible();
});

test("journal: a three-leg expense + tax + payable entry posts, and an unbalanced one is rejected", async ({
  page,
}, testInfo) => {
  const email = `journal3-${testInfo.project.name}@example.test`;
  await setUpOwner(page, testInfo, "journal3", email);
  await page.getByRole("navigation").getByRole("link", { name: "Books" }).click();
  await page.getByLabel("Company name").fill("Multi-split demo");
  await page.getByLabel("Chart of accounts").selectOption("small-business");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();

  await page.goto(bookUrl("journal3", testInfo, "/app/journal/new"));
  await page.getByLabel("Description").fill("Supplier invoice with input tax");
  await page.locator("#split-account-0").selectOption({ label: "Supplies" });
  await page.locator("#split-amount-0").fill("100.00");
  await page.locator("#split-account-1").selectOption({ label: "Business Checking" });
  await page.locator("#split-amount-1").fill("19.00");
  await page.locator("#split-account-2").selectOption({ label: "Accounts Payable" });
  await page.locator("#split-amount-2").fill("-119.00");
  await page.getByRole("button", { name: "Post transaction" }).click();

  await expect(page.getByRole("heading", { name: "General Journal" })).toBeVisible();
  await expect(page.getByText("Supplier invoice with input tax")).toBeVisible();

  await page.goto(bookUrl("journal3", testInfo, "/app/journal/new"));
  await page.getByLabel("Description").fill("Should not post");
  await page.locator("#split-account-0").selectOption({ label: "Supplies" });
  await page.locator("#split-amount-0").fill("10.00");
  await page.locator("#split-account-1").selectOption({ label: "Accounts Payable" });
  await page.locator("#split-amount-1").fill("-5.00");
  await page.getByRole("button", { name: "Post transaction" }).click();
  await expect(page.getByText("The splits must sum to zero.")).toBeVisible();

  await page.getByRole("link", { name: "Journal" }).click();
  await expect(page.getByText("Should not post")).toHaveCount(0);
});
