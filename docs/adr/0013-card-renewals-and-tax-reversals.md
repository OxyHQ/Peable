# ADR 0013 — Card renewals are repriced, refunds are reversed

**Status:** accepted.
**Date:** 2026-10-16.

## The defect

ADR 0012 priced only a quoted card subscription's FIRST invoice. Stripe renews
automatically and keeps the checkout's manual tax rate on the subscription
item, so every later period was charged the checkout's frozen tax without a
calculation of its own: no `tax_transaction`, no signed final invoice (the
authority answered `reconciliation_required`), and the drain only warned. And
`tax_transactions` had no reversal, so a refunded sale stayed in the filing
report at its full tax.

## The decision

### A renewal is repriced before it finalizes

Stripe sends `invoice.created` for a subscription-cycle invoice while it is
still a draft, and waits about an hour after the delivery succeeds before it
finalizes and charges it. Peable's ingress answers in milliseconds and the
drain reaches the event seconds later. For a quoted subscription the recorder
(`services/billing/stripeInvoiceTax.ts`):

1. **Holds** the draft first (`auto_advance: false`), so nothing that follows
   can let Stripe finalize it with last period's tax.
2. Records **fresh location evidence** from what Stripe holds about the payer,
   the payer being absent: the customer's billing address (else the card's
   billing address) and the card's issuing country. The ADR 0011 rules judge
   it; Checkout now collects the billing address and saves it on the customer
   (`billing_address_collection: required`, `customer_update.address: auto`)
   so the evidence exists at renewal time.
3. **Freezes a new calculation behind a newly signed quote** through the same
   quote calculator as the checkout, for the same offer and listed price.
4. Puts it on the draft's one line as a manual Stripe tax rate whose percentage
   makes Stripe's rounding land on the frozen amount (`exactTaxRatePercentage`,
   ADR 0012); zero tax clears the line's rates.
5. Re-reads the draft and requires Stripe's `total` and `total_excluding_tax`
   to be the quote's gross and net.
6. Stores the pricing (`billing_renewal_taxes`: invoice, subscription,
   calculation, rate, the quote snapshot), then **releases** the draft
   (`auto_advance: true`).

**Fail closed.** Any failure — insufficient evidence, an unregistered-here vs
registered-there mismatch, the provider down, settings no longer approved, a
discount or line change that moves Stripe's totals — leaves the draft held.
The event stays unprocessed and is retried every minute (`retry_after`, now
honoured by the drain in every mode); the payer is not charged until the
renewal is priced. An operator who gives up voids or finalizes the invoice in
Stripe; the next retry then reports `finalized_unpriced` and stops. A draft
already priced is re-verified on redelivery and held again if it changed.

`invoice.paid` for a renewal commits the RENEWAL's calculation (never the
checkout's), with the same paid-amount checks as the first invoice, and the
signed final invoice of a renewal (`method: card`, `?include=tax_lines`) is
built from the renewal's quote.

### Refunds and credit notes are reversals

A reversal is a `tax_transactions` row with `reversal_of_id` naming the
original, the original's calculation, and its own signed amounts in
`reversal` (negative; positive only to reinstate). Amounts are prorated line by
line and breakdown entry by entry from the CUMULATIVE share reversed, so
several partial reversals add up to exactly the original once all of it is
given back. Writers serialize on the original row. The summary report nets
reversals into the original's rows (`taxableAmount`, `taxAmount` are net) and
counts them in a new `reversals` column (also in the CSV).

- **Card rail: observed.** `charge.refunded`, `refund.*` and `credit_note.*`
  wake the recorder; a payment or invoice Peable Tax never committed is
  answered locally (the card commit now stores its `pi_…` as
  `provider_payment_ref`). Otherwise it re-reads Stripe: issued credit notes'
  `post_payment_amount`, plus succeeded charge refunds not already linked to a
  credit note, capped at the invoice total, is the cumulative target; the
  reversal written is the difference. A refund that later fails lowers the
  target and reinstates.
- **FairCoin rail: recorded.** The gateway never holds FairCoin, so it cannot
  refund; a merchant that refunds from its own wallet records it with `POST
  /v1/tax/transactions/:id/reversals` (`{ reference, amount? }`, SDK
  `tax.transactions.createReversal`). The reference is idempotent. The route
  refuses card transactions, whose reversals come only from the provider, so
  one refund cannot be counted twice.

### The webhook endpoint must deliver the events

A Stripe rail entry with `taxQuoteAdapterRef: "peable_tax"` must name its
`webhookEndpointRef` (`we_…`). Boot reads that endpoint and refuses unless it
is enabled, in the key's mode, on `STRIPE_API_VERSION`, Peable's platform
webhook (`/v1/webhooks/stripe`), and delivers every event in
`PEABLE_TAX_STRIPE_EVENTS` (or `*`): `invoice.created`, `invoice.paid`,
`charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`,
`credit_note.created`, `credit_note.updated`, `credit_note.voided`. The
endpoint is created in the Stripe dashboard (or API) with those events and its
signing secret goes to `STRIPE_WEBHOOK_SECRET`; Peable does not create it.

## What does not change

A Stripe rail entry without `taxQuoteAdapterRef: "peable_tax"` constructs none
of this: no recorder, no endpoint check, no hold. Mercaria's I08 cohort, every
existing subscriber and every unquoted customer take the path they took before.

## Not decided here

- A renewal that finalizes while Peable's drain is down for more than Stripe's
  hour is charged the previous period's frozen rate and commits nothing
  (`renewal_unquoted` warning); reconciling it is an operator task.
- Prorations, discounts and plan changes on a quoted subscription are not
  priced (the portal disables plan changes); such a draft stays held.
