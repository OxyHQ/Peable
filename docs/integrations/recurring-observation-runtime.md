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
introduces no migration, SDK release, fiscal authority, Faircoin mandate, or
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
