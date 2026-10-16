# ADR 0012 — The card rail charges a signed Peable Tax quote

**Status:** accepted.
**Date:** 2026-10-16.

## The defect

Peable Tax (ADR 0011) priced every sale, but only the FairCoin rail could charge
the signed quote. The Stripe rail had no `BillingTaxCheckoutAdapter`, so a
merchant served by both rails could not sell by card with Peable Tax: a card
checkout either carried no Peable tax at all or needed an external adapter
nobody had.

## The decision

One reference on a Stripe rail entry, `taxQuoteAdapterRef: "peable_tax"`, turns
on Peable's own quote, checkout and invoice signer for that rail together
(`services/billing/stripeTaxCheckout.ts`). The entry also names
`invoiceSigningKeyId` (the pinned billing key, as on FairCoin) and each quoting
cohort lists its `offers` — the bound Stripe prices with their tax treatment.
Another checkout or invoice reference beside `peable_tax` is a boot error.

1. **The quote** is the same signed v1 `BillingTaxQuote` as FairCoin's:
   `taxServiceRef: "peable_tax"`, a frozen `taxcalc_…` as
   `taxRateEvidenceId`, the `taxloc_…` evidence, the registration (or
   `not_registered` / `nontaxable`) as coverage. A card quote stands two hours
   (bounded by its calculation and evidence), because Stripe refuses a Checkout
   that expires sooner than 30 minutes after it is created.
2. **The checkout charges exactly the quote.** The bound price stays the
   subscription's one line; the frozen tax rides on it as a manual Stripe tax
   rate (`inclusive` or not, as the offer), whose percentage is chosen so that
   Stripe's arithmetic lands on the frozen amount under any rounding
   (`exactTaxRatePercentage`). `automatic_tax` is off, so Stripe never prices
   the sale again. The Checkout expires with the quote. Stripe's own totals
   (`amount_total`, `total_details.amount_tax`) are checked against the quote
   before the URL is returned; a difference expires the session unpaid and
   fails the request. The bound price must charge exactly the offer's listed
   price. Zero tax (`not_registered`, `nontaxable`) attaches no rate.
3. **Payment commits the tax.** `invoice.paid` wakes the drain; the recorder
   re-reads the invoice, finds the quoted checkout that made the subscription,
   proves the subscription and initial invoice through the verified bindings,
   checks the paid gross/net/tax against the quote, and commits the
   calculation as a `tax_transaction` (`rail: "stripe"`, the invoice id as
   reference). Idempotent like FairCoin's acceptance commit: one transaction per
   calculation and per invoice, so redeliveries commit nothing twice. A
   customer that never bought through a quote is answered locally after one
   invoice read.
4. **Peable signs the card invoice.** The final invoice authority of a quoted
   subscription is signed by Peable with the pinned key (`method: "card"`), so
   `?include=tax_lines` adds the frozen tax lines inside the signature, as on
   FairCoin. A reader relaying someone else's signature still cannot.

## What does not change

A Stripe rail entry without `taxQuoteAdapterRef: "peable_tax"` constructs none
of this. Mercaria's live I08 cohort, every existing subscriber and every caller
that sends no quote take exactly the path they took before; their offers stay
`null` in `listRails()`.

## Not decided here

- **Renewals.** A checkout quote prices the initial invoice only (as before).
  Stripe renews automatically and keeps the tax rate on the subscription item,
  so a renewal is charged the same frozen tax, but it has no quote of its own:
  no tax transaction is committed and its invoice authority answers
  `reconciliation_required`. The drain warns for each such invoice. Pricing a
  renewal needs location evidence at renewal time without the payer present —
  the card's country and the billing address Stripe holds — recorded on
  `invoice.created` and applied to the draft before it finalizes. That is the
  next step before a quoting cohort renews.
- **Refunds.** Peable does not initiate refunds of subscription invoices (it
  only observes them in `retrieveInvoiceState`), and `tax_transactions` has no
  reversal. A refunded quoted invoice leaves its committed transaction in
  place until tax reversals exist.
