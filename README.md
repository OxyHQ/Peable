# Peable

Peable is a payments platform, a personal payment app, and the tools that connect
payments to other websites and applications. Peable is the public product for
fiat and FairCoin payments: its merchant workspace, APIs, SDKs and checkout share one
payment lifecycle.

## Product direction

### Peable Platform

Businesses and platforms use Peable to accept and manage payments through
**Orbit by Peable**, the central merchant workspace, alongside APIs and services. The product covers payment requests,
payment links, hosted checkout, subscriptions, tax, connected sellers, refunds,
disputes, payment status and webhook notifications. The API foundation exists;
Orbit is a separate merchant application, not a screen inside the personal wallet.
Its unfinished workspace is deferred and excluded from this payment release.
Orbit will bring payment operations, customers, subscriptions, refunds,
disputes, settlement, reports and developer tools into one place. Developer tools
include application credentials and webhook configuration/diagnostics, with the
same authority checks as the APIs.

### Payment methods and internal providers

Buyers and merchants interact with **Peable**, regardless of the payment method.
Peable owns the public payment resources, checkout experience, payment status and
merchant notifications. Fiat payments use configured provider integrations;
FairCoin payments use the self-custodial rail. A provider is an internal processing
integration, not the platform's identity or a separate merchant-facing product.

The current implementation includes one card provider. Supporting additional fiat
providers and their payment methods is part of the architecture and roadmap, not a
claim that multiple providers, every bank method or every market are enabled today.
Available methods must come from the configured provider and merchant capabilities;
merchant preferences can restrict that set but cannot invent availability or approval.

### Peable App

People use the app to send and receive payments, pay for goods and services,
approve checkout requests and view their activity. Its current implementation is
a self-custodial FairCoin wallet with Oxy identity, public profiles, receive codes,
contacts and pockets. Signing stays with the user's device. Hosts without signing
capability provide a read-only experience and hand payment approval to a capable
device.

### SDKs and Pay with Peable

Peable integrates into both the server and the customer-facing experience:

- **Server:** create and manage payments, checkout sessions, subscriptions,
  connected sellers, refunds and other payment resources using authenticated APIs.
- **Websites and apps:** present a **Pay with Peable** button and payment window,
  let the buyer review and authorize the payment, and report its progress and result.
- **Peable App:** approve a payment when the integrating surface cannot sign locally.

The intended experience is a connected flow: the merchant creates the payment,
the website or app opens Peable's payment window, the buyer authorizes it, and the
merchant receives the verified result. Merchant credentials stay on the server.
Opening or closing a window is never proof of payment.

Today the browser SDK supplies an embeddable button, a QR payment window, app
handoff and realtime status. The separate app payment sheet supports payments to
people from Oxy apps. The unified merchant checkout composes reusable Bloom UI
with the optional `@peable.to/sdk/checkout/ui` entry and Mention as its first
consumer. Server imports remain independent of UI dependencies. Buyers use one
checkout; test or live processing is determined by the merchant's environment.
Development fixtures are separate from that buyer journey. Publication and
production acceptance must be verified for the exact release.

### First integration: Mention Plus

**Mention is the first target for the unified payment experience.** In the local
integration, opening Mention Plus and tapping **Subscribe** opens **Pay with
Peable in a Bloom detached bottom sheet**. The buyer reviews the offer and payment method,
authorizes payment, and sees the resulting status.

**Mention Plus can be purchased on its own. Oxy One also includes Mention Plus; it
is not the only way to subscribe.** Users with Plus through One must keep that
access without purchasing Plus again. Both routes rely on authoritative backend
entitlements; cancellation, failed payment and pending confirmation remain distinct.

The approved standalone catalogue prices are **USD 5.99 monthly** and **USD 57.50
annually** (20% below twelve monthly payments, rounded to cents). Catalogue prices
and purchase availability are separate: an offer can be visible while purchasing
remains disabled. Oxy One continues to be another source of Plus access.

The local unified checkout has completed actual **test-environment monthly and
annual subscriptions**, with paid invoices and signed settlement notifications.
Card fields use secure provider frames within the shared Bloom form; Continue
prepares authorization and a separate Pay action confirms it. Authentication
challenges and declined-payment retry have also been verified.

These tests do **not** grant production Plus access or establish live availability.
The backend now provides an owned embedded billing-session binding alongside
hosted checkout, preserving the same signed tax quote, subscription ownership and
invoice authority. Production activation still requires the correct merchant,
provider account, approved fiscal settings and authoritative entitlement delivery
to be configured and verified together. Closing the sheet or checkout window never grants Plus.

### FairCoin is a payment method, not an exchange product

Peable accepts FairCoin as a cryptocurrency for payments: sending, receiving and
paying for goods or services. The FairCoin rail is self-custodial; the gateway
holds watch-only public keys and cannot spend a user's funds.

