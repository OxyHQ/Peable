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

## As built (Phase 5)

The status stays **proposed**: the model below is implemented and tested, and a
third party's live money on it remains behind the release gate.

**§1 — the merchant's account.** One table, not two: the merchant's own account
is a `connected_accounts` row with `role = 'merchant'` (at most one per merchant,
`connected_accounts_merchant_role_key`; card half only; no `external_ref`), opened
by `services/accounts/merchantAccount.ts` through the same Accounts v2 path as a
marketplace seller, with `dashboard: 'none'` instead of `express`. It is the
`account` object (`GET/POST /v1/account`, `POST /v1/account_links`): provider
`capabilities`, `requirements` as identifier lists (`currently_due`,
`eventually_due`, `past_due`, `pending_verification`, `disabled_reason` — sellers
now carry the same lists instead of counts), `business_profile` and `settings`
(payout schedule, statement descriptors, branding) as provider snapshots, written
to the provider and read back, never set locally. Readiness changes emit
`account.updated` (a seller's still `connected_account.updated`).
`/v1/merchants/me` stays: it is the Peable merchant REGISTRATION (the Oxy
application, the FairCoin receive key, the display), which a FairCoin-only
merchant has and which exists before and without any provider account; folding it
into `/v1/account` would make one object half provider snapshot, half local
registration.

**§2 — charge models** (`services/money/chargeRouting.ts`, decided once at create
and stored on the intent: `transfer_destination_id`, `on_behalf_of_id`,
`transfer_amount`, `application_fee_amount`):

| Merchant | Charge |
|---|---|
| Oxy first-party (`merchants.first_party`, mirrored from the credential's VERIFIED `authority: 'first_party'`, Oxy ADR 0049 — never branding or tier) | platform charge, no fee |
| has an own account with `charges_enabled` | destination charge `on_behalf_of` it, `application_fee_amount` from its fee schedule |
| has an own account still onboarding | refused, 409 `account_not_ready` — never silently a platform charge |
| no own account (a marketplace) | platform charge, separate transfers, as before |
| names `transfer_data` / `on_behalf_of` / `application_fee_amount` | destination charge to its seller (`ca_…`, card half required) |

The provider create is replayed from the row (`providerRoutingFor`), so a resumed
create sends the same charge under the same idempotency key, and a replayed
`Idempotency-Key` naming another destination is a conflict.

**§3 — fees.** `fee_schedules` (per merchant × `card` × currency: basis points +
fixed) or the deployment default (`ORBIT_FEE_PERCENT_BPS`, `ORBIT_FEE_FIXED`, both
zero by default — no fee is charged that no agreement names). Rounded half up,
capped at the amount; a zero fee is no fee instructed. `application_fees` (`fee_…`)
and `application_fee_refunds` (`fr_…`) are written only from the provider's own
fee object (`application_fee.*` events re-read it), with `application_fee.created`
/ `application_fee.refunded` in the same transaction; `amount_refunded` is the sum
of the refund rows. Refunds take `refund_application_fee` and `reverse_transfer`
(stored on the row, resent on a resume), plus `reason`, `metadata`, update and
cancel.

**§4 — ledger, balance, payouts.** `balance_transactions` (`txn_…`) are the
provider's own transactions for the account (listed with `Stripe-Account`), copied
verbatim and keyed by the provider id (`ingestion_key`), so ingestion is
idempotent; a recorded transaction whose figures differ is a mismatch, never an
overwrite. `ledger_entries` post one `recognized` journal per transaction (`±net`
against `external`) and one `released` journal when the provider makes pending
funds available; every journal sums to zero (`postJournal` refuses otherwise, and
the reconciliation re-proves it). `GET /v1/balance` sums the entries; a merchant
without an account gets 404 `account_missing`, never zeros. A first-party
merchant's ledger is its platform charges' transactions, read charge by charge and
attributed to it; the platform's own payouts are the operator's treasury and on no
merchant's ledger. `payouts` (`po_…`) mirror the provider (`payout.*` on the
Connect endpoint, re-read), and `POST /v1/payouts` instructs one only on a manual
schedule — the provider executes it. A paid payout's transactions are read with
the `payout=` filter and attached (`GET /v1/reports/payout_reconciliation`).

**Reconciliation.** Daily (`services/money/reconciliation.ts`): per account, the
provider's transactions and payouts of the last seven days against the ledger;
`missing_in_ledger`, `amount_mismatch`, `status_mismatch`, `missing_at_provider`,
`payout_mismatch`, `unbalanced_journal` are recorded in `reconciliation_mismatches`
(warned in the log, listed in Orbit), and only after the comparison does the run
perform the ordinary ingestion; the next run closes what it no longer sees.
Nothing is corrected silently.

**§5 — FairCoin.** A FairCoin payment reaching `succeeded` posts an
`informational` entry for its amount in the transition's own transaction, and a
reorg that rewinds it posts the reversal; on-behalf payments are the seller's.
`informational` is never part of a payable balance.

**`Peable-Account`.** Accepted on `/v1/account`, `/v1/account_links`,
`/v1/balance`, `/v1/balance_transactions`, `/v1/payouts` and
`/v1/reports/payout_reconciliation`, naming one of the caller's sellers with a
card account (403 otherwise); refused with 400 on every other route.

**The release gate in code.** `ORBIT_THIRD_PARTY_LIVE_PAYMENTS` (default `false`)
must be `true` for a merchant that is not first-party to open a LIVE account, take
a LIVE destination charge or instruct a LIVE payout (403 `live_payments_gated`).
Test mode is never gated. Setting it is the operator's act of recording that the
gate's three conditions above were met; nothing in the repository sets it.

## As built: the settlement of a refund and of a dispute

§4's rule — a figure the provider has not given is `null` with a status, never
`0` — first lived in one read: `GET /v1/payment_intents/{intentId}/settlement`
(`refunds.settlement`), what a payment's charge brought into the balance. A
marketplace on separate charges and transfers (Mercaria) also books what a
REFUND took out and what a DISPUTE withdrew, in the currency the money actually
moved in on the platform balance, and had nothing to read it from. Two reads
were added beside it, live and unstored like the first:

- `GET /v1/refunds/{id}/settlement` (`refunds.refundSettlement`): the refund's
  own balance transaction. A refund the provider never acknowledged, and one
  that `failed` (its debit is undone by a second transaction) or was `canceled`,
  is `unknown`.
- `GET /v1/disputes/{disputeId}/settlement` (`disputes.settlement`): the
  dispute's WITHDRAWAL — the negative balance transaction, principal plus
  dispute fee. An inquiry moves no money and is `unknown`; the reinstatement of
  a won dispute is a later movement this does not report.

They answer the ONE `settlement` object, generalised additively: `refund` and
`dispute` (expandable, `null` on a payment's) name whose movement it is beside
`payment_intent`. The signs are fixed for all three: `gross` is the MAGNITUDE of
the movement, `fee` the provider's fee on it as the provider signs it (positive
charged, negative returned — a refund's is usually `0`), `net` the SIGNED effect
on the balance, so `net = gross − fee` for a payment and `net = −gross − fee` for
a refund or a dispute; `currency` is the settlement currency and
`exchange_rate` is present only when a conversion happened. `fee` is therefore a
signed amount on the wire (a payment's is never negative). The seam is the same
`SettlementReportingProvider` (`getRefundSettlement`, `getDisputeSettlement` by
the provider's object ids, each `UNKNOWN_SETTLEMENT` without a balance
transaction), reached only through `settlementReport.ts`'s one never-throwing
read in the row's own mode (`selectStoredProvider`). As with the payment's, it
reports what moved and attributes the cost to nobody.

## Consequences

- No Peable-held balance, no Peable-initiated bank transfer, and no table that
  could represent either. A design that adds one supersedes this ADR first.
- `GET /v1/balance`, `/v1/balance_transactions` and `/v1/payouts` answer from the
  merchant's connected account, so a merchant without one has none — Orbit says so
  rather than showing zeros.
- Treasury, Issuing and Capital equivalents are out of scope: each needs its own
  banking authorisation, which this model exists to avoid.
