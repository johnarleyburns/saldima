<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Go-to-market

Win customers through free and nearly-free channels first: GnuCash's own community, search, and AI-assistant answers. At $5/month a customer is worth about $100 over two years, so paid ads at typical click prices don't pay back; keep them to small, capped tests.

## Positioning

**"Your GnuCash books in any browser and on your phone. $5 a month. Download your file any time."**

| Segment | Pain | Why Saldima | Where they are |
| --- | --- | --- | --- |
| Existing GnuCash users | No official web or mobile version; GnuCash isn't available in any form on Apple phones or tablets | Same file, both ways; nothing to migrate | r/GnuCash, the gnucash-user mailing list, searches like "gnucash online" |
| Small businesses and sole traders | Hosted double-entry accounting with invoicing costs $24–59/month | Real accounting with invoices and A/R for $5 | Searches for cheap QuickBooks/Xero alternatives; r/smallbusiness; self-hosted communities |
| Small insurance agencies | Premium trust accounting and commission tracking in generic tools | Agency starter chart of accounts and a trust-balance check, at $5 | State agent associations, agency-owner groups, your own network |

Audience size: GnuCash shows about 8,400 downloads a week on SourceForge alone, roughly 400,000 a year. If just 0.1% of a year's downloaders subscribed, that's about 400 customers from one source.

