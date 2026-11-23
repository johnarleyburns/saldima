// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  checkoutParams,
  createStripeCheckout,
  tenantHost,
  validateEmail,
  validateName,
  verifyStripeSignature,
} from "./signup.ts";

const input = {
  name: "acme",
  email: "owner@example.test",
  plan: "yearly" as const,
};

describe("signup names", () => {
  it("accepts normal subdomains", () => {
    expect(validateName("acme")).toBeNull();
    expect(validateName("acme-books")).toBeNull();
    expect(tenantHost("Acme", "saldima.com", "-dev")).toBe("acme-dev.saldima.com");
    expect(validateEmail("owner@example.test")).toBe(true);
  });

  it("rejects reserved, malformed and short names", () => {
    for (const name of ["admin", "a", "-acme", "acme-", "ac me", "x".repeat(31)]) {
      expect(validateName(name), name).not.toBeNull();
    }
    expect(validateEmail("nope")).toBe(false);
  });
});

describe("Stripe checkout", () => {
  it("builds the exact Checkout parameters", () => {
    const params = checkoutParams(input, "https://dev.saldima.com", {
      monthly: "price_month",
      yearly: "price_year",
    });
    expect(params.get("mode")).toBe("subscription");
    expect(params.get("line_items[0][price]")).toBe("price_year");
    expect(params.get("success_url")).toBe(
      "https://dev.saldima.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
    );
    expect(params.get("cancel_url")).toBe("https://dev.saldima.com/billing/cancel");
    expect(params.get("metadata[tenantName]")).toBe("acme");
  });

  it("returns the hosted Checkout URL", async () => {
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      expect(String(init.body)).toContain("line_items%5B0%5D%5Bprice%5D=price_year");
      return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.test/1" });
    }) as typeof fetch;
    await expect(
      createStripeCheckout(fakeFetch, "sk_test", input, "https://dev.saldima.com", {
        monthly: "price_month",
        yearly: "price_year",
      }),
    ).resolves.toEqual({
      id: "cs_test_1",
      url: "https://checkout.stripe.test/1",
    });
  });

  it("surfaces a Stripe error", async () => {
    const fakeFetch = (async () =>
      Response.json(
        { error: { message: "bad key" } },
        { status: 401 },
      )) as typeof fetch;
    await expect(
      createStripeCheckout(fakeFetch, "sk_test", input, "https://dev.saldima.com", {
        monthly: "m",
        yearly: "y",
      }),
    ).rejects.toThrow("bad key");
  });
});

describe("Stripe webhook signatures", () => {
  const secret = "whsec_test_secret";

  async function sign(payload: string, timestamp: number): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${timestamp}.${payload}`),
      ),
    );
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    return `t=${timestamp},v1=${hex}`;
  }

  it("accepts a valid signature and rejects tampering/age", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const now = 1_800_000_000_000;
    await expect(
      verifyStripeSignature(payload, await sign(payload, 1_800_000_000), secret, now),
    ).resolves.toBe(true);
    await expect(
      verifyStripeSignature(
        `${payload} `,
        await sign(payload, 1_800_000_000),
        secret,
        now,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyStripeSignature(payload, await sign(payload, 1_799_999_000), secret, now),
    ).resolves.toBe(false);
  });
});
