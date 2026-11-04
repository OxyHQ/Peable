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
| Orbit by Peable | Merchant/payment/webhook APIs; existing tax administration and contribution screens | Separate merchant application; unfinished workspace deferred outside this payment release, credential UI over Oxy authority and broad resource management. Stripe-parity plan and gap list: [`orbit/stripe-parity.md`](orbit/stripe-parity.md) (ADRs 0014–0018) |
| Billing | Orbit's billing engine (ADR 0018): catalog, subscriptions, invoices, credit notes, meters, entitlements, customer portal; FairCoin invoices paid by the payer (`send_invoice`) | Production acceptance of the first enabled offer |
| Tax | Location evidence, calculations, owner-approved registrations, reports and refund reversals | Provider/environment acceptance for enabled offers and jurisdictions |
| Personal app | Identity, self-custodial wallet, activity, social send/receive, profiles, QR, pockets and checkout approval | Physical-device/recovery acceptance |
| Browser integration | `@peable.to/sdk/checkout` payer client and optional `@peable.to/sdk/checkout/ui` unified Bloom checkout, locally tested in Mention | Published release acceptance |
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

- The three October 3 records below are of the Stripe-Billing proxy (`/v1/billing/*`), retired in November 2026 in favour of the billing engine; they are history, not current capability.
- [October 3 hosted subscription checkout](audits/2026-10-03-i08-billing-provider/checkout-sandbox/README.md): real provider test-mode checkout, customer reuse, lost-response recovery and period-end cancellation request. Oxy authentication was synthetic.
- [October 3 lifecycle tests](audits/2026-10-03-i08-billing-provider/test-clock/README.md): trial, paid renewal, refund/idempotency, cancellation, failed renewal and unresolved authentication challenge. These fixtures do not prove production adoption or the entire marketplace rail.
- [Historical release and deployment receipts](audits/2026-10-03-i08-billing-provider/published-release/README.md): published packages and backend/frontend/checkout checks for the recorded commit. They do not establish current package publication, configuration or payment readiness.

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
Peable SDK UI adapter and Mention integration. Normal Mention Plus has one buyer
checkout, with processing environment selected by configuration. Actual monthly
USD 599 and annual USD 5750 test subscriptions reached active status with paid
invoices and signed Peable settlement. Issuer authentication completed through the
challenge's pointer action; decline and retry reused the same payment intent and
subscription. Secure provider fields remain inside the canonical Bloom form.

These observations do not grant production Plus access or prove live activation.
Development fixtures are confined to a separate playground, not a buyer mode.
Production retains the hosted, gated integration until the authoritative embedded
billing binding and entitlement lifecycle are accepted. See the dated
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
4. **Build Orbit by Peable as a separate merchant application.** This unfinished
   phase is paused and excluded from the payment release. Bring onboarding, payments, links, checkout,
   sellers, refunds/disputes, billing, tax and webhook diagnostics into a coherent
   administrative interface over existing authority and services.
5. **Complete financial operations and later products.** Define accounting and
   fees per entity before adding balances, bank payouts, reserves and reconciliation.
   Terminal/contactless, commerce adapters, coordinated shared pockets, broader
   analytics and additional providers remain separate future work.

Standalone Mention Plus checkout now has local source and actual recurring test
payment evidence. Oxy One remains an additional source of Plus access, not a
substitute offer or price. Live purchase availability, embedded billing authority,
fiscal configuration and the complete subscription/access lifecycle still require
acceptance. A successful test subscription is not a production entitlement.

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
