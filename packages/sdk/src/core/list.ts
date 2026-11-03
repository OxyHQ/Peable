// One list contract for every listable resource (ADR 0014 D1): a page is
// `{ object: 'list', data, has_more, url }`, and `list()` answers a promise of
// the first page that is ALSO an async iterable over every item, fetching the
// next page only when the caller gets there.
//
//   const page = await peable.paymentIntents.list({ limit: 20 });
//   for await (const intent of peable.paymentIntents.list({ status: 'succeeded' })) { … }
//   const all = await peable.refunds.list().autoPagingToArray({ limit: 500 });

import type { List, ListParams, SearchParams, SearchResult } from '@peable.to/shared-types';
import { PeableAPIError } from './errors';

/** The most `autoPagingToArray` will collect — an upper bound, so a typo is not an OOM. */
export const AUTO_PAGING_ARRAY_MAX = 10_000;

/** Every item across all pages, whatever the page shape. */
export interface AutoPaging<T> extends AsyncIterable<T> {
  /**
   * Call `onItem` for every item, page by page. Returning `false` stops early.
   */
  autoPagingEach(onItem: (item: T) => unknown): Promise<void>;
  /** Collect items, page by page, up to `limit` (required, at most 10 000). */
  autoPagingToArray(options: { limit: number }): Promise<T[]>;
}

/**
 * The first page, and every item across all pages.
 *
 * `L` is the page type — a list may carry fields beside the envelope (a
 * payment's refund list carries `remaining_refundable`).
 */
export interface ApiListPromise<T, L extends List<T> = List<T>> extends Promise<L>, AutoPaging<T> {}

/**
 * The first page of a search, and every match across all pages — a search
 * pages forward over the opaque `next_page` token rather than an id cursor.
 */
export interface ApiSearchPromise<T, R extends SearchResult<T> = SearchResult<T>>
  extends Promise<R>,
    AutoPaging<T> {}

/**
 * The ONE auto-pager: attach iteration to a first-page promise, given the
 * generator that walks from it. A list and a search differ only in how they
 * step to the next page, so that is all each passes.
 */
function autoPaging<P extends Promise<unknown>, T>(
  first: P,
  items: () => AsyncGenerator<T>,
): P & AutoPaging<T> {
  return Object.assign(first, {
    [Symbol.asyncIterator]: items,
    async autoPagingEach(onItem: (item: T) => unknown): Promise<void> {
      for await (const item of items()) {
        if ((await onItem(item)) === false) return;
      }
    },
    async autoPagingToArray(options: { limit: number }): Promise<T[]> {
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new TypeError('autoPagingToArray needs a positive integer limit');
      }
      if (options.limit > AUTO_PAGING_ARRAY_MAX) {
        throw new TypeError(
          `autoPagingToArray collects at most ${AUTO_PAGING_ARRAY_MAX} items; iterate with for await instead`,
        );
      }
      const out: T[] = [];
      for await (const item of items()) {
        out.push(item);
        if (out.length >= options.limit) break;
      }
      return out;
    },
  });
}

/** A gateway answering the same cursor twice would loop forever; say so. */
function stalled(cursor: string): PeableAPIError {
  return new PeableAPIError(`Pagination did not advance past ${cursor}`, {
    code: 'invalid_response',
  });
}

/**
 * Wrap a page fetcher as an `ApiListPromise`.
 *
 * The walk follows the cursor the CALLER chose: with `ending_before` it pages
 * backwards — each page is still newest first on the wire, so its items are
 * yielded in reverse, moving steadily away from the cursor, Stripe's
 * semantics — and otherwise forwards with `starting_after`.
 */
export function listPromise<T extends { id: string }, P extends ListParams, L extends List<T>>(
  fetchPage: (params: P) => Promise<L>,
  params: P,
): ApiListPromise<T, L> {
  const first = fetchPage(params);
  const backwards = params.ending_before !== undefined;

  async function* items(): AsyncGenerator<T> {
    let page: L = await first;
    const cursors = new Set<string>();
    for (;;) {
      yield* backwards ? [...page.data].reverse() : page.data;
      const edge = backwards ? page.data[0] : page.data[page.data.length - 1];
      if (!page.has_more || edge === undefined) return;
      if (cursors.has(edge.id)) throw stalled(edge.id);
      cursors.add(edge.id);
      const { starting_after: _after, ending_before: _before, ...rest } = params;
      page = await fetchPage({
        ...rest,
        ...(backwards ? { ending_before: edge.id } : { starting_after: edge.id }),
      } as P);
    }
  }

  return autoPaging(first, items);
}

/**
 * Wrap a search page fetcher as an `ApiSearchPromise`: each next page is the
 * SAME query with `page` set to the previous answer's `next_page`, until it is
 * `null`.
 */
export function searchPromise<T, P extends SearchParams, R extends SearchResult<T>>(
  fetchPage: (params: P) => Promise<R>,
  params: P,
): ApiSearchPromise<T, R> {
  const first = fetchPage(params);

  async function* items(): AsyncGenerator<T> {
    let page: R = await first;
    const tokens = new Set<string>();
    for (;;) {
      yield* page.data;
      const next = page.next_page;
      if (!page.has_more || next === null) return;
      if (tokens.has(next)) throw stalled(next);
      tokens.add(next);
      page = await fetchPage({ ...params, page: next });
    }
  }

  return autoPaging(first, items);
}

/** The values a query string carries: scalars, and arrays and objects of them, nested. */
export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly QueryValue[]
  | { readonly [key: string]: QueryValue };

function appendQuery(search: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    // `expand[]=a&expand[]=b` for scalars; `lines[0][type]=…` once an item is an object.
    const scalars = value.every((item) => item === null || typeof item !== 'object');
    value.forEach((item, index) => {
      appendQuery(search, scalars ? `${key}[]` : `${key}[${index}]`, item);
    });
  } else if (typeof value === 'object') {
    for (const [sub, inner] of Object.entries(value)) appendQuery(search, `${key}[${sub}]`, inner);
  } else {
    search.append(key, String(value));
  }
}

/**
 * Encode a query the way the gateway reads it (Express's `qs`): an array of
 * scalars as `key[]=v` (`expand[]=a&expand[]=b`), an array of objects by index
 * (`lines[0][type]=…`), an object as `key[sub]=v` (`created[gte]=1`), to any
 * depth. `undefined` and `null` are omitted; keys keep the caller's order.
 */
export function encodeQuery(query: Readonly<Record<string, QueryValue>> | undefined): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) appendQuery(search, key, value);
  return search.toString();
}
