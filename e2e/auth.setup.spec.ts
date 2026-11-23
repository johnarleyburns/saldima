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

async function fillSetup(
  page: Page,
  testInfo: TestInfo,
  book: string,
  email: string,
  token = SETUP_TOKEN,
  template?: string,
): Promise<void> {
  await page.goto(bookUrl(book, testInfo, "/app/setup"));
  await page.getByLabel("Setup token").fill(token);
  if (template) await page.getByLabel("Chart of accounts").selectOption(template);
  await page.getByLabel("Name").fill(`Owner ${book}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Create owner" }).click();
}

async function enrollTotp(page: Page): Promise<string> {
  await expect(page.getByRole("heading", { name: "Set up two-factor" })).toBeVisible();
  await expect(page.locator("[data-qr] svg")).toBeVisible();
  const secret = await page.locator("[data-secret]").getAttribute("data-secret");
  expect(secret).toBeTruthy();
  if (!secret) throw new Error("missing TOTP secret");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Enable two-factor" }).click();
  await expect(page.getByText("Signed in as")).toBeVisible();
  return secret;
}

async function login(
  page: Page,
  testInfo: TestInfo,
  book: string,
  email: string,
): Promise<void> {
  await page.goto(bookUrl(book, testInfo, "/app/login"));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Two-factor code" })).toBeVisible();
}

test("alice: wrong setup token is refused, then owner setup, TOTP, sign-out and sign-in work", async ({
  page,
}, testInfo) => {
  const email = `alice-${testInfo.project.name}@example.test`;

  await fillSetup(page, testInfo, "alice", email, "wrong-token");
  await expect(page.getByText(/setup token is incorrect/i)).toBeVisible();

  await fillSetup(page, testInfo, "alice", email, SETUP_TOKEN, "insurance-agency");
  await expect(page.getByRole("heading", { name: "Set up two-factor" })).toBeVisible();
  await expect(page.locator("[data-qr] svg")).toBeVisible();
  const secret = await page.locator("[data-secret]").getAttribute("data-secret");
  expect(secret).toBeTruthy();
  if (!secret) throw new Error("missing TOTP secret");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Enable two-factor" }).click();
  await expect(page.getByText(email)).toBeVisible();

  await page.getByRole("link", { name: /Chart of accounts/ }).click();
  await expect(page.getByText("Premium Trust")).toBeVisible();
  await page.getByRole("link", { name: "Add account" }).click();
  await page.getByLabel("Name").fill("Petty Cash");
  await page.getByLabel("Type").selectOption("BANK");
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByText("Petty Cash")).toBeVisible();

  await page.getByRole("link", { name: "Back" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await login(page, testInfo, "alice", email);
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(email)).toBeVisible();

  // The session is host-only: bob's book must still ask for a login.
  await page.goto(bookUrl("bob", testInfo, "/app"));
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("bob: a separate owner can set up and reach his own book", async ({
  page,
}, testInfo) => {
  const email = `bob-${testInfo.project.name}@example.test`;
  await fillSetup(page, testInfo, "bob", email);
  await enrollTotp(page);
  await expect(page.getByText(email)).toBeVisible();
  await expect(
    page.getByText(new RegExp(`alice-${testInfo.project.name}@example`)),
  ).toHaveCount(0);
});
