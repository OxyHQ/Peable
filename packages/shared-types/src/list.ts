// The one list contract (ADR 0014 D1), for every list endpoint.

/**
 * One page of a list, newest first.
 *
 * `url` is the path that was listed (`/v1/payment_intents`,
 * `/v1/payment_intents/pi_…/refunds`), so a page carries enough to fetch the
 * next one without the caller remembering where it came from.
 */
export interface List<T> {
  object: 'list';
  data: T[];
  /** Whether another page exists in the direction this one was read. */
  has_more: boolean;
  url: string;
}

/**
 * A range over an integer Unix-seconds field, Stripe's `created[gt]=…` form.
 * Each bound is optional; together they are a conjunction.
 */
export interface RangeQuery {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

/** The parameters every list accepts. A route adds its own filters beside them. */
export interface ListParams {
  /** 1–100. Default 10. */
  limit?: number;
  /**
   * The id of the LAST object of the previous page: the next page is the
   * objects older than it. Mutually exclusive with `ending_before`.
   */
  starting_after?: string;
  /**
   * The id of the FIRST object of the current page: the page returned is the
   * objects newer than it, still newest first, with `has_more` saying whether
   * there are newer ones still.
   */
  ending_before?: string;
  /** Exactly this second (`number`), or a range. Unix seconds. */
  created?: number | RangeQuery;
  /**
   * Expand references into objects, `data.`-prefixed on a list
   * (`['data.payment_intent']`). At most four levels deep.
   */
  expand?: string[];
}

/** The parameter a single read or write accepts to expand its answer. */
export interface ExpandParams {
  /** Dot paths, at most four levels deep (`['payment_intent.connected_account']`). */
  expand?: string[];
}
