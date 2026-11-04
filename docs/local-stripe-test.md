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
- `STRIPE_ENABLED=true`, `STRIPE_SECRET_KEY_TEST`, `STRIPE_PUBLISHABLE_KEY_TEST`.
- `STRIPE_WEBHOOK_SECRET_TEST`, `STRIPE_CONNECT_WEBHOOK_SECRET_TEST` from the two
  local forwarding destinations. Do not substitute placeholder signing secrets.
- No `STRIPE_*_LIVE` variable at all: the harness refuses to start with any
  live-mode setting present (ADR 0017).
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
only public identifiers and the artifact path (`account`, `merchant`,
`payment_intent`, `reused`, `artifact`). The artifact is
`{object: "local_test_checkout", livemode: false, api_url, payment_intent}`, where
`payment_intent` is exactly what `POST /v1/payment_intents` answers the payer's
client: the PaymentIntent, its `client_secret` and its
`client_action {kind, value, publishable_key}`. It must stay outside source control and logs. The frontend may receive
only this payer capability; no application credential or provider secret.

The local runner binds only loopback and does not publish workload telemetry.
Existing merchant-authenticated API routes remain authenticated. This one-time
test must not grant Mention Plus or represent a subscription. The runner does
not activate tax registrations or infer fiscal eligibility.

Subscriptions are the billing engine's (ADR 0018) and are tested with test
clocks (`/v1/test_helpers/test_clocks`), not with this harness: the recurring
subscription path it used to carry belonged to the retired Stripe-Billing
proxy.
