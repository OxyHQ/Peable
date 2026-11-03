# Peable product and provider boundary

Peable is the public payments platform: the planned separate Orbit by Peable
merchant application, APIs, services, server
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

Orbit is unfinished and deferred outside this payment release.

The reusable checkout presentation belongs in Bloom. Peable's optional
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

Peable has one buyer checkout. Test/live is a processing-environment distinction,
not a choice between different checkout products. Normal Mention Plus has no
simulation selector. Development scenarios belong only to the isolated playground;
they do not provide payment, credit, wallet-balance or gift-claim authority.

The shared Bloom CardForm supplies labels, layout, country/postcode controls and
field chrome. Card number, expiry and security code are provider-hosted secure
fields; their values never enter host state or storage. Continue prepares an opaque
authorization in memory, and the separate confirmation Pay action submits it.
Unavailable methods remain visibly unavailable with capability reasons rather than
silently becoming fixture flows. Required provider disclosures must remain intact.

## Local verification — 2026-11-03

The normal local Mention Plus URL (`http://localhost:8110/plus`) was tested without
payer-secret URL fragments or a buyer mode selector against the reviewed provider
TEST account. Latest evidence supersedes the earlier one-time-payment experiment:

- Monthly USD 599 and annual USD 5750 subscriptions became active, their first
  invoices were paid, and signed provider events settled the corresponding Peable
  payments before the UI completed.
- An issuer authentication challenge completed through its pointer action, with
  the secure field integration retained while authorization was in progress.
- A declined card remained retryable; successful retry reused the same payment
  intent and subscription rather than creating another contract.
- Browser isolation checks found no raw card number or security code in host
  inputs, storage or own-origin request payloads. Secure fields were provider
  frames, with no alternate provider payment-form tabs or Link flow.
- Failed bootstrap retry retained its operation key and reported failure through
  the shared toast, without opening a simulated fallback checkout.

Evidence is recorded in Mention's `docs/mention-plus-payments.md` and the local
`unified-{month,year,sca,decline-retry}-proof.json` browser artifacts. Reports must
not include payer secrets, full bootstrap URLs, raw card values or credentials.

These are local source and actual TEST observations, not deployed-release or live
payment evidence. They grant no production Mention Plus entitlement. Production
retains the hosted, gated integration: the public embedded billing/Oxy binding,
merchant authority, fiscal configuration and authoritative access lifecycle must
be completed and accepted before that experience is enabled. Renewal, cancellation
and other rails require their own exact-environment acceptance; this card test does
not establish those capabilities.
