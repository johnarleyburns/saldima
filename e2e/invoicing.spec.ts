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

async function addAccount(
  page: Page,
  testInfo: TestInfo,
  book: string,
  name: string,
  type: string,
): Promise<void> {
  await page.goto(bookUrl(book, testInfo, "/app/accounts/new"));
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Type").selectOption(type);
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

test("invoicing: add a client, create an invoice, add a line and post it", async ({
  page,
}, testInfo) => {
  const book = "erin";
  const email = `erin-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  await addAccount(page, testInfo, book, "E2E Receivable", "RECEIVABLE");
  await addAccount(page, testInfo, book, "E2E Premiums", "INCOME");

  await page.goto(bookUrl(book, testInfo, "/app/customers/new"));
  await page.getByLabel("Name").fill("Acme Holdings");
  await page.getByLabel("Email").fill("billing@acme.test");
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByText("Acme Holdings")).toBeVisible();

  await page.goto(bookUrl(book, testInfo, "/app/invoices/new"));
  await page.getByLabel("Client").selectOption({ label: "Acme Holdings" });
  await page.getByLabel("Invoice number").fill("INV-1001");
  await page.getByLabel("Date opened").fill("2026-03-01");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "INV-1001" })).toBeVisible();
  await expect(page.getByText("Acme Holdings")).toBeVisible();

  await page.getByLabel("Description").fill("Monthly premium");
  await page.getByLabel("Date", { exact: true }).fill("2026-03-01");
  await page.getByLabel("Quantity").fill("1");
  await page.getByLabel("Unit price").fill("250.00");
  await page.getByLabel("Income account").selectOption({ label: "E2E Premiums" });
  await page.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByText("Monthly premium")).toBeVisible();
  await expect(page.getByText("Total: 250.00")).toBeVisible();

  await page.getByLabel("Deposit to").selectOption({ label: "E2E Receivable" });
  await page.getByLabel("Posted date").fill("2026-03-01");
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByText("Posted 2026-03-01")).toBeVisible();

  // A posted invoice can no longer be edited or deleted.
  await expect(page.getByRole("button", { name: "Add line" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete draft" })).toHaveCount(0);

  await page.goto(bookUrl(book, testInfo, "/app/journal"));
  await expect(page.getByText("Invoice INV-1001")).toBeVisible();
});

test("bills: add a vendor, create a bill, add a line and post it", async ({
  page,
}, testInfo) => {
  const book = "hank";
  const email = `hank-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  await addAccount(page, testInfo, book, "E2E Payable", "PAYABLE");
  await addAccount(page, testInfo, book, "E2E Office Expense", "EXPENSE");

  await page.goto(bookUrl(book, testInfo, "/app/vendors/new"));
  await page.getByLabel("Name").fill("Staples Supply Co");
  await page.getByLabel("Email").fill("ap@staples-supply.test");
  await page.getByRole("button", { name: "Add vendor" }).click();
  await expect(page.getByText("Staples Supply Co")).toBeVisible();

  await page.goto(bookUrl(book, testInfo, "/app/bills/new"));
  await page.getByLabel("Vendor").selectOption({ label: "Staples Supply Co" });
  await page.getByLabel("Bill number").fill("BILL-2001");
  await page.getByLabel("Date opened").fill("2026-03-01");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "BILL-2001" })).toBeVisible();
  await expect(page.getByText("Staples Supply Co")).toBeVisible();

  await page.getByLabel("Description").fill("Printer paper");
  await page.getByLabel("Date", { exact: true }).fill("2026-03-01");
  await page.getByLabel("Quantity").fill("1");
  await page.getByLabel("Unit price").fill("60.00");
  await page
    .getByLabel("Expense account")
    .selectOption({ label: "E2E Office Expense" });
  await page.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByText("Printer paper")).toBeVisible();
  await expect(page.getByText("Total: 60.00")).toBeVisible();

  await page.getByLabel("Pay from").selectOption({ label: "E2E Payable" });
  await page.getByLabel("Posted date").fill("2026-03-01");
  await page.getByRole("button", { name: "Post bill" }).click();
  await expect(page.getByText("Posted 2026-03-01")).toBeVisible();

  // A posted bill can no longer be edited or deleted.
  await expect(page.getByRole("button", { name: "Add line" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete draft" })).toHaveCount(0);

  await page.goto(bookUrl(book, testInfo, "/app/journal"));
  await expect(page.getByText("Bill BILL-2001")).toBeVisible();
});

test("receipts: capturing a receipt posts an expense and shows the receipt image", async ({
  page,
}, testInfo) => {
  const book = "frank";
  const email = `frank-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  await addAccount(page, testInfo, book, "E2E Office Supplies", "EXPENSE");
  await addAccount(page, testInfo, book, "E2E Wallet", "CASH");

  await page.goto(bookUrl(book, testInfo, "/app/receipts/new"));
  await page.setInputFiles("#image", {
    name: "receipt.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("not actually a jpeg, just e2e test bytes"),
  });
  await page.getByLabel("Description").fill("Printer paper");
  await page.getByLabel("Date").fill("2026-03-02");
  await page.getByLabel("Amount").fill("42.00");
  await page
    .getByLabel("Expense account")
    .selectOption({ label: "E2E Office Supplies" });
  await page.getByLabel("Paid from").selectOption({ label: "E2E Wallet" });
  await page.getByRole("button", { name: "Post expense" }).click();

  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
  await expect(page.getByText("Printer paper")).toBeVisible();
  await expect(page.getByText("42.00")).toBeVisible();
  await expect(page.locator('img[alt="Receipt"]')).toHaveCount(1);

  await page.goto(bookUrl(book, testInfo, "/app/journal"));
  await expect(page.getByText("Printer paper")).toBeVisible();
});
