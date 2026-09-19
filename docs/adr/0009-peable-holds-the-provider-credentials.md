# ADR 0009 — Peable holds the provider credentials, and that changes who the merchant of record is

**Status:** accepted for the code; **the merchant-of-record decision it forces
is NOT taken here** and is a release gate.
**Supersedes:** ADR 0001 **D3** ("Provider credentials belong to the MERCHANT").
**Date:** 2026-09-19.

## The discrepancy

ADR 0001 D3 says a `provider_connections` row binds a merchant to a provider and
holds *that merchant's own encrypted credentials*, and that "Peable calls Stripe
**as the merchant**". It calls this "the load-bearing decision of the whole
design", and it is a legal one.

There is no `provider_connections` table. There never was. `services/providers/
stripe/client.ts` constructs ONE process-wide Stripe client from
`config.stripe.secretKey` — a single `STRIPE_SECRET_KEY` belonging to whoever
operates the Peable deployment — and every payment, refund, transfer and
connected account goes through it. `services/providers/registry.ts` resolves
that client without taking a merchant as an argument, because there is nothing
per-merchant to resolve.

So for two years of documentation the repository has described one model and
implemented another. A reader reconciling them concluded the code was unfinished.
It is not: the implemented model is coherent, it is the one that is deployed, and
it is the one the product has been sold on — *"los comercios se integran con
Peable y con sus credenciales de aplicación Oxy. NO aportan claves secretas de
Stripe."* What was missing is that nobody wrote it down, and the consequence that
follows from it was never faced.

## Decision

**Peable holds the provider credentials. A merchant never supplies a Stripe
secret key, and there is no code path that would accept one.**

A merchant authenticates with an Oxy **application credential** — the same
credential every other Oxy service takes — and the gateway resolves them from
`(oxy_app_id, environment)`. Their capabilities on the card rail come from their
own onboarding and from the connected account they hold, never from a key they
hand over.

Three things follow, and all three are now enforced in code rather than
described:

1. **One deployment serves ONE mode.** The key is process-wide, so its mode is
   the deployment's mode. `services/providers/environmentGuard.ts` refuses a
   credential whose environment disagrees with it, before any provider call.
   Separating merchant ROWS by environment — which this gateway already did —
   is isolation of data and not of money.
2. **The platform account's exposure is Peable's.** ADR 0001 D3 established that
   separate charges and transfers require
   `controller.losses.payments = application`, so the platform account answers
   for its connected accounts' negative balances. D3 placed the platform account
   on the merchant's side of that line. It is on Peable's. That exposure is
   real, it is not transferable to Stripe or to the sellers, and it is the
   reason §5's settlement budget exists: an over-settlement comes out of the
   shared balance, which is other merchants' money in flight.
3. **The merchant of record question is now open, and it is not answered here.**

## What this ADR deliberately does NOT decide

**Who the merchant of record is.**

A charge created on the platform account with no `on_behalf_of` makes the
PLATFORM the merchant of record (Stripe's own documentation on this is the
reference). `createIntent` sends no `on_behalf_of` — the adapter accepts one and
nothing supplies it — so on the implemented model, every card payment through
this gateway today has Peable's operator as merchant of record, whatever any
other document says about a marketplace being one.

That is a commercial, contractual and regulatory decision. It determines the
descriptor a cardholder sees, who answers a chargeback, whose terms apply, who
issues receipts, who owes tax, and which registrations are required. It cannot
be settled by a repository, and writing a reassuring sentence here would be the
same mistake D3 made in the other direction.

So this ADR records the SHAPE and names the decision as outstanding:

| Flow | Charge type today | MoR today | Decision needed |
|---|---|---|---|
| Peable's own products | platform charge, no `on_behalf_of` | Peable's operator | confirm it is intended |
| One external merchant selling their own goods | platform charge | Peable's operator | `on_behalf_of` their connected account, or an explicit reseller agreement |
| A marketplace with several sellers per cart | platform charge + transfers | Peable's operator | one MoR per PaymentIntent is a structural limit, not a preference — a cart cannot have two |
| Peable's own fees | not implemented | — | who invoices whom, and under what |

`on_behalf_of` must not be added indiscriminately to close this table. It
changes the settlement account, the statement descriptor and the regulatory
posture, and a cart that funds two sellers cannot carry two of them.

## Consequences

- ADR 0001 D3's `provider_connections` design is withdrawn. Do not build it to
  make the document true; the document is what was wrong.
- D3's surrounding reasoning is NOT withdrawn. Hosted onboarding keeping
  identity documents out of this database, the acquirer being the regulated
  party for the funds, and Peable never holding money are all still accurate and
  still load-bearing.
- Using Connect, and not holding FairCoin keys, does not by itself establish a
  regulatory exemption or remove the platform's liability for negative balances.
  Neither claim should be repeated anywhere in this repository without a legal
  opinion behind it.
- The merchant-of-record decision is a **release gate** for accepting real card
  payments on behalf of a third party, and is tracked in
  `docs/PEABLE-ROADMAP.md` rather than here.
