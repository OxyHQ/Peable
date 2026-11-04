# ADR 0016 — Orbit owns its objects; providers are bindings behind them

**Status:** accepted.
**Date:** 2026-11-03.

## Context

Payments already follow this rule: a PaymentIntent is a Peable row with a
`pi_…` public id, and the provider's PaymentIntent and charge are columns on it
(`provider_object_id`, `provider_charge_id`) that never reach the wire.

Billing does not. `/v1/billing/*` accepts and returns the provider's own ids —
`cus_…`, `price_…`, `sub_…`, `in_…`, `cs_test_…` (`services/billing/contracts.ts`)
— and the catalogue is a set of provider Prices created outside Peable and bound by
a script. An integrator therefore integrates with the provider through Peable, a
second provider cannot be added behind the same objects, and the FairCoin rail has
to invent look-alike ids (`cus_fair…`, `sub_fair…`) to fit the shape.

`docs/integrations/payment-provider-boundary.md` already states the product rule:
providers are internal processing integrations, not the platform's identity.

## Decision

1. **Every Orbit resource is a Peable row with a Peable public id**: Customers
   (`cus_`), PaymentMethods (`pm_`), SetupIntents (`seti_`), Products (`prod_`),
   Prices (`price_`), Coupons (`coupon_`), Promotion codes (`promo_`),
   Subscriptions (`sub_`), Invoices (`in_`), Credit notes (`cn_`), Files
   (`file_`), Payouts (`po_`), Balance transactions (`txn_`), Webhook endpoints
   (`we_`), Events (`evt_`). Prefixes join the closed set in `lib/ids.ts`.
2. **A provider object is a binding**, stored internally beside the row —
   `(provider, mode, provider_object_id)` — following the pattern of
   `billing_object_bindings`. Bindings are never serialised. A row keeps the
   provider it was created with; changing the default provider never moves an
   existing object (the provider-boundary rule).
3. **Some ids necessarily collide in shape with the provider's** (`cus_`, `pm_`,
   `price_`). That is deliberate — integrators expect Stripe's vocabulary — and
   safe because Peable's suffix format (24 hex chars) differs and a provider id is
   never accepted where a Peable id is expected: lookups go through
   `find…ByPublicId` scoped to the merchant.
4. **Rails that cannot hold an object answer truthfully.** FairCoin has no stored
   payment method (signing stays on the payer's device), so a FairCoin customer
   has no `pm_`, and a subscription on that rail renews by explicit payer action;
   the API exposes that as a capability, not as a fake object.
5. **The provider-id billing surface (`/v1/billing/*`) is replaced, not kept.**
   Native billing (ADR 0018) takes over everything it serves — Mention Plus and
   the oxy personal plans included — and the routes, contracts and SDK methods
   that pass provider ids are deleted in the same change that moves their
   consumers. No frozen copy remains. (Done 2026-11-04: ADR 0018 §7 as built.)

## Consequences

- Adding a second fiat provider becomes an adapter, not an API change.
- Orbit can list, search, expand and emit events for every object without a
  provider round trip, because the row is the source of truth for what Orbit
  decided and the binding is the source of truth for what the provider did.
- Reconciliation jobs (the `intentReconciliation.ts` and `accountSync.ts` pattern)
  are needed per bound object type, to repair a binding whose provider-side state
  moved while an event was lost.
