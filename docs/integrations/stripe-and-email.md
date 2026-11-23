# Stripe test mode and email

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

P1 needs Stripe **test mode** for signup and a transactional email provider for
the welcome/one-time sign-in link. Neither is needed for the local auth slice;
these are the values to provide when signup starts.

## Stripe test mode

1. In the Stripe dashboard toggle **Test mode**.
2. Create one product, `Saldima`, with two recurring prices:
   - `$5 / month` → copy the price ID (`price_...`)
   - `$50 / year` → copy the price ID (`price_...`)
3. Copy the **test** secret key (`sk_test_...`) and publishable key (`pk_test_...`).
4. Add a webhook endpoint for each hosted environment:
   - `https://dev.saldima.com/stripe/webhook`
   - `https://stage.saldima.com/stripe/webhook`
     Events: `checkout.session.completed`, `invoice.paid`,
     `invoice.payment_failed`, `customer.subscription.deleted`.
     Copy each signing secret (`whsec_...`).
5. For local development use the Stripe CLI:

   ```sh
   stripe login
   stripe listen --forward-to localhost:8787/stripe/webhook
   ```

   It prints a local `whsec_...`; put it in `.dev.vars` as
   `STRIPE_WEBHOOK_SECRET`.

### Store the values

Never commit them. Worker secrets per environment:

```sh
printf '%s' 'sk_test_...' | pnpm exec wrangler secret put STRIPE_SECRET_KEY --env dev
printf '%s' 'whsec_...'   | pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env dev
# repeat with --env staging when a release candidate is prepared
```

Non-secret values go in the environment's `vars` in `wrangler.jsonc`:

| Variable                 | Value         |
| ------------------------ | ------------- |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` |
| `STRIPE_PRICE_MONTHLY`   | `price_...`   |
| `STRIPE_PRICE_YEARLY`    | `price_...`   |

Test cards: `4242 4242 4242 4242`, any future expiry, any CVC; 3-D Secure:
`4000 0025 0000 3155`. Use Stripe test clocks for renewal/refund tests.

## Email provider

Recommendation: **Resend** (HTTP API, 3,000 messages/month free, simple domain
verification, no SDK needed — we call it through the existing `FetchPort`).
Alternatives: Postmark (excellent deliverability, paid) or Amazon SES.
Cloudflare Email Routing is **inbound only**; Cloudflare Email Sending requires
the Workers Paid plan and domain onboarding.

What is needed:

1. A Resend account and API key (`re_...`).
2. A verified sending domain `saldima.com` in Resend. Add the SPF/DKIM records
   Resend shows to Cloudflare DNS; add a DMARC record
   (`v=DMARC1; p=none; rua=mailto:dmarc@saldima.com`) before launch.
3. `EMAIL_FROM=Saldima <no-reply@saldima.com>` and
   `EMAIL_REPLY_TO=support@saldima.com` (non-secret vars).
4. The API key as a Worker secret:

   ```sh
   printf '%s' 're_...' | pnpm exec wrangler secret put RESEND_API_KEY --env dev
   ```

Local tests do **not** call Resend: the `EmailPort` fake records messages. A
contract test can run nightly against Resend with a dedicated test key.

The first emails to implement are the welcome/one-time sign-in link (15-minute
expiry) and the renewal reminder. Receipts inbound via
`receipts@<book>.saldima.com` are P3+.

## What to hand over

- Stripe test secret key, publishable key, monthly/yearly price IDs and the
  webhook signing secret (or set them with the commands above).
- The email provider choice; if Resend, the API key and confirmation that
  `saldima.com` is verified.
- A decision on the From/Reply-To addresses.

Do not paste keys into a PR, issue or chat. Put them directly into Wrangler
secrets or a gitignored file the deployment script reads.
