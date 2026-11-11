<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# The billing engine (ADR 0018)

Native subscriptions, invoices, credit notes, customer balances, test clocks,
dunning settings, meters, entitlements and the customer portal
(`services/billingEngine/*`, routes in `routes/billingEngine/*`, mounted on the
API and the dashboard from one list). It is Orbit's only recurring billing:
the Stripe-Billing proxy (`/v1/billing/*` beyond meters, `services/billing/*`,
the FX-quoted FairCoin rail, signed tax quotes and invoice authorities) was
retired at the root with nothing to migrate (ADR 0018 "as built"); never
rebuild a provider-billed subscription beside it. Invariants:

- **Every status change is `transitionSubscription` / `transitionInvoice`**
  (`transitions.ts`): state machine, CAS on the status read, event and
  entitlement refresh in the caller's transaction. Never write `status` any
  other way.
- **An invoice moves WITH its payment**: `transitionIntent` calls
  `onInvoicePaymentTransition` in the intent's transaction. Link a card intent
  to its invoice BEFORE confirming it (`collect.ts`), or the hook misses it.
- **Tax is computed before finalize and fails closed** (`invoiceTax.ts`); a
  subscription's first invoice is priced and taxed before any row is written.
  Never finalize at zero because a calculation failed.
- **Never `new Date()` in the engine**: `engineNow(db, testClockId)` is the
  customer's clock (a test clock's frozen time in test mode).
- **FairCoin is never debited**: FAIR subscriptions and invoices are
  `send_invoice` (CHECKed) and paid by the payer on the hosted invoice page.
  Every fiat invoice offers FairCoin too (`payerIntentForInvoice(invoice,
  method)`, quoted; `amount_paid` is the quote's fiat amount), and a fiat
  subscription whose FIRST invoice was paid in FairCoin becomes `send_invoice`
  (`invoiceFaircoinSubscription`) — the payer pays each period.
- **Entitlements are the access answer**: features attached to products,
  active while a granting product is on a `trialing`/`active`/`past_due`
  subscription — Mention Plus through Plus OR Oxy One is one entitlement.
- Amounts only from `services/catalog/pricing.ts` + `invoiceMath.ts`; proration
  from `periods.ts`. Mail only through Orbit's email outbox (`services/email`,
  owed in the change's transaction; `invoice.sent` only once the relay took it).
  Checkout's `mode: 'subscription'` is the engine's (`checkoutFulfiller.ts`).
- **Quotes (`qt_…`) are the engine's too** (`services/billingEngine/quotes.ts`):
  `transitionQuote` is their one status writer (CAS + `quote.*` event); only a
  draft is edited; a line is `itemPeriodAmount`, the discount `discountsFor`,
  and finalize taxes them with `prepareInvoice` — failing closed, the quote
  stays a draft. Accepting LOCKS the quote first and moves it to `accepted` in
  the transaction that creates its invoice (one-time lines, `quote_accept`) or
  its subscription (`createSubscription`'s internal `inTransaction` hook; the
  one-time lines ride the first invoice as `addInvoiceItems`), so a second
  accept writes nothing. The discount is validated on the draft and redeemed
  only at acceptance; open quotes expire in the scheduler's pass on the
  customer's clock; numbers are one upsert (`claimQuoteNumber`).
