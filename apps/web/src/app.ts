// SPDX-License-Identifier: AGPL-3.0-only
import { type Context, Hono } from "hono";
import { designCss } from "./design.ts";
import { sendSmtpEmail } from "./email/smtp.ts";
import type { KvNamespaceLike } from "./ports/cloudflare-kv.ts";
import type { R2BucketLike } from "./ports/cloudflare-r2.ts";
import { provisionTenant } from "./provision.ts";
import {
  createStripeCheckout,
  type SignupPlan,
  tenantHost,
  validateEmail,
  validateName,
  verifyStripeSignature,
} from "./signup.ts";
import { epochMs } from "./time/system-clock.ts";

export interface BookNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface AppBindings {
  KV: Pick<KvNamespaceLike, "get" | "put">;
  R2: R2BucketLike;
  BOOK: BookNamespaceLike;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_PRICE_MONTHLY?: string;
  STRIPE_PRICE_YEARLY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  TENANT_DOMAIN?: string;
  TENANT_SUFFIX?: string;
  APP_ORIGIN?: string;
  PROVISION_SECRET?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  FROM_EMAIL?: string;
  FETCH?: typeof fetch;
}

interface AppVariables {
  tenantId: string | null;
  host: string;
}

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

const APEX_HOSTS = new Set([
  "localhost",
  "saldima.com",
  "www.saldima.com",
  "stage.saldima.com",
  "dev.saldima.com",
  "saldima.test",
  "www.saldima.test",
]);
const LOCAL_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hostOf(request: Request): string {
  return new URL(request.url).hostname.toLowerCase();
}

async function tenantFor(host: string, kv: AppBindings["KV"]): Promise<string | null> {
  const stored = await kv.get(`host:${host}`);
  if (stored) return stored;

  if (host.endsWith(".localhost")) {
    const subdomain = host.slice(0, -".localhost".length);
    if (subdomain === "" || subdomain.includes(".")) return null;
    if (!LOCAL_SUBDOMAIN.test(subdomain)) return null;
    const tenantId = `tenant-${subdomain}`;
    await kv.put(`host:${host}`, tenantId);
    return tenantId;
  }
  return null;
}

