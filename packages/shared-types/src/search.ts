// The search contract (Stripe's Search API): `GET /v1/<objects>/search?query=…`.

/**
 * One page of a search.
 *
 * Unlike a {@link List} it pages FORWARD only, by an opaque `next_page` token
 * passed back as `page`: a search is a filter over the newest-first walk of the
 * resource, and the token remembers both where the walk stopped and which
 * query it belongs to (a token used with another query is refused).
 */
export interface SearchResult<T> {
  object: 'search_result';
  data: T[];
  has_more: boolean;
  /** Pass as `page` for the next page; `null` on the last one. */
  next_page: string | null;
  /** The path that was searched (`/v1/customers/search`). */
  url: string;
  /** Present only when asked for with `expand: ['total_count']`. */
  total_count?: number;
}

/** The parameters every search accepts. */
export interface SearchParams {
  /**
   * The query, in Stripe's search query language:
   * `email:"jenny@example.com"`, `amount>1000 AND currency:"EUR"`,
   * `metadata['order_id']:'6735'`, `name~"shirt"`, `-status:"canceled"`,
   * `customer:null`. Clauses join with spaces or `AND` (all of them must
   * match) or with `OR` (any), never both; at most 10 clauses and 1000
   * characters.
   */
  query: string;
  /** 1–100. Default 10. */
  limit?: number;
  /** The `next_page` of the previous page, with the SAME query. */
  page?: string;
  /**
   * `data.`-prefixed expansions (`['data.customer']`), and `'total_count'` to
   * count every match (one extra query).
   */
  expand?: string[];
}

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

/** Search query bounds — the gateway's, restated so a client can check before it asks. */
export const SEARCH_QUERY_MAX_LENGTH = 1000;
export const SEARCH_QUERY_MAX_CLAUSES = 10;
/** A `~` substring needs at least this many characters (Stripe's rule). */
export const SEARCH_SUBSTRING_MIN_LENGTH = 3;
