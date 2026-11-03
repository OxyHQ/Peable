// List and search bounds (ADR 0014 D1) — the gateway's, restated so a client
// can check before it asks.

export const LIST_LIMIT_DEFAULT = 10;
export const LIST_LIMIT_MAX = 100;

export const SEARCH_QUERY_MAX_LENGTH = 1000;
export const SEARCH_QUERY_MAX_CLAUSES = 10;
/** A `~` substring needs at least this many characters (Stripe's rule). */
export const SEARCH_SUBSTRING_MIN_LENGTH = 3;

/** Every searchable resource, by its path segment (`/v1/<resource>/search`). */
export const SEARCHABLE_RESOURCES = [
  'payment_intents',
  'charges',
  'customers',
  'products',
  'prices',
  'refunds',
  'subscriptions',
  'invoices',
] as const;
export type SearchableResource = (typeof SEARCHABLE_RESOURCES)[number];