function signupPage(error = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Start Saldima</title>
<style>${designCss}</style></head>
<body><main class="narrow">
<a class="brand" href="/">Saldima</a>
<h1>Start your book</h1>
<p class="muted">$5 a month or $50 a year. Cancel from Settings; your .gnucash file is always yours.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<div class="card">
<form method="post" action="/api/signup/checkout">
<label for="name">Book address</label>
<input id="name" name="name" required pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]" placeholder="acme"><p class="muted">Will be acme-dev.saldima.com</p>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required>
<label for="plan">Plan</label>
<select id="plan" name="plan"><option value="yearly">$50/year — 2 months free</option><option value="monthly">$5/month</option></select>
<button type="submit">Continue to secure checkout</button>
</form>
</div>
<p class="muted">Prefer no hosting? The iPhone and Android apps work entirely offline.</p>
</main></body></html>`;
}

function bookProvisioner(env: AppBindings) {
  return async (tenantId: string, email: string): Promise<{ setupToken: string }> => {
    if (!env.PROVISION_SECRET) throw new Error("provisioning is not configured");
    const stub = env.BOOK.get(env.BOOK.idFromName(tenantId));
    const response = await stub.fetch(
      new Request("https://book.internal/internal/provision", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.PROVISION_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email }),
      }),
    );
    if (!response.ok) throw new Error(`Book provisioning failed (${response.status})`);
    const body = (await response.json()) as { token?: string };
    if (!body.token) throw new Error("Book provisioning returned no setup token");
    return { setupToken: body.token };
  };
}

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const host = hostOf(c.req.raw);
    c.set("host", host);
    if (APEX_HOSTS.has(host)) {
      c.set("tenantId", null);
      await next();
      return;
    }
    const tenantId = await tenantFor(host, c.env.KV);
    if (!tenantId) {
      return c.text("No book at this address", 404);
    }
    c.set("tenantId", tenantId);
    await next();
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      tenant: c.get("tenantId"),
      host: c.get("host"),
    }),
  );

  app.get("/signup", (c) => {
    if (c.get("tenantId")) return c.text("Not found", 404);
    return c.html(signupPage(), 200);
  });

  app.post("/api/signup/check-name", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name : "";
    const error = validateName(name);
    if (error) return c.json({ available: false, error });
    const host = tenantHost(
      name,
      c.env.TENANT_DOMAIN ?? "localhost",
      c.env.TENANT_SUFFIX ?? "",
    );
    return c.json({ available: !(await c.env.KV.get(`host:${host}`)), host });
  });

  app.post("/api/signup/checkout", async (c) => {
    if (c.get("tenantId")) return c.text("Not found", 404);
    if (
      !c.env.STRIPE_SECRET_KEY ||
      !c.env.STRIPE_PRICE_MONTHLY ||
      !c.env.STRIPE_PRICE_YEARLY
    ) {
      return c.html(signupPage("Billing is not configured yet."), 503);
    }
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const plan: SignupPlan = body.plan === "monthly" ? "monthly" : "yearly";
    const nameError = validateName(name);
    if (nameError) return c.html(signupPage(nameError), 400);
    if (!validateEmail(email)) return c.html(signupPage("Enter a valid email."), 400);
    const host = tenantHost(
      name,
      c.env.TENANT_DOMAIN ?? "localhost",
      c.env.TENANT_SUFFIX ?? "",
    );
    if (await c.env.KV.get(`host:${host}`)) {
      return c.html(signupPage("That book address is already taken."), 409);
    }
    try {
      const session = await createStripeCheckout(
        c.env.FETCH ?? fetch,
        c.env.STRIPE_SECRET_KEY,
        { name, email, plan },
        c.env.APP_ORIGIN ?? new URL(c.req.url).origin,
        {
          monthly: c.env.STRIPE_PRICE_MONTHLY,
          yearly: c.env.STRIPE_PRICE_YEARLY,
        },
      );
      return c.redirect(session.url, 303);
    } catch (error) {
      console.error("stripe_checkout_failed", error);
      return c.html(signupPage("Could not start checkout. Please try again."), 502);
    }
  });

  app.get("/billing/cancel", (c) =>
    c.html(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Checkout cancelled</title></head><body><h1>Checkout cancelled</h1><p>No charge was made.</p><p><a href="/signup">Try again</a></p></body></html>`,
      200,
    ),
  );

  app.get("/billing/success", async (c) => {
    const sessionId = c.req.query("session_id") ?? "";
    const setupUrl = sessionId ? await c.env.KV.get(`checkout:${sessionId}`) : null;
    return c.html(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${setupUrl ? "" : '<meta http-equiv="refresh" content="3">'}<title>Payment received</title></head><body><h1>Payment received</h1>${setupUrl ? `<p>Your book is ready. <a href="${escapeHtml(setupUrl)}">Set up your owner account</a>.</p><p class="muted">The same link was emailed to you.</p>` : "<p>We are setting up your book. This page refreshes automatically.</p>"}</body></html>`,
      200,
    );
  });

  app.post("/stripe/webhook", async (c) => {
    if (!c.env.STRIPE_WEBHOOK_SECRET) return c.text("Webhook not configured", 503);
    const payload = await c.req.text();
    const signature = c.req.header("stripe-signature") ?? "";
    if (
      !(await verifyStripeSignature(
        payload,
        signature,
        c.env.STRIPE_WEBHOOK_SECRET,
        epochMs(),
      ))
    ) {
      return c.text("Invalid signature", 400);
    }
    let event: {
      id?: string;
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    try {
      event = JSON.parse(payload) as typeof event;
    } catch {
      return c.text("Invalid JSON", 400);
    }
    if (event.type !== "checkout.session.completed") return c.json({ received: true });
    if (!event.id || !event.data?.object) return c.text("Invalid event", 400);
    const eventKey = `stripe:event:${event.id}`;
    if (await c.env.KV.get(eventKey)) return c.json({ received: true });

    const session = event.data.object;
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.tenantName === "string" ? metadata.tenantName : "";
    const email =
      typeof session.customer_email === "string"
        ? session.customer_email
        : typeof metadata.email === "string"
          ? metadata.email
          : "";
    const plan: SignupPlan = metadata.plan === "monthly" ? "monthly" : "yearly";
    if (validateName(name) || !validateEmail(email)) {
      return c.text("Invalid checkout metadata", 400);
    }
    try {
      const result = await provisionTenant(
        {
          kv: c.env.KV,
          provisionBook: bookProvisioner(c.env),
          email:
            c.env.SMTP_HOST && c.env.SMTP_USER && c.env.SMTP_PASS
              ? {
                  send: async (message) =>
                    sendSmtpEmail(
                      {
                        host: c.env.SMTP_HOST ?? "",
                        port: Number(c.env.SMTP_PORT ?? "587"),
                        user: c.env.SMTP_USER ?? "",
                        pass: c.env.SMTP_PASS ?? "",
                        from: c.env.FROM_EMAIL ?? c.env.SMTP_USER ?? "",
                      },
                      message,
                    ),
                }
              : undefined,
          domain: c.env.TENANT_DOMAIN ?? "localhost",
          suffix: c.env.TENANT_SUFFIX ?? "",
          scheme: (c.env.APP_ORIGIN ?? "https://").startsWith("http://")
            ? "http"
            : "https",
        },
        { name, email, plan },
      );
      await c.env.KV.put(`checkout:${String(session.id ?? "")}`, result.setupUrl);
      await c.env.KV.put(eventKey, "1");
      return c.json({ received: true });
    } catch (error) {
      console.error("stripe_provision_failed", error);
      return c.text("Provisioning failed", 500);
    }
  });

  app.get("/", (c) => {
    const tenantId = c.get("tenantId");
    if (tenantId) return c.redirect("/app");
    return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Saldima — GnuCash-compatible books</title>
<style>${designCss}</style></head>
<body>
<header class="appbar"><a class="brand" href="/">Saldima</a><nav><a href="/signup">Start</a><a href="https://github.com/johnarleyburns/saldima">Source</a></nav></header>
<main>
<section class="hero">
<h1>Your GnuCash books,<br>in any browser and on your phone.</h1>
<p class="lede">Exact split values, half-up posting and real GnuCash files. Hosted for $5 a month, or fully offline in the mobile apps.</p>
<a class="cta" href="/signup">Start with Stripe</a>
<a class="cta secondary" href="https://github.com/johnarleyburns/saldima-ios">iPhone app</a>
</section>
<div class="grid">
<div class="card"><h2 style="margin-top:0">Keeps your files</h2><p class="muted">SQLite and gzip XML books open unchanged. Amounts are exact rationals, never floating point.</p></div>
<div class="card"><h2 style="margin-top:0">Familiar on purpose</h2><p class="muted">Accounts, registers, reports and help follow the GnuCash desktop layout, so there is nothing to relearn.</p></div>
<div class="card"><h2 style="margin-top:0">Mobile when you are</h2><p class="muted">The iPhone and Android apps are standalone books with an optional one-time Supporter purchase.</p></div>
</div>
</main>
<footer class="appfoot"><span>AGPL-3.0-only. Compatible with GnuCash; not affiliated with the GnuCash project.</span></footer>
</body></html>`);
  });

  const forwardToBook = async (c: Context<AppEnv>) => {
    const tenantId = c.get("tenantId");
    if (!tenantId) return c.text("No book at this address", 404);
    const stub = c.env.BOOK.get(c.env.BOOK.idFromName(tenantId));
    return stub.fetch(c.req.raw);
  };
  app.all("/app", forwardToBook);
  app.all("/app/*", forwardToBook);

  return app;
}
