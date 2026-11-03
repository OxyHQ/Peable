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

The local runner mounts `POST /__local/checkout-test` for normal local Mention
Subscribe. This route is absent from ordinary gateway startup. It accepts only
`{ "interval": "month" }` or `{ "interval": "year" }`, the exact loopback
peer/Host and the two local 8110 origins, `X-Peable-Local-Test: 1`, and a stable
16–80 character `Idempotency-Key`. It permits ten requests per minute. Server
catalogue prices are fixed at 599 or 5750 USD minor units; callers cannot choose
an amount, customer, price or merchant. Changing cadence with the same operation
key is rejected rather than creating a second purchase.

This route creates a real TEST `default_incomplete` subscription and links its
**existing first-invoice PaymentIntent** through ordinary Peable `createIntent`.
It does not create another one-time charge. A guarded local adapter installed
once at runner startup owns this bridge; production startup is unchanged. The
isolated customer is bound to the durable intent, provider creation uses stable
idempotency, and retries also check that customer's unique subscription. Price,
customer, subscription, initial invoice and payment identities, account mode,
amount and currency are verified before exposing any payer action. Signed
provider events still drive the existing intent transitions/outbox.

The no-store response is the subscription snapshot (see **Wire** below) plus the
payer `client_secret`: `object: "local_test_subscription"`, `livemode: false`, the
Peable `payment_intent`, the provider `subscription`, `interval`, `amount`,
`currency` and the actual provider period (`current_period_start` /
`current_period_end`). Keep capabilities in component memory,
never browser storage, URL fragments, query strings or logs. Ordinary anonymous
payer client-action APIs return the first-invoice confirmation capability.
`GET /__local/checkout-test/:paymentIntent/subscription` requires the same local
origin/Host and `X-Peable-Client-Secret`. Its `ready` flag requires the signed
Peable settlement, active subscription, and the existing strict Billing paid
invoice proof, including actual charge, amount and refund reconciliation. No
production entitlement grant is configured. The optional tax breakdown uses the
provider invoice total excluding tax and its recorded tax entries, reconciled to
the exact total and inclusive treatment. Missing or conflicting values omit the
breakdown; recorded zero remains zero. Fixture tax never enters this checkout.

Invoice-owned payments cannot be directly canceled. The local adapter verifies
the entire binding and voids only an unpaid initial invoice of an incomplete
subscription. If payment wins that race, it rereads provider truth; it never
cancels an active subscription. The ordinary reject/expiry service consumes the
result. The separate CLI one-time harness remains available for isolated provider
field checks; the normal Plus route does not use it.

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

For this isolated account, set
`PEABLE_TEST_STRIPE_API_VERSION=2026-09-30.endive` to match its signed CLI snapshot
events. Only that reviewed alternate version is accepted, and only under the
complete local test boundary. Without it, the production pin remains
`2026-07-29.dahlia`. SDK requests, Billing bindings, recurring readers and event
validation use one active version; mismatched events still fail closed. The
installed SDK's default-version type requires one explicit typing boundary for
this reviewed alternate release; both runtime schemas and real account readbacks
are verified. This does not change the account default or rewrite stored events.

The local cohort sets `observationTimeoutMs: 10000`, within the existing hard
upper bound. The original 2000ms default remains unchanged for other cohorts;
the real owned invoice proof needed2242ms for its multiple provider reads. With
the reviewed version and bound, the already-stored signed monthly subscription
and invoice events produced active/paid snapshots locally. No external webhook
target or production entitlement consumer is configured.

The subscription snapshot also carries offer-specific `payment_methods` entries
(`{type, available, unavailable_reason}`) for card, bank, installments and
FairCoin. Only a method actually supported by
this offer/adapter is available. The card-entry processor configuration must not
hide the other Peable choices in the application. This local merchant has no
watch-only receive key or network, so FairCoin's `unavailable_reason` is
`merchant_receive_key_missing`; bank reports
`subscription_method_not_configured`, and installments reports
`installment_offer_not_configured`. These are facts about this isolated offer,
not claims that Peable lacks those product capabilities.

The native FairCoin Billing rail requires a matching merchant cohort, the
merchant's own watch-only xpub/network, approved configured offers, a fiscal quote
authority, a signing-key reference for invoice authority, and a fresh quote from
the configured Explorer USD price source. Its renewals are payer-initiated.
Never invent a receiving key, balance, payable QR/address or FX quote to make an
unconfigured method look active.