**Peable, Oxy and Oxy ecosystem applications do not buy or sell FairCoin and do not
offer cryptocurrency exchange or brokerage.** Buying or selling FairCoin is outside
this product and belongs to the FairCoin organization. “Buying” in Peable means
paying a merchant for goods or services, not buying the currency.

This is an explicit product boundary motivated by legal considerations, not a
statement that regulatory review is complete. The inherited **Buy FAIR** screens,
bridge purchase client and exchange/ATM discovery have been removed from the
Peable experience. Historical local purchase records are retained without exposing
a new currency-purchase flow.

## What exists and what remains

Implementation, external testing, deployment and availability for real payments
are separate states. This table describes source capability, not production readiness.

| Area | Implemented foundation | Remaining work or verification |
|---|---|---|
| Payments | Intents, links, sessions, idempotency, FairCoin settlement, card provider integration, signed webhooks and realtime status | End-to-end acceptance on the exact release and enabled environment |
| Merchant operations | Administrative APIs; specific tax and contribution screens | Complete centralized merchant workspace and credential-management experience |
| Marketplace payments | Connected sellers, onboarding, transfers, reversals, refunds and disputes | Full provider/device acceptance; dispute attachments; bank payout tracking |
| Billing and tax | Customers, subscription checkout, portal, invoice reads, cancellation, tax calculation/reporting and native FairCoin periods | Broad self-service billing management and activation per approved offer; FairCoin renewal requires payment authorization |
| Personal app | Identity, wallet, activity, sending/receiving, profiles, QR, payment approval and pockets | Physical-device acceptance and recovery/rotation verification |
| Embedded payments | Browser button/QR/app handoff; separate person-payment sheet; reusable merchant checkout in the local Mention integration | Publish and accept the unified commercial checkout; activate standalone Plus with authoritative access |
| Financial operations | Per-payment provider settlement reads | Per-merchant ledger, fiat balances, reserves, bank payouts and reconciliation |
| In-person payments | No terminal product | Terminal and contactless payment experience |

Historical evidence includes real provider test-mode subscription checkout and
lifecycle tests, plus deployment receipts. It does not verify today's deployment
or all payment flows. See the [roadmap](docs/PEABLE-ROADMAP.md) for evidence,
limitations and delivery priorities. The [provider architecture and local test record](docs/integrations/payment-provider-boundary.md) describes the internal processing boundary.

---

<table>
<tr>
<td valign="top" width="50%">

### 🔒 The Gateway cannot spend your money

A merchant record holds a **watch only account `xpub` and nothing else**. There is no
field for a private key, a mnemonic or a seed anywhere in the schema, on either rail.

`insertMerchant` — the single writer — derives a child key from whatever is handed in as
`xpub` and refuses anything that can spend, so the non custody property is enforced on
every write rather than by convention.

Each FairCoin payment intent gets a receive address derived from that `xpub`. Funds go
straight to the merchant. A merchant that only takes cards registers with no `xpub` and
no network at all.

</td>
<td valign="top" width="50%">

### 🧾 Consistent payment resources

`payment_intents`, `payment_links` and `checkout_sessions`, with `Idempotency-Key` on
creates and HMAC signed webhooks carrying a timestamp against replay.

Test and live are isolated by the environment on the credential that authenticated the
call, not by a flag the caller sends. One Oxy app gets at most one merchant per
environment, and one deployment holds a test key and a live key side by side
([ADR 0017](docs/adr/0017-test-and-live-in-one-deployment.md)): a `production`
credential's payments go through the live key, every other environment's through the
test key, and every object carries `livemode` to say which world it belongs to.

Amounts are canonical base unit strings and never floats, on both rails.

Merchants supply no provider credentials. Peable holds the provider credentials
([ADR 0009](docs/adr/0009-peable-holds-the-provider-credentials.md)); a merchant's whole
authentication is their Oxy application credential.

</td>
</tr>
</table>

## Packages

A Bun workspace monorepo. Everything is under `packages/`.

