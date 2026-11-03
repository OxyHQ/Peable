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
refuses arbitrary recurring billing cohort activation. The optional reviewed
local recurring path below supplies test products/prices, owner and lifecycle.
This one-time test must not grant Mention Plus or represent a subscription.
Tax shown in a UI fixture is not a provider-calculated tax quote; this runner
does not activate tax registrations or infer fiscal eligibility.

## Actual recurring test subscription

The reviewed local catalogue is `peable_local_mention_plus`: monthly USD599
minor units and annual USD5750, both inclusive. Its exact test price and portal
references live in `src/dev/stripeTestBilling.ts`. Before any binding, the CLI
reads Stripe and checks the account, mode, active price, product, amount,
currency, interval and tax behavior. It uses the existing verified-price import,
Billing customer and hosted subscription Checkout implementations. The local
billing owner is the isolated development merchant, not the production Oxy or
Mention application. No production account receives access.

The optional recurring test restricted key additionally needs:

- Prices read; Customers write (and read).
- Checkout Sessions write (and read).
- Billing Portal configurations read.
- Subscriptions read; Invoices read; Charges read for subscription invoice and
  refund/dispute lifecycle observation.

Accounts read and PaymentIntents read/write remain required for the one-time
field test. Payment methods are configured on the test account; the harness does
not enable live methods. A permission failure reports the operation stage and
points to this checklist without printing provider payloads.

The return URL must remain HTTPS loopback. The prepared local terminal page uses
an isolated self-signed certificate at
`~/.local/share/peable-stripe-test/tls/localhost.{key,crt}`. It grants no access
and makes no payment-success claim. Global TLS verification/trust is unchanged;
manual browsers may show a certificate warning. An automated browser can trust
this certificate only in its isolated test context. Run it with:

```sh
bun packages/backend/src/dev/stripeTestReturn.ts
```

Set `PEABLE_TEST_RETURN_URL=https://127.0.0.1:4311/return` and, optionally,
`PEABLE_TEST_SUBSCRIPTION_INTERVAL=month` or `year`. Then:

```sh
bun --env-file=.env.local packages/backend/src/dev/seedStripeTestSubscription.ts
```

The secure `subscription-month.json` or `subscription-year.json` artifact in the
same runtime directory contains the actual hosted session. This creates an
incomplete test subscription checkout, not a successful subscription. Use the
provider's test payment details in the hosted page to complete it.

For recurring webhook processing, set `PEABLE_TEST_ENABLE_BILLING=true` and
start/restart the local gateway after the merchant exists. Its cohort is built
from the local merchant, verified test account and fixed test portal config;
arbitrary `PEABLE_BILLING_COHORT` environment input is refused. Observations use
the existing durable provider-event/recurring machinery. The merchant must have
no external webhook target, so no production entitlement consumer is contacted.
Verify completion through signed events and the existing Billing readback, not
through the terminal return page. A real subscription has not been tested until
that traffic has happened.

After a hosted test payment, inspect the existing Billing-owned checkout and
initial invoice state with:

```sh
bun --env-file=.env.local packages/backend/src/dev/readStripeTestSubscription.ts
```

It reads the secure artifact, re-resolves the isolated owner and verifies the
provider's object graph through the production Billing readback. Output is the
sanitized domain status, not a provider payload or a hosted URL. The optional
interval variable selects the annual artifact. A returned page by itself is not
proof of completion.

Recurring observations also require the signed event API version to match the
version pinned in `services/providers/stripe/client.ts`. The CLI listener normally
uses the test account's default version; that can differ from the API requests
made by this gateway. A successful payment and a successful Billing readback do
not prove that recurring events were projected. Check the stored event version
and processed state separately. Configure supported test event delivery to the
pinned version; never rewrite stored events or relax the observation identity
guard to make a local test pass. Events arriving before verified object binding
remain pending for a supported explicit observation retry after binding.

The local runner also mounts `POST /__local/checkout-test` for the normal local
Mention Subscribe flow. This route is absent from ordinary gateway startup. It
accepts only an empty JSON object, exact loopback peer/Host and the two local
8110 origins, `X-Peable-Local-Test: 1`, and a stable 16–80 character
`Idempotency-Key`. The runner limits it to ten requests per minute. It verifies
the approved test account, key mode, isolated database and local card-only
merchant, then uses the same production `createIntent` path as the seed CLI.
The amount is fixed at 599 USD minor units: this is a one-time provider-fields
test, not a recurring subscription or an access grant. The response contains
only `{ intentId, clientSecret }`, is `no-store`, and belongs in component memory;
never put it in browser storage, query strings or application logs. Use the
separate hosted subscription harness above to test recurring billing.

Local card entry uses the dedicated non-default TEST payment method configuration
`pmc_1UXZRQAofUef123L4QGpwlFQ`. Only card is enabled there; Link enrollment and
other processor method selection are disabled in that configuration, without
changing the account default. Startup reads and verifies that configuration
before selecting the adapter's immutable policy. An allowlist by itself did not
remove Link's card-funded enrollment UI in the Payment Element; the isolated
configuration does. Stripe rejects combining a configuration with an explicit
`allowed_payment_method_types`, so the adapter enforces that exclusivity. Normal
production startup retains dynamic methods. Production selection of a specific
Peable method still needs its own reviewed dispatch/configuration wiring; this
local policy does not claim that platform-wide work is complete.
