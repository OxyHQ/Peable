# Peable product and provider boundary

Peable is the public payments platform: Orbit by Peable merchant workspace, APIs, services, server
SDK, payer SDK, hosted checkout and personal payment app. It supports fiat and
FairCoin payment rails. Processing providers are implementation dependencies of
that platform; they do not define the product name or replace Peable's public API.

## Processing architecture

`packages/backend/src/services/providers/provider.ts` defines provider contracts;
`registry.ts` resolves implementations. The current card integration is Stripe,
under `providers/stripe/`. Additional providers are planned, not currently proven
interchangeable or enabled. Stored payments retain their actual provider binding;
existing operations must not silently switch provider when defaults change.

Peable holds processing credentials. Merchant and payer authority, environment
isolation, idempotency, status transitions and signed notifications remain Peable
responsibilities. Provider-hosted collection and authentication may display required
provider or network material; removing a provider name from Peable-authored product
copy does not mean hiding required third-party disclosures or changing that UI.

FairCoin is a separate self-custodial payment rail. Keys remain with the payer;
watch-only merchant keys determine receipt addresses. There is no currency purchase,
exchange or brokerage capability in Peable or Oxy.

The reusable local checkout presentation belongs in Bloom. Peable's optional
`@peable.to/sdk/checkout/ui` entry supplies the payment integration and branding;
Mention supplies its offer and application context. UI dependencies must remain
outside server/root SDK barrels. The existing `@peable.to/pay/ui` person-payment
sheet is a different product flow and must not become a second merchant checkout.

## Capabilities and truthful UI

Payment method availability is the intersection of provider capabilities, merchant
configuration, order eligibility and applicable environment. Merchant installment
preferences may narrow provider-supported plans; they cannot set provider APR,
credit approval or unsupported countries/currencies. Local bank, installment,
wallet-balance, transfer and guest scenarios remain fixtures unless separately
backed by an accepted integration.

There is one buyer-facing Peable checkout. Processing configuration selects a test
or live environment; it does not select another checkout design. An environment
indicator can distinguish test processing, but buyers must not choose between
"UI preview" and a separate payment flow. Fixture scenarios remain development
stories/tests. Bloom owns the review, payment-method selection and card form layout;
provider-hosted secure fields collect sensitive card values inside that layout.
Provider authentication may still require its own protected challenge surface.

The earlier local implementation separated a simulation from a provider form. That
implementation is being replaced under this requirement; the historical acceptance
below must not be read as acceptance of the new unified flow. No raw PAN or CVC may
enter app state, storage, logs or merchant/backend request bodies. Provider-side
secure collection and tokenization remain mandatory.

## Local verification — 2026-11-03

The normal local Mention Plus URL (`http://localhost:8110/plus`) opened a fresh
Peable one-time test checkout without a payer-secret URL fragment. A provider-hosted
card field accepted the standard test card; the UI showed success only after the
local gateway observed settlement, then closed. Browser page errors were empty.

Recorded safe identifiers (not credentials):

- Amount: USD 599 minor units, one-time, `livemode: false`.
- Peable intent: `pi_406338828bdf2fd533f38688`, settled.
- Stripe intent: `pi_3UXZDkAofUef123L0xQVpI7h`, succeeded; created
  `2026-11-03T04:21:16Z` in the reviewed Oxy test account.
- Signed success event: `evt_3UXZDkAofUef123L0WK2x4Ne`, processed at
  `2026-11-03T04:21:25.033Z` without a processing error.

Separate tests verified a declined card and subsequent retry-field recovery. A
3DS challenge completed through a genuine keyboard submit and signed settlement;
pointer activation of that challenge remains an unresolved browser-test issue.
Do not claim complete SCA pointer acceptance from the keyboard result.

These are local source/test observations, not deployed release evidence. The
one-time test does not activate Mention Plus. The approved standalone catalogue
prices are USD 5.99 monthly and USD 57.50 annually; actual subscription activation,
authoritative access, renewal/cancellation, provider/API-version compatibility and
fiscal readiness remain distinct work. Never include secrets or complete payer
bootstrap URLs in test reports.
