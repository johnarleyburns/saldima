// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";

test("alice and bob are isolated tenants", async ({ page }) => {
  await page.goto("http://alice.localhost:8787/");
  await expect(page.getByRole("heading", { name: "Saldima" })).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-tenant", "tenant-alice");

  await page.goto("http://bob.localhost:8787/");
  await expect(page.locator("body")).toHaveAttribute("data-tenant", "tenant-bob");
});

test("health reports the resolved tenant", async ({ request }) => {
  const response = await request.get("http://alice.localhost:8787/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    tenant: "tenant-alice",
  });
});
