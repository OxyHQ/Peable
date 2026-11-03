# Peable roadmap

> Initial review: 2026-11-02 at `0eeb676`; implementation follow-up through
> Peable `59cdd78` and the Mention payment-window work on 2026-11-03.
> This is a source and recorded-evidence review, not a production certification.

## Product and boundaries

Peable has three connected surfaces: the business payments platform (Orbit by Peable,
APIs and services), the personal payment app, and SDKs that bring payment
management and the **Pay with Peable** experience into other websites and apps.
The [README](../README.md) defines their purpose and relationship. Peable is the
public platform for fiat and FairCoin payments; processing providers are internal
integrations. One card provider is implemented today. Additional providers are a
planned extension, with method availability constrained by real provider and
merchant capabilities. See the [provider boundary](integrations/payment-provider-boundary.md).

FairCoin is a payment rail for sending, receiving and paying for goods or services.
Peable, Oxy and Oxy ecosystem applications do not buy or sell FairCoin or offer
exchange/brokerage services. Currency sales and purchases belong outside this
product, to the FairCoin organization. This product boundary is motivated by legal
considerations; it does not replace legal review.

The inherited Buy FAIR routes, purchase bridge client and exchange/ATM discovery
have been removed from Peable. Existing local purchase records are preserved;
they do not expose a new purchase flow. Do not reintroduce currency sales as a
Peable capability or a future Oxy service.

Oxy owns identity, applications and credentials. FairCoin signing remains on the
payer's capable device; merchants and sellers supply watch-only public keys.

## How readiness is recorded

| State | Required evidence |
|---|---|
| Implemented | Source exists; record relevant checks separately |
| Externally tested | A dated end-to-end test against a real provider or chain, with its scope |
| Deployed | Exact running artifact and applied migration ledger verified |
| Live | Flow enabled for real payments with applicable commercial and legal decisions resolved |

These states do not imply each other. An API, a passing test or an old deployment
receipt cannot establish that today's user journey works in production.

## Current capability map

| Surface | Present in source | Remaining capability or acceptance |
|---|---|---|
| Payments | Intents, links, hosted checkout, idempotency, signed/retrying webhooks and realtime updates | Current release end-to-end acceptance |
| FairCoin | Watch-only address reservation, Explorer settlement, seller-owned connected accounts | Funded chain canary, device verification, seller recovery and gap-limit checks |
| Cards | Creation, confirmation, cancellation, expiry and reconciliation through the implemented provider | Full payment and marketplace lifecycle acceptance; current live enablement unverified |
| Marketplace | Seller onboarding, transfers/reversals, refunds, disputes and text evidence | Dispute attachments; dispute fee/funds movements; payout tracking |
| Financial reporting | Provider gross/fee/net reads with explicit unknown values | Per-merchant journal, fiat balances, reserves, negative balances and bank reconciliation |
| Orbit by Peable | Standalone `packages/orbit` organization/app/environment workspace over authenticated merchant/payment/webhook reads; existing tax/contribution links | Customer/subscription/refund/dispute views, credential UI, financial reports, and authenticated end-to-end acceptance |
| Billing | Customers, subscription checkout/portal, subscription and invoice reads, cancellation, operation recovery | General self-service catalogue and subscription administration beyond configured offers |
| FairCoin billing | Quoted subscription periods and explicit renewals using payment intents | External funded settlement acceptance; no claim of automatic wallet debit |
| Tax | Location evidence, calculations, owner-approved registrations, reports, renewal repricing and refund reversals | Provider/environment acceptance for enabled offers and jurisdictions |
| Personal app | Identity, self-custodial wallet, activity, social send/receive, profiles, QR, pockets and checkout approval | Physical-device/recovery acceptance |
| Browser integration | `@peable.to/sdk/checkout`: button, QR window, mobile app handoff and status events | Unified commercial payment-window experience |
| App integration | `@peable.to/pay` execution and separate `@peable.to/pay/ui` payment-to-person sheet | Commercial checkout integration; do not equate a person-payment sheet with a subscription checkout |
| In-person payments | No terminal implementation | Terminal/contactless product |

The SDK's server entry covers payments, merchants, connected accounts, refunds,
transfers, disputes, billing and tax. Its browser entry carries the scoped payer
client, not merchant credentials. The UI payment sheet remains a separate entry
with optional UI peers and must never enter the root payment barrel.

## Evidence and known verification limits

