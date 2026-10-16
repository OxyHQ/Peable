# ADR 0010 — Recurring billing rails coexist, and the payer chooses

**Status:** accepted.
**Date:** 2026-10-16.

## The defect

`PEABLE_BILLING_COHORT` configured exactly one recurring-billing rail. Setting
it to `rail: "faircoin"` did not add FairCoin: it REPLACED the live Stripe cohort
(I08, `merch_bd106296a0fef49a861ee6b7`), so every existing Stripe subscriber
would have answered 404 the moment native FairCoin billing was switched on. A
payments platform whose merchants sell through several rails cannot make the
merchant pick one per deployment.

## The decision

1. **A rail is a complete `BillingService` plus routing metadata** —
   `BillingRail` in `services/billing/rails.ts`: which merchants it serves,
   whether it answers tax quotes, its offers, its renewal model (`automatic` for
   a fiat provider, `payer_initiated` for FairCoin) and the patterns of the
   references it mints. `createMultiRailBillingService` is the ONLY billing
   service the routes see; it routes each call to exactly one rail and strips
   the `rail` field before the rail sees the request, so idempotency digests of
   every pre-rails caller are byte-identical.
2. **Configuration lists rails in preference order.**
   `{ "rails": [ { "rail": "stripe", … }, { "rail": "faircoin", … } ] }`, where
   each entry is exactly the single-rail configuration that existed before. The
   old single shapes still parse to one rail. A request naming no rail and no
   existing object goes to the FIRST rail serving the merchant, so adding a rail
   after Stripe changes nothing for Stripe callers.
3. **The payer's choice is the customer's rail.** `GET /v1/billing/rails`
   (`billing.listRails()`) lists the rails a merchant's payers can choose, with
   each rail's offers. `ensureCustomer({ …, rail })` creates the customer on the
   chosen rail; checkouts, subscriptions, invoices, invoice authorities and
   cancellation then route by the object they name. Naming a rail that
   contradicts the object is `identity_conflict`; an object can never move rails.
4. **References are disjoint by construction.** At most one rail may use opaque
   provider ids (Stripe's `cus_…`/`sub_…`/`cs_…`, which predate rails and stay
   valid for live subscribers) — it is the catch-all. Every other rail mints
   namespaced references and declares their exact patterns (FairCoin:
   `cus_fair<64 hex>`, `sub_fair<64 hex>`, `cs_{live,test}_fair<64 hex>`). The
   router refuses a configuration with two opaque rails.
5. **One subscription model.** Every rail answers the same `BillingSubscription`,
   `BillingPaidInvoice`, `BillingInvoiceState` and signed
   `BillingFinalInvoiceAuthority` (`method: card | faircoin`), so a consumer's
   entitlement logic is written once. Tax quotes come from the first serving
   rail that calculates them, unless the request names one.
6. **A further fiat provider plugs in as a rail factory** in
   `RAIL_FACTORIES` (`configuredBilling.ts`): its own provider adapter behind
   `BillingProvider`, namespaced references, and an entry name. No route or
   consumer changes.

## The signing key is a mounted secret file, pinned by its public half

Native billing signs tax quotes and invoice authorities with one Ed25519 key.
The private half lives only in SSM (`/oxy/peable/BILLING_INVOICE_PRIVATE_KEY`)
and reaches the container as a read-only file through oxy-infra's
`app-service` `secret_files` (an init container writes it to a task-scoped
volume); `PEABLE_BILLING_INVOICE_PRIVATE_KEY_FILE` is its path. The public half
is pinned in `@peable.to/shared-types` `PEABLE_BILLING_AUTHORITY_KEYS` (re-exported
by the SDK) by key id. `loadPinnedSigningKey` refuses a key that is not
Ed25519 or whose public half is not pinned, and the FairCoin rail refuses to boot
unless the mounted key's id equals both `invoiceSigningKeyId` and the fiscal
declaration's `keyId`. With no FairCoin rail configured, the gateway only
reports at boot whether the mounted key is usable.

## Consequences

- Activation of native FairCoin next to Stripe is configuration only: append the
  FairCoin entry to `rails`, mount the reviewed fiscal declaration, and set
  `purchasesEnabled` in the consumer.
- `observations`, `relay` and renewal workers are still singular: two rails
  providing them is a boot error until a rail needs its own.
