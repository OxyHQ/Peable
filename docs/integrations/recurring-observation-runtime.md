# Recurring observation runtime

The existing `PEABLE_BILLING_COHORT` JSON accepts `observationsEnabled: true`
only as an explicit deployment opt-in. Omission or false leaves observation
composition and relay polling off. It does not change cohort ownership checks,
create a catalogue, authorize a new merchant, or enable Oxy One sales.

When enabled, boot verifies the same platform account and portal configuration
as billing. One environment is required per deployment. The provider drain uses
the owned recurring reader and invoice resolver; event metadata cannot establish
ownership. The recurring relay polls the durable observation outbox and commits
the webhook delivery and relay pointer atomically. Failed passes retry on the
next poll, concurrent processes use row locks with `SKIP LOCKED`, and each process
excludes overlapping passes. Shutdown stops scheduling new relay passes. The
existing webhook dispatcher handles actual delivery and retries.

Apply the existing recurring schema pre-migration before opting in. This change
introduces no fiscal authority, Faircoin mandate, or
commercial configuration. The current production adapter remains Stripe;
changing a provider label does not implement a Faircoin recurring payment rail.

Oxy One's approved invoice issuer is The Oxy Collective, Inc. That approval does
not supply tax registrations, the tax remitter, sales countries, tax services,
exchange-rate authority, or a refund policy. Invoice amount observations remain
insufficient for final fiscal authority; consumers must fail closed. Faircoin
manual monthly payments and automatic renewal are approved choices, but an
automatic renewal still requires explicit consent, amount and cadence limits,
and verifiable revocation before a real mandate can be used.

The owned invoice reader currently accepts settled paid invoice projections only.
Created/open/void invoices and non-final refund transitions cannot be treated as
final paid authority. They may remain pending and retry until a supported final
projection exists; this worker does not close those lifecycle acceptance cases.
Monitoring and a provider-neutral full invoice-state adapter remain required
before enabling a complete commercial lifecycle.

## Unreleased signed authority and Faircoin scheduling infrastructure

The source SDK adds `billing.retrieveFinalInvoiceAuthority(subscriptionId,
invoiceId)` and the authenticated gateway route `invoice_authorities`. The
service refuses the read until a trusted final-invoice resolver and pinned
Ed25519 verification keys are supplied. The SDK separately requires configured
`invoiceAuthorityKeys` before making this request and verifies the returned
signature, reference correlation and evidence clocks. Neither runtime boot nor
merchant input configures a resolver, keys, tax policy or invoice issuer.

The signed canonical JSON includes schemaVersion 1, source, invoice and method. The shared
canonical encoder sorts object keys and rejects non-JSON values and unsafe
numbers; the gateway strictly validates the invoice schema, exact owned paid
invoice references, paid net/tax/gross amounts, mode, period, account, timestamps,
and Faircoin quote expiry. This is a provider-independent evidence transport;
existing owned billing retrieval and recurrent event adapters remain Stripe.
It does not implement a Faircoin subscription payment provider.

The Faircoin scheduling authorization service requires verified consent and
revocation evidence plus a durable atomic repository. The PostgreSQL repository
uses an advisory transaction lock for first inserts, row locks, exact registered
merchant identity, immutable consent/revocation and append-only instructions.
Pre-migration 0023 creates its table. No runtime default enables it. Tests cover
real PostgreSQL concurrent inserts, restart, revocation and rollback plus a
serial in-memory fixture with
reordered persisted object keys. Explicit consent binds payer, merchant, app,
subscription, plan, mode, environment, monthly cadence, maximum base-unit amount
and expiry. Atomic scheduling excludes overlapping periods, preserves exact
idempotent replay, and rejects past-period instructions. Manual renewal returns
payer-confirmation-required. Revocation is observable and blocks subsequent
scheduling and execution checks, including already reserved instructions.

An execution check is scheduling evidence, not an atomic funds transfer. A real
wallet/payment-rail executor still needs durable consumption, remote payment
idempotency, recovery, and revocation linearized with dispatch. No funds are
transferred here and no payer keys or live mandates are accepted. A real fiscal
resolver/signer, approved runtime consent composition, complete Faircoin provider
adapter and executor, approved new shared-types/SDK publication, and consumer
adoption are separate unfinished implementation/release gates.

The worldwide sales goal is not an approved country coverage policy. Fiscal
calculation belongs to Peable behind its SDK; neither Oxy consumers nor this
change select Stripe Tax or another supplier. Registered selling countries,
tax-remitter configuration and a supported calculator remain required.

## Unreleased precheckout tax quote gate

The source SDK adds `billing.createTaxQuote({storeId, planId,
customerLocationEvidenceId})`. A consumer never passes a guessed tax amount,
seller, issuer, remitter, country allowlist or provider credentials. Peable
resolves a reviewed product configuration and scoped customer-location evidence,
requires explicit supported country coverage, and delegates calculation to a
provider-neutral calculator seam. Wildcard country coverage is rejected. The
signed quote must match the configured product gross amount, fiscal actors,
evidence, source, valid clocks and pinned Ed25519 key. The SDK independently
verifies the signed quote with configured `taxQuoteAuthorityKeys`.

The authenticated route is mounted, but absent a trusted calculator the service
returns 404. No default supplier, seller/remitter registrations, worldwide
allowlist or fiscal activation is created. The existing billing owner adapter
still uses Stripe deployment/binding contracts. The quote seam and evidence
transport are provider-independent; the Faircoin recurring payment adapter is
still unfinished. The approved issuer legal name is The Oxy Collective, Inc.;
its verified fiscal identifier and registrations remain configuration inputs,
not invented identifiers in an invoice fixture.
