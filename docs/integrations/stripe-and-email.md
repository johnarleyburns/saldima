# Stripe test mode and email

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

P1 needs Stripe **test mode** for signup and transactional email for the
welcome/one-time sign-in link. Neither is used by the current auth slice.

## Stripe: step by step

### Are you in a Sandbox?

Stripe has two ways to get test data:

- **Test mode** on a normal account: the **Test mode** toggle at the top right of
  the Dashboard. Test and live data are separate.
- **Sandboxes** (the newer left-nav item): an isolated test account. If you are
  inside a sandbox, you are already in test mode; no extra toggle is needed.

Both issue keys beginning `sk_test_` / `pk_test_`. Never use `sk_live_`.

### 1. Create the product and prices (in test mode/sandbox)

Product catalog → **Add product**:

- Name: `Saldima`
- Two recurring prices: `$5.00 / month` and `$50.00 / year`

Copy each price ID (`price_...`). Test-mode prices only work with test keys.

### 2. Copy API keys

Developers → **API keys** (test mode):

- Secret key: `sk_test_...`
- Publishable key: `pk_test_...`

### 3. Redirect URLs

Do **not** use `billing.stripe.com` as the redirect. That host is Stripe's
hosted page; Checkout sends the customer back to **our** URL after payment.
No Stripe custom domain is needed.

In the Checkout Session request set:

```text
success_url = https://dev.saldima.com/app/billing/success?session_id={CHECKOUT_SESSION_ID}
cancel_url  = https://dev.saldima.com/app/billing/cancel
```

`{CHECKOUT_SESSION_ID}` is a literal Stripe placeholder (do not URL-encode the
braces). For local development use `http://localhost:8787/...`. The URLs must
be absolute; HTTPS is required outside localhost.

### 4. Webhook

Developers → **Webhooks** → **Add endpoint**:

- Endpoint: `https://dev.saldima.com/stripe/webhook`
- Events:
  - `checkout.session.completed`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `customer.subscription.deleted`

Copy the endpoint signing secret (`whsec_...`). Add a second endpoint for
`https://stage.saldima.com/stripe/webhook` when staging is cut.

### 5. Store values

Never commit them. Worker secrets per environment:

```sh
printf '%s' 'sk_test_...' | pnpm exec wrangler secret put STRIPE_SECRET_KEY --env dev
printf '%s' 'whsec_...'   | pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env dev
# repeat with --env staging for a release candidate
```

Non-secret values in that environment’s `vars` in `wrangler.jsonc`:

| Variable                 | Value         |
| ------------------------ | ------------- |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` |
| `STRIPE_PRICE_MONTHLY`   | `price_...`   |
| `STRIPE_PRICE_YEARLY`    | `price_...`   |

### 6. Local webhook forwarding

```sh
stripe login
stripe listen --forward-to localhost:8787/stripe/webhook
```

Copy the printed local `whsec_...` into `.dev.vars` as
`STRIPE_WEBHOOK_SECRET`.

### 7. Test payments

- Success: `4242 4242 4242 4242`, any future expiry, any CVC.
- 3-D Secure: `4000 0025 0000 3155`.
- Decline: `4000 0000 0000 0002`.
- Use Stripe **test clocks** for renewal, dunning and refund timing.

## Email: reuse the existing Zoho SMTP sender

Use the same outbound path as `fast-insurance-portal/website-form-worker`:
Zoho Mail SMTP over Cloudflare’s outbound TCP socket API
(`smtp.zoho.com:587`, STARTTLS + AUTH LOGIN). This keeps SPF/DKIM/DMARC valid
and avoids a new provider.

For now, authenticate as the existing mailbox `arley@arleyxu.com` and send from
that address. To send as `@saldima.com`, add the domain/mailbox in Zoho and
verify its SPF/DKIM first; do not spoof it.

### Values and secrets

Non-secret vars (dev environment):

| Variable     | Value                                                            |
| ------------ | ---------------------------------------------------------------- |
| `SMTP_HOST`  | `smtp.zoho.com`                                                  |
| `SMTP_PORT`  | `587`                                                            |
| `SMTP_USER`  | `arley@arleyxu.com`                                              |
| `FROM_EMAIL` | `arley@arleyxu.com` (must match the authenticated mailbox/alias) |
| `TO_EMAIL`   | `arley@arleyxu.com`                                              |
| `CC_EMAIL`   | `audrey@arleyxu.com`                                             |

Secret:

```sh
printf '%s' "$(tr -d ' \t\r\n' < ~/.zoho-app-password)" \
  | pnpm exec wrangler secret put SMTP_PASS --env dev
```

The existing app password in `~/.zoho-app-password` is the Zoho app password
used by the website form worker. Do not commit it.

The Saldima `EmailPort` implementation should call `connect()` and SMTP exactly
like the form worker, behind the injected port. Unit tests use `FakeEmail`;
a nightly contract test may send one message through Zoho.

## What to hand over

- Stripe test secret/publishable keys, price IDs and webhook secret (or set the
  secrets above).
- Confirmation of the From address for Saldima email; the existing Zoho app
  password is already available locally.
- No keys in chat, issues or PRs.