Bootstrap avoids repeating its verified subscription proof within the same
request. The scope requires the exact intent, merchant and provider-payment
identity, and is discarded after that operation. Capability-authenticated reads,
subsequent requests and settled-payment observations always obtain fresh proof;
a cached opening snapshot can never establish paid readiness. The validated
Billing service is reused only for the identical immutable runtime configuration.
A configuration change requires restarting the runner.

On the local test account, measured fresh bootstrap latency fell from 7.8 seconds
to 5.7 seconds cold / 5.1 seconds warm after removing duplicate proof reads.
These are observations, not an SLA: provider creation and ownership verification
still require network round trips. No subscription is created on page view.

`GET /__local/checkout-test/config` is a read-only preparation endpoint with the
same loopback Host, allowed Origin and `X-Peable-Local-Test: 1` boundary. It
returns `object: "local_checkout_configuration"`: the test `publishable_key`, the
public `merchant` and `product`, the validated monthly/annual `prices`, the
`payment_methods` capabilities and `expires_at` sixty seconds out.
It creates no customer, subscription or payment. Account, method configuration
and both prices are read in parallel; concurrent page warmups share the public
configuration for at most 60 seconds. Credential/configuration changes refuse
cached preparation and require restarting the local runner.

A host may warm this public configuration on its checkout page and mount secure
card fields before subscription creation finishes. It must match the eventual
intent's merchant, price, currency and provider action's publishable key before
confirmation. Preparation supplies no tax quote, payment capability or proof of
payment; the real binding and signed paid-readiness checks remain mandatory.
Measured local preparation was 459ms cold and below 1ms warm, with only four
provider GETs cold and no provider writes.

## Wire

The harness speaks the Orbit wire (ADR 0014), the same as `/v1`: snake_case
fields, `object` and `livemode` on every object, amounts as base-unit strings
beside an uppercase `currency`, instants as integer Unix seconds, `null` for what
is not known, and every refusal in the standard envelope
`{error: {type, code, param?, message, request_id}}`. There are no aliases for
the older camelCase fields.

`GET /__local/checkout-test/config` → `local_checkout_configuration`:

| Field | Type |
|---|---|
| `object` | `"local_checkout_configuration"` |
| `livemode` | `false` |
| `publishable_key` | `pk_test_…` |
| `merchant` | the local merchant's `merch_…` |
| `product` | `"peable_local_mention_plus"` |
| `currency` | `"USD"` |
| `prices.month` / `prices.year` | `{unit_amount: "599" \| "5750", interval}` |
| `payment_methods[]` | `{type: card\|bank\|installments\|faircoin, available, unavailable_reason: string \| null}` |
| `expires_at` | Unix seconds |

`POST /__local/checkout-test` (body `{"interval": "month" | "year"}`, nothing
else) and `GET /__local/checkout-test/:paymentIntent/subscription` →
`local_test_subscription` (the POST adds `client_secret`):

| Field | Type |
|---|---|
| `object` | `"local_test_subscription"` |
| `livemode` | `false` |
| `payment_intent` | Peable `pi_…` |
| `subscription` | provider subscription id |
| `interval` | `month` \| `year` |
| `amount` | base-unit string (`"599"`) |
| `currency` | `"USD"` |
| `subscription_status`, `invoice_status`, `payment_status` | provider / Peable status, `invoice_status` nullable |
| `ready` | boolean, see above |
| `tax` | `{amount_subtotal, amount_tax, amount_total, inclusive}` (strings) or `null` |
| `payment_methods[]` | as above |
| `current_period_start`, `current_period_end` | Unix seconds or `null` |

Refusals:

| Status | `type` | `code` | When |
|---|---|---|---|
| 403 | `permission_error` | `local_test_request_required` | wrong peer, Host, Origin, opt-in header, content type or missing capability |
| 400 | `invalid_request_error` | `parameter_invalid` (`param: Idempotency-Key`) | missing or malformed `Idempotency-Key` |
| 400 | `invalid_request_error` | `parameter_invalid` (`param` names the field) | any body but `{interval}` |
| 429 | `rate_limit_error` | `rate_limited` | more than ten creates a minute (`Retry-After: 60`) |
| 503 | `api_error` | `local_test_configuration_unavailable` / `local_test_unavailable` / `local_test_subscription_unavailable` | the boundary re-check or the provider read failed; nothing is echoed |

The CLI artifacts follow the same rules. `subscription-<interval>.json` is
`{object: "local_test_subscription_checkout", livemode: false, account, owner:
{merchant_id, oxy_app_id, environment}, interval, amount, currency, session}`, and
`readStripeTestSubscription.ts` prints `{checkout, status, subscription,
subscription_status, invoice}`.
