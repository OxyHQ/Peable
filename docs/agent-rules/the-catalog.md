<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# The catalog (ADR 0018)

Products, prices, coupons and promotion codes are Orbit rows with no provider
binding. The four resource files list their routes once as data
(`routes/catalog.ts`); `catalogRoutes.ts` mounts that list on `/v1/*` AND on the
dashboard, so the two surfaces cannot drift. Every write goes through
`services/catalog/catalogService.ts`, which commits the row with its event.
**A price never changes what it charges** — only `active`, `nickname`,
`metadata`, `lookup_key` and an `unspecified` `tax_behavior` move; a new amount
is a new price. **Amounts come from `services/catalog/pricing.ts` only** (pure,
bigint, half-up percent discounts, Stripe's graduated/volume tiers): checkout,
invoices and renewals must call it, never re-derive. A coupon id is never
reused (deleted coupons are tombstones), a promotion code is unique among
ACTIVE codes case-insensitively, and there is no `price.deleted` /
`promotion_code.deleted` — those objects are archived, not deleted.

