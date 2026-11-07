// Quotes (`qt_…`, ADR 0018 §5) — the closed value sets their schemas are built
// from. Zod-free: `@peable.to/shared-types` re-exports them at runtime.

/**
 * Where a quote stands — Stripe's four.
 *
 *  - `draft`    — being written; the only status a quote can be edited in.
 *  - `open`     — finalized: numbered, priced and taxed, waiting for the
 *                 customer's answer until `expires_at`.
 *  - `accepted` — terminal: the native billing engine made its invoice (one-time
 *                 lines) or its subscription and first invoice (recurring lines).
 *  - `canceled` — terminal: cancelled by the merchant, or expired while open.
 */
export const QUOTE_STATUSES = ['draft', 'open', 'accepted', 'canceled'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** Bounds a quote is checked against. */
export const QUOTE_LIMITS = {
  /** Lines on one quote — a subscription's item limit. */
  lineItemsMax: 20,
  quantityMax: 1_000_000,
  /** `header` and `footer`; `description` is 1500 like an invoice's. */
  headerMax: 50,
  footerMax: 500,
  descriptionMax: 1500,
  /** A quote expires 30 days after it is created unless `expires_at` says otherwise (Stripe's default). */
  defaultExpiryDays: 30,
  /** `expires_at` at most this far ahead. */
  expiryMaxDays: 365,
  trialPeriodDaysMax: 730,
} as const;
