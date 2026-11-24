// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";

test("alice and bob are isolated tenants", async ({ page }) => {
  await page.goto("http://alice.localhost:8789/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const aliceBook = (await page.locator("main p").first().textContent()) ?? "";
  expect(aliceBook).toMatch(/^Book /);

  await page.goto("http://bob.localhost:8789/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const bobBook = (await page.locator("main p").first().textContent()) ?? "";
  expect(bobBook).toMatch(/^Book /);
  expect(bobBook).not.toBe(aliceBook);
});

test("health reports the resolved tenant", async ({ request }) => {
  const response = await request.get("http://alice.localhost:8789/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    tenant: "tenant-alice",
  });
});
