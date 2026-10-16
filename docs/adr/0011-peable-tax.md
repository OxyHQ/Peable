# ADR 0011 — Peable Tax: registrations decide, a provider calculates, every rail applies it

**Status:** accepted.
**Date:** 2026-10-16.

## The defect

Peable had no tax calculation. A FairCoin quote was priced from a static,
operator-mounted fiscal declaration (`PEABLE_BILLING_FISCAL_FILE`) holding
hand-reviewed per-country rates, and from location "evidence" listed in the same
file. Nothing produced that file, `config/oxy-fiscal-intent.json` stated in
prose that it could not, and activating any merchant meant an engineer writing
tax tables. That is neither a platform feature nor correct: rates change,
registrations change, and a customer's location is a fact about a sale, not a
deployment setting.

## The decision

Peable Tax, shaped like Stripe Tax and independent of the settlement rail.

1. **Per merchant settings and registrations.** `tax_settings` holds the
   seller's legal name, head office, default product tax code and tax behavior,
   and the owner's approval. `tax_registrations` holds where the merchant is
   registered: country, subdivision, scheme (`standard`, `simplified`,
   `eu_oss_union`, `eu_oss_non_union`, `us_state_sales_tax`, `ca_provincial`),
   the government number, effective dates. A registration covers a sale only
   once the owner approved it. Any settings edit returns them to draft.
2. **The owner approves, in the dashboard.** `POST
   /v1/dashboard/applications/:id/tax/approve` needs oxy-api's `billing:manage`
   on the application; reading needs `billing:read`. A service credential can
   read settings, record evidence, calculate and report, never approve. The
   Peable app's *Business tax* screen is that dashboard.
3. **Peable decides whether; a provider says how much.** For each sale Peable
   resolves the customer's location from evidence, finds an approved
   registration covering it, and only then asks the `TaxProvider`. No covering
   registration → zero tax, `collection: "not_registered"`, recorded as such —
   deterministic, no provider call. The nontaxable code → `nontaxable`.
4. **Fail closed.** A covered sale whose provider is missing, unreachable,
   inconsistent, unsupported, or answers `not_collecting` (Peable says
   registered, the provider says not) is refused (`tax_calculation_unavailable`,
   `tax_provider_registration_mismatch`). Under-collecting silently is the one
   outcome that is never acceptable.
5. **Stripe Tax is the first provider**, through the Tax Calculation API, which
   prices a sale without a Stripe payment and so serves FairCoin as well as
   cards. Stripe Tax collects only where the Stripe account is registered, so
   approval mirrors the head office and each registration onto the provider
   account (`ensureHeadOffice`, `syncRegistration`, idempotent by content) and
   ending one ends the mirror unless another merchant on that account still
   holds it. The platform's provider account belongs to Oxy's legal entity, so
   only applications oxy-api marks official (or first-party/internal/system)
   calculate on it (`calculationAccount: "platform"`); any other merchant's
   registrations cannot be approved until it has a provider of its own. One
   key, one mode: a test merchant never reaches a live provider account.
6. **Location evidence follows the customer's jurisdiction.** Items name a
   country (billing address, IP address with its resolved country, payment
   method, bank, SIM, landline). Language, currency, locale and timezone are not
   accepted at all. EU member states and the UK need two agreeing kinds of
   evidence; the US and Canada need a billing address with state/province and
   postal code; elsewhere one item, the billing address preferred. An IP
   address is kept only as a salted hash. Evidence lives 24 hours: a renewal
   brings its own.
7. **Amounts are frozen.** A calculation (`taxcalc_…`) stores its exact answer,
   lines and breakdown. Inclusive: the listed price is what the payer pays.
   Exclusive: tax is added and the payer pays price plus tax — on FairCoin the
   FX quote converts that total.
8. **Billing quotes and invoices name Peable Tax objects** without changing
   their signed shape: `taxRateEvidenceId` is the calculation,
   `coverageEvidenceId` the registration (or `not_registered` / `nontaxable`),
   `customerLocationEvidenceId` the evidence, `taxServiceRef` `peable_tax`, the
   seller/issuer/remitter the merchant. `?include=tax_lines` on a FairCoin
   invoice authority adds the frozen tax lines inside the signature; without it
   the authority is byte-for-byte the 0.3.x shape.
9. **Reporting.** When a FairCoin payment is accepted, its calculation becomes
   a `tax_transaction` in the same transaction as the acceptance. `GET
   /v1/tax/transactions` lists them; `GET /v1/tax/reports/summary`
   (`?format=csv`) totals them per jurisdiction, registration, tax type and rate
   for filings.

## What this replaces

`PEABLE_BILLING_FISCAL_FILE`, `configuredFiscalAuthority.ts` and
`config/oxy-fiscal-intent.json` are gone. The FairCoin rail's
`taxQuoteAdapterRef` is `"peable_tax"`. A merchant's approved tax settings are
the commercial gate, checked per quote: activation is the owner entering
registrations and approving, not a deployment.

## Not decided here

- The card rail's signed quote and fiscal checkout (charging a frozen Peable
  Tax amount through Stripe Checkout) still need a `BillingTaxCheckoutAdapter`
  and the rail's offers. `/v1/tax/calculations` already prices card sales with
  the same engine.
- Refunds on the FairCoin rail do not exist yet, so there is no tax reversal.
- Which registrations a seller needs is a legal question, never code.