The older September roadmap claimed subscriptions did not exist and no real
provider sandbox testing had occurred. Later source and evidence supersede those
claims:

- [October 3 hosted subscription checkout](audits/2026-10-03-i08-billing-provider/checkout-sandbox/README.md): real provider test-mode checkout, customer reuse, lost-response recovery and period-end cancellation request. Oxy authentication was synthetic.
- [October 3 lifecycle tests](audits/2026-10-03-i08-billing-provider/test-clock/README.md): trial, paid renewal, refund/idempotency, cancellation, failed renewal and unresolved authentication challenge. These fixtures do not prove production adoption or the entire marketplace rail.
- [Historical release and deployment receipts](audits/2026-10-03-i08-billing-provider/published-release/README.md): published packages and backend/frontend/checkout checks for the recorded commit. They do not establish current package publication, configuration or payment readiness.
- [Native FairCoin billing](integrations/native-faircoin-subscriptions.md): implementation and database/fixture verification; external funded settlement was not demonstrated in that evidence.

During the 2026-11-02 local review, 191 SDK tests and 130 pay tests passed. After
building the SDK output, six packages passed typechecking. Frontend failed at
`src/services/intent-subscription.ts:42` because `LinkedHttpClient` does not expose
`getAccessToken`, with a related implicit-any error on the next line. The follow-up
used current main `3d84f37` and its frozen dependencies (core 7.11.0): frontend
typechecking and all three real socket tests passed without changing the socket
implementation. The earlier failure was against the older dependency installation.
The removal at `59cdd78` subsequently passed 407 frontend tests (including three
product-boundary regressions and the three socket tests), frontend typechecking,
Biome and the Expo web/edge export. These checks used the isolated cleanup
worktree and its frozen dependencies. After integration, an independent check of
all seven packages on main with the current frozen dependencies passed typechecking.
Current deployment and physical-device payment flows remain unverified.

A read-only check on 2026-11-02 of Oxy's public
`GET https://api.oxy.so/billing/personal-plans` returned HTTP 200 with
`state: "unconfigured"`, `purchase: "unavailable"` and an empty `plans` list.
That observation covers the then-current personal-plan catalogue, not availability
of a standalone Mention Plus offer. Subsequent approved standalone catalogue
configuration records USD 599 minor units monthly and USD 5750 annually, with
purchase unavailable. The earlier observation is historical, not the current
standalone price. Visible prices do not authorize a payment or an access grant.

