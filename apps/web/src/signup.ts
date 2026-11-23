// SPDX-License-Identifier: AGPL-3.0-only

export type SignupPlan = "monthly" | "yearly";

export interface SignupInput {
  readonly name: string;
  readonly email: string;
  readonly plan: SignupPlan;
}

export interface CheckoutSession {
  readonly id: string;
  readonly url: string;
}

export const RESERVED_NAMES = new Set([
  "admin",
  "api",
  "app",
  "billing",
  "blog",
  "dev",
  "docs",
  "mail",
  "stage",
  "status",
  "support",
  "www",
]);

const NAME = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateName(raw: string): string | null {
  const name = normalizeName(raw);
  if (name.length < 3 || name.length > 30) {
    return "Use 3 to 30 characters.";
  }
  if (!NAME.test(name)) {
    return "Use lowercase letters, numbers and hyphens; start and end with a letter or number.";
  }
  if (RESERVED_NAMES.has(name)) {
    return "That name is reserved.";
  }
  return null;
}

export function tenantHost(name: string, domain: string, suffix = ""): string {
  return `${normalizeName(name)}${suffix}.${domain}`;
}

export function validateEmail(email: string): boolean {
  return EMAIL.test(email.trim());
}

export function checkoutParams(
  input: SignupInput,
  origin: string,
  prices: { monthly: string; yearly: string },
): URLSearchParams {
  const price = input.plan === "yearly" ? prices.yearly : prices.monthly;
  return new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/billing/cancel`,
    customer_email: input.email,
    "metadata[tenantName]": normalizeName(input.name),
    "metadata[plan]": input.plan,
    "metadata[email]": input.email,
  });
}

export async function createStripeCheckout(
  fetchImpl: typeof fetch,
  secretKey: string,
  input: SignupInput,
  origin: string,
  prices: { monthly: string; yearly: string },
): Promise<CheckoutSession> {
  const response = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: checkoutParams(input, origin, prices),
  });
  const payload = (await response.json()) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };
  if (!response.ok || !payload.id || !payload.url) {
    throw new Error(payload.error?.message ?? `Stripe returned ${response.status}`);
  }
  return { id: payload.id, url: payload.url };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]. */
export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  nowMs: number,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isInteger(timestampNumber)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - timestampNumber) > toleranceSeconds) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${payload}`),
    ),
  );
  const expected = bytesToHex(signed);
  return signatures.some((signature) => {
    if (signature.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < expected.length; i += 1) {
      difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return difference === 0;
  });
}
