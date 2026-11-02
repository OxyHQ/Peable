# Peable roadmap

> Initial review: 2026-11-02 at `0eeb676`; implementation follow-up through
> Peable `59cdd78` and the Mention payment-window work on 2026-11-03.
> This is a source and recorded-evidence review, not a production certification.

## Product and boundaries

Peable has three connected surfaces: the business payments platform (dashboard,
APIs and services), the personal payment app, and SDKs that bring payment
management and the **Pay with Peable** experience into other websites and apps.
The [README](../README.md) defines their purpose and relationship.

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
| Merchant dashboard | Merchant/payment/webhook APIs; tax administration and contribution screens in the app | Complete merchant dashboard, credential UI over Oxy authority, broad resource management |
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
Mention's payment-window integration therefore cannot offer a live subscription
until an approved central Oxy One offer is configured. An unavailable catalogue
must never fall back to an invented price or grant Plus locally.

## Delivery order

1. **Product boundary implemented in source.** The inherited Buy FAIR and
   exchange/ATM discovery surfaces are removed. Sending, receiving and merchant
   payments in FairCoin remain. Verify the removal in the release artifact and
   keep generic upstream wallet changes separate from Peable-specific product gates.
2. **Complete the unified payment window, with Mention first.** Mention Plus's
   Subscribe action opens Peable's window for the selected subscription. It shows
   the offer, payment method, authorization and resulting status. Mention Plus stays
   bundled with Oxy One: Oxy verifies payment and owns the entitlement; Mention
   reads that authority without a separate subscription price. Pending, canceled and
   failed outcomes do not become successful subscriptions. Existing historical
   integrations do not change this first target for the new window experience.
3. **Verify that first journey.** Cover Subscribe, closing/canceling, reopening,
   duplicate clicks, authentication where needed, declined payment, delayed
   confirmation and recovery after interrupted responses. Verify entitlement
   updates and renewals/cancellation against authoritative backend state. Use the
   same payment implementation for subsequent integrations.
4. **Build the merchant dashboard.** Bring onboarding, payments, links, checkout,
   sellers, refunds/disputes, billing, tax and webhook diagnostics into a coherent
   administrative interface over existing authority and services.
5. **Complete financial operations and later products.** Define accounting and
   fees per entity before adding balances, bank payouts, reserves and reconciliation.
   Terminal/contactless, commerce adapters, coordinated shared pockets, broader
   analytics and additional providers remain separate future work.

Mention's source integration opens a Pay with Peable dialog immediately from
Subscribe. Its deployment explicitly binds the reviewed Oxy One offer using
`EXPO_PUBLIC_MENTION_PLUS_OFFER_ID` and `EXPO_PUBLIC_MENTION_PLUS_OFFER_VERSION`.
The dialog requires the central catalogue to expose that exact offer/version as
available with an approved price. Without that match it shows unavailable.

Continue uses the central `startPersonalPlanCheckout` API and a persisted
account/offer/version operation key, then opens the authoritative HTTPS hosted
checkout in a web popup or native browser. The hosted destination depends on the
payment rail; the dialog does not claim to embed every authorization step itself.
Status checks reuse the operation key. No window-close callback grants Plus.
This source integration still requires deployed offer configuration and payment,
account-switch and cross-device acceptance. Method availability follows the
approved offer and deployed capabilities, not the presence of a button.

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