The November 3 local implementation adds a reusable Bloom checkout, an optional
Peable SDK UI adapter and Mention integration. The earlier local implementation separated fixture scenarios and actual one-time
card test processing. The current requirement supersedes that split: one Bloom
checkout with test/live processing selected by environment, secure provider fields
inside Bloom's form, and fixtures confined to development stories/tests. Signed settlement was verified, but that one-time test does
not create a subscription or grant Plus. These local changes are not a claim of
production activation or published package availability. See the dated
[local test record](integrations/payment-provider-boundary.md#local-verification-2026-11-03).

## Delivery order

1. **Product boundary implemented in source.** The inherited Buy FAIR and
   exchange/ATM discovery surfaces are removed. Sending, receiving and merchant
   payments in FairCoin remain. Verify the removal in the release artifact and
   keep generic upstream wallet changes separate from Peable-specific product gates.
2. **Complete standalone Mention Plus checkout first.** Subscribe opens Pay with
   Peable in a Bloom detached bottom sheet, showing the approved standalone offer
   and payment progress. Mention Plus is independently purchasable; Oxy One also
   includes it. One subscribers keep Plus without a second purchase. Both routes
   use authoritative backend entitlements; pending, canceled and failed payments
   do not become successful subscriptions.
3. **Verify that first journey.** Cover Subscribe, closing/canceling, reopening,
   duplicate clicks, authentication where needed, declined payment, delayed
   confirmation and recovery after interrupted responses. Verify entitlement
   updates and renewals/cancellation against authoritative backend state. Use the
   same payment implementation for subsequent integrations.
4. **Build Orbit by Peable.** Bring onboarding, payments, links, checkout,
   sellers, refunds/disputes, billing, tax and webhook diagnostics into a coherent
   administrative interface over existing authority and services.
5. **Complete financial operations and later products.** Define accounting and
   fees per entity before adding balances, bank payouts, reserves and reconciliation.
   Terminal/contactless, commerce adapters, coordinated shared pockets, broader
   analytics and additional providers remain separate future work.

The previous Mention source integration bound a One-only offer and rendered a
dialog. The product requirement now explicitly supersedes that assumption:
standalone Mention Plus checkout, presented in a Bloom detached bottom sheet,
with One remaining an additional source of Plus access. Updating the offer binding,
backend entitlement flow and sheet now has local implementation and test evidence,
but live purchase availability remains disabled. The standalone catalogue has its
own approved prices; no existing One price is a substitute. Enabled rails, fiscal
configuration and the complete subscription/access lifecycle still require acceptance.

The payment flow must retain a scoped operation key for interrupted-request
recovery, open only authoritative checkout destinations when a hosted authorization
step is needed, and obtain payment/access outcomes from the backend. Dismissing
the sheet or browser does not grant access. Existing One benefits must continue
to be recognized without billing the user twice.

## Release gates retained

- Resolve the merchant-of-record role, cost allocation, platform fees and provider
  account scope for each enabled flow; record applicable legal review.
- Verify exact backend, checkout and app release artifacts, pre/post migrations,
  provider key-mode isolation and published SDK versions used by consumers.
- Exercise payment, cancellation races, refunds including delayed failure,
  seller onboarding, transfers/reversals and disputes against the real test provider.
- Run a funded chain canary through intent creation, payer retrieval, device
  approval, signing, broadcast, settlement, realtime status and merchant webhook.
- Verify cold boot, sign-in, identity-key changes and recovery on physical devices
  with and without the shared identity keystore before enabling affected flows.
- Recheck private-key rejection and concurrent address reservation. Preserve
  transactional webhook enqueueing, public-id routing and state compare-and-swap.
- Keep dispute attachments, bank payouts, reserves, terminal and coordinated shared
  pockets out of available-capability claims until implemented and accepted.

## Initial Orbit workspace (local source)

`packages/orbit` is a standalone application, separate from both the wallet and
anonymous payer checkout. The wallet no longer contains the workspace. It uses Bloom navigation, selection controls and grouped
sections. Its read transport delegates authentication to the existing linked Oxy
client; organization membership and application/environment authorization remain
server-owned. Signed-out users see a real sign-in action and make no merchant
requests. Every query identity includes the viewer and selected scope; changing
scope resets pagination and payment details. UI view models omit payer secrets
and merchant watch-only keys. No merchant mutation action is exposed in this first
iteration. Tax and contribution links retain their existing scope selectors.

Focused tests cover authenticated GET-only transport, encoded cursors, denied vs
empty responses, merchant/application/environment mismatch, payment identity,
secret omission, cache scope separation and exact minor-unit display. Real
authenticated merchant acceptance still needs a user with appropriate membership;
no synthetic session or invented financial data substitutes for it.

The isolated authenticated React regression uses test-only Oxy/Bloom host mocks
and the real query/client logic. It exercises organization/application changes,
environment switching, next-page cursors, a delayed old-scope payment-detail
response and webhook empty states. Mocks run in a separate test process and are
not shipped or injected into the running app. The local signed-out browser check
makes no merchant API requests. Orbit typechecking and independent web export pass.

The local Orbit server runs the actual implementation worktree with Fast Refresh
at `http://localhost:8121`. Its public gateway configuration currently uses
the existing `https://api.peable.to` default with real user authentication; the
local payment test harness on port 4310 is a separate environment and is not an
Orbit merchant authority. All Orbit transport methods are read-only. Configuring
another gateway uses the existing `EXPO_PUBLIC_GATEWAY_API_URL` setting, never a
fabricated session or a provider credential in the browser.


### Standalone Orbit by Peable

Orbit is a separate merchant application in `packages/orbit`, with its own
entry point, navigation, session prefix, local server and web build. Run
`bun run dev:orbit` and open `http://localhost:8121`. The wallet and anonymous
payer checkout remain separate applications.

Its navigation covers overview, payments, customers, subscriptions, invoices,
settlements, disputes, reports, tax, contributions, developers, webhook delivery,
credentials and settings. Authenticated merchant/payment/detail/webhook reads
are connected to existing owner-authorized APIs. Other operational sections
explicitly state their current integration limits; navigation does not mean
that every operation is implemented. No financial statistics are invented.
Production hosting and a dedicated registered Orbit auth redirect remain
separate deployment work; this change is local only.
