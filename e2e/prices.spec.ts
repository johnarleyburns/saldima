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

async function clickNavLink(page: Page, name: string): Promise<void> {
  const toggle = page.locator(".nav-toggle-label");
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("navigation").getByRole("link", { name }).click();
}

test("prices: create, edit and delete a manual exchange rate", async ({
  page,
}, testInfo) => {
  const book = "piper";
  const email = `piper-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  await page.goto(bookUrl(book, testInfo, "/app/prices/new"));
  await page.getByLabel("Commodity space").fill("CURRENCY");
  await page.getByLabel("Commodity (e.g. EUR, AAPL)").fill("EUR");
  await page.getByLabel("Currency space").fill("CURRENCY");
  await page.getByLabel("Currency", { exact: true }).fill("USD");
  await page.locator("#date").fill("2026-01-15");
  await page.getByLabel("Value (how much currency per unit of commodity)").fill("1.08");
  await page.getByRole("button", { name: "Create price" }).click();

  await expect(page.getByRole("heading", { name: "Prices" })).toBeVisible();
  const row = page.locator("tr").filter({ hasText: "EUR" }).filter({ hasText: "USD" });
  await expect(row).toContainText("1.08");
  await expect(row).toContainText("2026-01-15");

  await row.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByText("EUR in USD")).toBeVisible();
  await page.getByLabel("Value").fill("1.10");
  await page.getByLabel("Type (optional)").fill("last");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { name: "Prices" })).toBeVisible();
  const updatedRow = page
    .locator("tr")
    .filter({ hasText: "EUR" })
    .filter({ hasText: "USD" });
  await expect(updatedRow).toContainText("1.10");

  await updatedRow.getByRole("link", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Delete price" }).click();
  await expect(page.getByRole("heading", { name: "Prices" })).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "EUR" })).toHaveCount(0);
  await expect(page.getByText("No prices yet.")).toBeVisible();
});

test("prices: the nav link reaches the prices list", async ({ page }, testInfo) => {
  const book = "quade";
  const email = `quade-${testInfo.project.name}@example.test`;
  await setUpOwnerAndSignIn(page, testInfo, book, email);

  await clickNavLink(page, "Prices");
  await expect(page.getByRole("heading", { name: "Prices" })).toBeVisible();
  await expect(page.getByText("No prices yet.")).toBeVisible();
});