Sources: [GnuCash FAQ (iOS)](https://lists.gnucash.org/wiki/FAQ) · [SourceForge finance listing](https://sourceforge.net/projects/gmoney) · [Akaunting pricing](https://toolradar.com/tools/akaunting/pricing) · [Manager.io Cloud](https://manager.io/cloud-edition).

## Channels, ranked

What a customer is worth sets the ceiling: about $49 net a year, call it $100 over two years, so spend no more than about $30 to win one.

| Channel | Cost | Likely cost per customer | Verdict |
| --- | --- | --- | --- |
| Community launch: r/GnuCash, gnucash-user list, Show HN, r/selfhosted, Product Hunt | Your time | \~$0 | Do first. Lead with the free, open-source self-host version; offer the hosted plan as the convenient option |
| Search content: "GnuCash online", "GnuCash on iPhone", "GnuCash web", how-to and migration guides, an insurance-agency guide | Your time | \~$0, but takes 3–9 months | The main long-term channel |
| AI assistant answers (ChatGPT, Claude, Perplexity recommending you) | Your time | \~$0 | Clear docs, comparison pages, an `llms.txt`, a public repo. The only way to show up in Claude, which carries no ads |
| ChatGPT ads | $3–5 per click, or $25–60 per 1,000 views; self-serve, no minimum | \~$150–500 at 1–2% of clicks paying | Small capped test only, on high-intent prompts |
| Google Search ads, long-tail GnuCash terms only | Average click across industries $5.42 | \~$270+ at 2% paying | Small capped test only |
| Google ads on broad "accounting software" terms | Accounting searches often $8–21 a click | Far above what a customer is worth | Don't |
| Insurance-agency associations and newsletters | Varies | Unknown | Test after your own agency becomes the case study |

**Claude:** Anthropic has committed to keeping Claude ad-free, so there's nothing to buy there; being the best-documented answer is the strategy. **ChatGPT:** ads started in February 2026 and became self-serve with cost-per-click bidding in May 2026, so a $100–200 test is cheap to run.

Sources: [Claude is a space to think](https://www.anthropic.com/news/claude-is-a-%73pace-to-think) · [New ways to buy ChatGPT ads](https://openai.com/index/new-ways-to-buy-chatgpt-ads) · [ChatGPT ads cost guide](https://stacker.com/stories/business-economy/how-much-do-chatgpt-ads-cost-2026-pricing-guide-marketers) · [Google Ads benchmarks 2026](https://wordstream.com/blog/2026-google-ads-benchmarks) · [Accounting keyword costs](https://my-cpe.com/blogs/google-ads-cost-for-accounting-firm).

## Signup funnel: what to expect

Expect roughly 1–3% of website visitors to become paying customers, more for people who arrive searching for GnuCash. Paying up front with a money-back guarantee behaves like a free trial that needs a card: fewer signups, but most of them stay.

Industry benchmarks for that model: when a credit card is required, about 2% of visitors start a trial and about 50% of those pay. Visitors who already know what they want convert much better: 5–15% of people arriving from a search for the product start a trial, against 2–5% from paid-ad landing pages.

| Scenario | Monthly visitors | Visitors who pay | New customers a month | Months to 100 | Months to 1,000 |
| --- | --- | --- | --- | --- | --- |
| Slow: community launch only | 1,000 | 1% | 10 | \~10 | Not reached without new channels |
| Base: community + search content from month 6 | 3,000 | 2% | 60 | \~2 | \~17 |
| Strong: search content + word of mouth | 8,000 | 3% | 240 | Under 1 | \~4–5 |

These are estimates before churn, to be replaced by real numbers in the first 60 days. The two numbers to watch from launch: visitors who start checkout, and refunds within 30 days.

Sources: [B2B SaaS funnel benchmarks](https://www.poweredbysearch.com/learn/b2b-saas-funnel-conversion-benchmarks/) · [SaaS website analytics benchmarks 2026](https://www.getsleek.io/blog/saas-analytics-benchmarks-2026) · [ChartMogul conversion report](https://chartmogul.com/reports/saas-conversion-report/).

## Budget and launch plan

Spend nothing on ads until the site has converted real visitors for a month; then cap paid tests at $300/month and keep only channels that win customers for under about $30–60 each.

1. **During P0–P1 (before launch):** register the domain; put up a one-page site with a waitlist; post progress in r/GnuCash and the gnucash-user list; recruit 10–20 beta testers with 6 months free in exchange for feedback.
2. **Launch week:** Show HN, r/GnuCash, gnucash-user, r/selfhosted and Product Hunt on consecutive days, each with the free self-host version front and centre. Publish "How I put my GnuCash books on my phone".
3. **Days 1–30:** publish 10 search pages (GnuCash online, on iPhone, on iPad, on Chromebook, web vs desktop, import from QuickBooks, from Wave, for small business, for insurance agencies, self-host guide). Answer every comment and email personally.
4. **Days 31–60:** run two capped tests, $150 each: ChatGPT ads on cost-per-click (prompts about GnuCash on mobile and cheap QuickBooks alternatives) and Google ads on long-tail GnuCash terms. Stop any test whose cost per paying customer passes $60.
5. **Days 61–90:** publish your agency's case study and the agency starter template; contact two or three state agent associations; add a referral offer of one free month for each paying referral.

## Domain

The domain is **`saldima.com`**: unregistered and with no matching USPTO marks when checked on 20 November 2026. Register it now, plus `saldima.app` to protect the name.

| Rule | Why |
| --- | --- |
| Exact-match .com, registered at Cloudflare Registrar | Trust, email deliverability, at-cost renewals |
| Nothing with "gnucash" in it | It's GnuCash's name; the GnuCash FAQ already warns about an app that misappropriated its name and logo |
| No "-flare" or "cash-" names in accounting | Flare Accounting already sells accounting software; finance classes are full of "Cashflow" marks |
| Avoid `.cash` | Renewals run about $35–80 a year against about $10 for a .com |

Layout once registered: marketing site at the root; tenants at `<name>.<domain>`; staging at `*.stage.<domain>`; customer domains point by CNAME to `customers.<domain>`. Run a USPTO search and get a trademark attorney's clearance before buying.

Sources: [Cloudflare Registrar](https://developers.cloudflare.com/registrar/llms-full.txt) · [.cash pricing (OVH)](https://www.ovhcloud.com/en/domains/tld/cash/) · [.cash pricing (IONOS)](https://www.ionos.com/domains/cash-domain).
