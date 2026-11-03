# ADR 0015 — Orbit's fiat funds stay at the provider, in an account per merchant

**Status:** proposed. The architecture is accepted for implementation; enabling
it for a third party's live payments is gated on the legal review named below.
**Refines:** ADR 0009 ("the merchant-of-record question is now open").
**Date:** 2026-11-03.

## Context

Orbit must give a merchant what Stripe gives one: a balance, fees, payouts to a
bank, and a ledger that explains every movement. The obvious way to build that —
every payment lands in Peable's platform balance, Peable computes what each
merchant is owed and pays it out — makes Peable the party that receives and holds
money belonging to someone else and later transmits it. That is the activity
payment-services regulation is about, independent of whether the product has a
fiat wallet. Peable does not hold such an authorisation, and obtaining one is a
long, capital- and compliance-heavy process.

The product's needs are different by flow:

| Flow | Whose money | Example |
|---|---|---|
| Oxy sells its own product | Oxy's | Mention Plus, Oxy One |
| A merchant sells its own goods through Orbit | the merchant's | an external shop |
| A marketplace collects for several sellers | the sellers', minus the marketplace's take | Mercaria |
| A person pays a person | never touches Orbit | FairCoin, self-custodial |

## Decision

**Fiat funds never reach a Peable bank account and are never paid out by Peable.
They remain at the acquirer, in a provider account that belongs to the merchant;
Orbit instructs the provider and mirrors what happened.**

1. **Every Orbit merchant that takes fiat has a provider connected account**
   (Stripe Accounts v2, `dashboard: none`, so Orbit is the only dashboard the
   merchant sees). `services/accounts/` already creates these for marketplace
   sellers; Orbit generalises it to the merchant itself. KYC is collected by the
   provider (embedded onboarding in Orbit web, or hosted account links), so
   identity documents still never enter this database.
2. **Charge model per flow:**
   - *Oxy's own products:* platform charge, Oxy is the merchant of record (today's
     behaviour, now stated as intended).
   - *A merchant selling its own goods:* destination charge with `on_behalf_of`
     the merchant's account and `application_fee_amount` for Orbit's fee. The
     merchant is the merchant of record: their descriptor, their chargebacks.
   - *A marketplace:* separate charges and transfers, as implemented
     (`services/transfers/`), within the provider. ADR 0009's structural limit
     stands: one merchant of record per PaymentIntent.
3. **Orbit's fee is an application fee**, configured per merchant (percentage +
   fixed, per method); Oxy's own applications may carry a zero rate. The fee is
   recorded, refundable (`application_fee_refunds`) and reported.
4. **Balance, balance transactions and payouts are mirrors.** Orbit's ledger is
   double-entry and per merchant per currency; it is fed by the provider's balance
   transactions and payouts for the merchant's account and reconciled against them
   daily. A figure the provider has not given is `null` with a status, never `0`
   (the `settlementReport.ts` rule). The payout itself is executed by the provider
   on the schedule the merchant sets in Orbit.
5. **FairCoin is unchanged.** Payments go straight to an address derived from the
   merchant's or seller's watch-only key (ADR 0012); the ledger records them as
   informational entries, never as a balance Orbit holds.

## What this ADR does not claim

ADR 0009 is explicit that using Connect does not by itself establish a regulatory
exemption or remove the platform's liability for negative balances, and that no
such claim may be repeated here without a legal opinion. This ADR keeps that rule.
It records an architecture chosen to keep Peable out of the flow of funds; it does
not certify that the architecture is sufficient in any jurisdiction.

## Release gate

Before a third party's live fiat payments run on this model:

- a written legal review of the model for the launch jurisdictions, including the
  marketplace flow (platform as merchant of record with transfers to sellers);
- the merchant agreement and Orbit's fee terms, including who invoices the fee;
- the negative-balance exposure (`losses_collector: application`) accepted
  explicitly, with reserves if the review requires them.

## Consequences

- No Peable-held balance, no Peable-initiated bank transfer, and no table that
  could represent either. A design that adds one supersedes this ADR first.
- `GET /v1/balance`, `/v1/balance_transactions` and `/v1/payouts` answer from the
  merchant's connected account, so a merchant without one has none — Orbit says so
  rather than showing zeros.
- Treasury, Issuing and Capital equivalents are out of scope: each needs its own
  banking authorisation, which this model exists to avoid.
