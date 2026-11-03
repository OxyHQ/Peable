# Local Stripe test checkout

This harness runs the existing Peable gateway, repositories, provider adapter,
anonymous payer endpoints and signed webhook handler. It does not implement a
second payment server or bypass merchant authentication over HTTP. Merchant and
intent creation happen through an explicit local administrative command.

It is intentionally restricted to a PostgreSQL database named
`peable_stripe_test` on `127.0.0.1:5439`, a test secret/restricted key and test
publishable key, and the explicitly approved Stripe account. A stable
`PEABLE_TEST_RUN_ID` makes retries reuse the same intent. A new run id is a new
test payment. No production database, live key or production NODE_ENV is accepted.

Store runtime values only in ignored `.env.local` with mode0600. Required names:

- `DATABASE_URL`, `PORT=4310`, `PEABLE_ALLOWED_ORIGINS` for the local frontend.
- `STRIPE_ENABLED=true`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`.
- `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` from the two local
  forwarding destinations. Do not substitute placeholder signing secrets.
- `PEABLE_TEST_STRIPE_ACCOUNT`, verified against the credential's own account;
  `PEABLE_TEST_RUN_ID`, a stable short identifier for this attempt.

The test restricted key needs account read and PaymentIntent create/read access.
Keep all provider secrets server-side. The provider's test account must match
its publishable key and webhook forwarding account; the deployed account is
not a substitute.

Install dependencies and apply the existing genesis migrations to the empty
local database using the supported migration command. From the repository root:

```sh
bun install --frozen-lockfile
bun --env-file=.env.local run --cwd packages/backend db:migrate -- --target-database=peable_stripe_test --phase=all
bun --env-file=.env.local packages/backend/src/dev/startStripeTest.ts
```

Forward signed platform events to
`http://127.0.0.1:4310/v1/webhooks/stripe` and Connect events to
`http://127.0.0.1:4310/v1/webhooks/stripe/connect`. The server verifies signatures
before its durable event processing. A successful frontend confirmation alone
is not settlement or a subscription entitlement.

In another terminal, explicitly prepare a one-time USD5.99 test payment:

```sh
bun --env-file=.env.local packages/backend/src/dev/seedStripeTestCheckout.ts
```

The seed registers a card-only development merchant (no fabricated FairCoin
key) and calls the real `createIntent` service. It writes a mode0600 payer
artifact to `~/.local/share/peable-stripe-test/checkout.json`; stdout contains
only public identifiers and the artifact path. The artifact contains
`apiUrl`, a publishable key, the Peable intent/client secret and provider client
action. It must stay outside source control and logs. The frontend may receive
only this payer capability; no application credential or provider secret.

The local runner binds only loopback and does not publish workload telemetry.
Existing merchant-authenticated API routes remain authenticated. The harness
refuses recurring billing cohort activation: a real subscription requires its
own reviewed test product/prices, billing owner/cohort and webhook lifecycle.
This one-time test must not grant Mention Plus or represent a subscription.
Tax shown in a UI fixture is not a provider-calculated tax quote; this runner
does not activate tax registrations or infer fiscal eligibility.
