# I08 payment coverage review — 2026-10-02

Status: incomplete, review of source and local fixtures. Parent OxyHQ/oxy#1519,
child Peable#87. Foundation Peable#88, head `7aaa270818ec26524683c7e22a0ee92642a18b06`.
SDK version 0.2.0 is declared in this foundation; publication, deployed version
and consumer adoption are separate evidence still required.

| Operation / consumer contract | Current surface | Recurring acceptance |
| --- | --- | --- |
| One-off checkout + stable retry identity | SDK `checkout.sessions.create(params, {idempotencyKey})`, backend checkoutSessions route | 115 SDK tests pass; not a subscription contract |
| Captures, cancellation, refunds | PaymentIntent/Refund resources and provider interfaces | One-off operations do not cancel/reconcile a subscription |
| Connected accounts/transfers | SDK resources `connectedAccounts.ts`, `transfers.ts` | Marketplace settlement stays separate from merchant subscriptions |
| Provider signature/dedup/reconciliation | provider ingress/eventProcessor, Stripe client and webhook integration tests | Existing intent-event coverage; no claim of invoice/renewal parity |
| Mercaria ensureCustomer | Required by `services/billing/provider.ts` | Missing recurrent contract |
| Mercaria subscription checkout | Customer, provider price, trial, correlation, stable idempotency, hosted URL | Missing recurrent contract; CheckoutSession wraps PaymentIntent |
| Mercaria portal | Customer + return URL | Missing hosted recurrent billing management |
| Mercaria retrieveSubscription | Stable provider reference, mode, mapped status/interval/price and dates | Missing recurring state contract |
| Mercaria cancelAtPeriodEnd | Explicit subscription ID, preserves paid period | Missing recurrent cancellation contract |
| Renewals, failure/SCA, retry, invoices and reconciliation | No full recurring provider interface or SDK resource | Must implement and demonstrate before cutover |

A cron plus one-off PaymentIntents cannot establish recurring parity. Oxy remains
owner of products/entitlements; Peable executes financial operations. When recurring
support is implemented, it needs durable provider/source mapping, merchant/application
and environment isolation, unique operation identities and signed/deduplicated durable
lifecycle events. Test/live must follow deployment key mode, as ADR0009 requires.
Existing subscriptions retain one financial writer and their provider reference; no
cancel/recreate migration is approved.

Mercaria's marketplace shares/ledger stay in Mercaria. Its local Peable client may
only be removed after the published SDK proves connected-account/transfer/auth/retry
parity. TNP is planned, not activated; mercaria-woocommerce remains an external
Channel API Key consumer. No purchases or fulfillment change from this review.

Release gates: approved recurring contract + source/backfill ownership; merchant-of-record
release decision from ADR0009; sandbox full lifecycle evidence (including renewal,
SCA/failure, duplicates/reordering, refunds and reconciliation); published SDK;
consumer adoption evidence; authorized migration/deploy and provider cutover.

Local `packages/sdk: bun run test`: 115 pass, zero failures, 2026-10-02. Fixtures
simulate network responses; no money or provider calls. These tests do not prove
recurring behavior, a published SDK version or production reachability.

`packages/backend: TEST_DATABASE_URL=postgres://oxy@127.0.0.1:5549/postgres DATABASE_URL=postgres://oxy@127.0.0.1:5549/postgres bun run test`: 670 pass, zero failures, 70 files, 2026-10-02. This includes actual signature verification integration fixtures and durable intent-event tests against disposable local DBs; it does not include a recurring subscription engine.