| Path | Package | What it is |
|---|---|---|
| [`packages/backend`](packages/backend/) | `@peable.to/backend` | The Gateway. Express, Drizzle on PostgreSQL and Socket.IO on Bun |
| [`packages/sdk`](packages/sdk/) | [`@peable.to/sdk`](https://www.npmjs.com/package/@peable.to/sdk) | Server SDK plus the separate `@peable.to/sdk/checkout` browser entry |
| [`packages/checkout`](packages/checkout/) | `@peable.to/checkout` | The hosted, anonymous, payer facing checkout web app. Vite and React |
| [`packages/frontend`](packages/frontend/) | `@peable.to/frontend` | Expo app for iOS, Android, web and Electron |
| [`packages/contracts`](packages/contracts/) | `@peable.to/contracts` | Zod contribution contracts and generated OpenAPI |
| [`packages/shared-types`](packages/shared-types/) | `@peable.to/shared-types` | The wire contract shared by all of the above |
| [`packages/pay`](packages/pay/) | [`@peable.to/pay`](https://www.npmjs.com/package/@peable.to/pay) | Payment execution from an Oxy app; `@peable.to/pay/ui` separately exports the payment sheet |

`shared-types` is the reason the webhook signer cannot drift: the Gateway signs and the
SDK verifies through the same exported routine.

## Quick start

You need Bun and a PostgreSQL instance — `docker compose -f
docker-compose.postgres.yml up -d` starts one, and the backend refuses to boot
without `DATABASE_URL` pointing at it (see `packages/backend/.env.example`).

```bash
bun install                    # postinstall builds contracts, shared-types, sdk and pay
bun run dev                    # every package at once
```

Or one at a time:

```bash
bun run dev:backend            # bun --watch, listens on 3001 by default
bun run dev:frontend           # expo start --clear
```

`checkout` has no root shortcut; the SDK has `build:sdk`. Other commands use the workspace filter:

```bash
bun run --filter @peable.to/checkout dev
bun run --filter @peable.to/sdk dev
```

<details>
<summary><b>Every script</b></summary>

<br>

**Root**: `dev`, `dev:frontend`, `dev:backend`, `build`, `build:shared-types`,
`build:frontend`, `build:backend`, `test`, `lint`, `lint:fix`, `format`, `clean`,
`start:frontend`, `start:backend`. `lint` is Biome (`biome check .`) over the whole
repo plus the frontend's minimal Expo ESLint; `format` / `lint:fix` write Biome's fixes.

| Package | Scripts |
|---|---|
| `@peable.to/backend` | `dev`, `start`, `build`, `typecheck`, `test`, `clean` |
| `@peable.to/sdk` | `build` (cjs, esm and types), `dev`, `typecheck`, `test`, `clean` |
| `@peable.to/checkout` | `dev`, `build`, `preview`, `typecheck`, `test` |
| `@peable.to/frontend` | `dev`, `start`, `android`, `ios`, `web`, `electron`, `build`, `electron:build`, `typecheck`, `lint`, `test` |
| `@peable.to/shared-types` | same build trio as the SDK, plus `dev`, `typecheck`, `test`, `clean` |

</details>

## Integrating

Install the SDK, not this repo.

```bash
bun add @peable.to/sdk
```

```ts
import { Peable } from '@peable.to/sdk';

const peable = new Peable({
  publicKey: process.env.OXY_APP_PUBLIC_KEY,
  secret: process.env.OXY_APP_SECRET,
});

const intent = await peable.paymentIntents.create(
  { amount: '2500', network: 'mainnet' },
  { idempotencyKey: crypto.randomUUID() },
);
```

Hand `intent.clientSecret` to the browser and mount the payer side widget from
`@peable.to/sdk/checkout`. Full walkthrough in
[`docs/integrating-peable.md`](docs/integrating-peable.md).

## Authentication

There is no bespoke Peable API key. The SDK is configured with the **same
`ApplicationCredential`** Oxy Console already issues, presents it to the Oxy API to mint a
short lived service token, and re mints when that token expires.

The backend verifies callers with `@oxy.so/core/server`, using `createOxyAuthMiddleware`
and `getRequiredOxyUserId` for human callers, `oxy.middleware.service()` for merchant service tokens,
and `oxy.middleware.socket()` for Socket.IO. There is no app local bearer parser.

The payer side is different by design: a payer is anonymous and proves nothing except
possession of a payment intent's `clientSecret`, which travels in a request header rather
than a query string so it stays out of access logs.

See [`OxyHQ/oxy`](https://github.com/OxyHQ/oxy) for the identity platform behind all of
this.

## Gateway surface

| Route group | File |
|---|---|
| Payment intents | [`paymentIntents.ts`](packages/backend/src/routes/paymentIntents.ts) |
| Payment links | [`paymentLinks.ts`](packages/backend/src/routes/paymentLinks.ts) |
| Checkout sessions | [`checkoutSessions.ts`](packages/backend/src/routes/checkoutSessions.ts) |
| Merchants | [`merchants.ts`](packages/backend/src/routes/merchants.ts) |
| Webhook deliveries | [`webhookDeliveries.ts`](packages/backend/src/routes/webhookDeliveries.ts) |
| Dashboard | [`dashboard.ts`](packages/backend/src/routes/dashboard.ts) |
| Social send and receive | [`social.ts`](packages/backend/src/routes/social.ts) |
| Enrichment | [`enrich.ts`](packages/backend/src/routes/enrich.ts) |

Realtime intent updates go out over Socket.IO, which is what lets a checkout page move
from `confirming` to `settled` without polling.

## Documentation

- [Integrating Peable](docs/integrating-peable.md), the guide for merchants
- [Roadmap](docs/PEABLE-ROADMAP.md)

## Related

| Repo | What it is |
|---|---|
| [`OxyHQ/oxy`](https://github.com/OxyHQ/oxy) | The Oxy platform: identity, signed records, API and SDK |
| [`OxyHQ/PeableSDK`](https://github.com/OxyHQ/PeableSDK) | Landing page for `@peable.to/sdk`. The source is here, in `packages/sdk` |
