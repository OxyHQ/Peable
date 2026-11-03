import { createHash } from 'node:crypto';

/**
 * The `page` / `next_page` token of a search.
 *
 * A search pages over the same newest-first keyset walk as every list
 * (`db/keyset.ts`): the token holds where the walk stopped — the primary key of
 * the last row answered, the `starting_after` of a list — and a fingerprint of
 * the resource and query it was minted for.
 *
 * - **Bound to its query.** A token reused with another query (or another
 *   resource) is refused rather than silently applied: page 2 of one search is
 *   not a position in another.
 * - **Opaque, not secret.** The token is base64url text, not a signature. A
 *   forged one can only move the walk's starting point INSIDE the caller's own
 *   scope — the merchant predicate is the repository's and is never in the
 *   token — so there is nothing to protect by signing it.
 * - **Stable across deletions.** It carries the key itself rather than a public
 *   id to resolve, so a page boundary on a row deleted since (a product) still
 *   pages on, where a resolution would fail.
 */

const VERSION = 'v1';
/** A uuid v7 primary key, as `generatedId()` writes it. */
const PRIMARY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fingerprint(resource: string, query: string): string {
  return createHash('sha256').update(`${resource}\n${query}`).digest('base64url').slice(0, 22);
}

export function encodeSearchPage(resource: string, query: string, after: string): string {
  return Buffer.from(`${VERSION}.${fingerprint(resource, query)}.${after}`, 'utf8').toString(
    'base64url',
  );
}

export type DecodedSearchPage =
  | { readonly ok: true; readonly after: string }
  | { readonly ok: false; readonly message: string };

export function decodeSearchPage(
  resource: string,
  query: string,
  token: string,
): DecodedSearchPage {
  const text = /^[A-Za-z0-9_-]{1,200}$/.test(token)
    ? Buffer.from(token, 'base64url').toString('utf8')
    : '';
  const [version, print, after, ...rest] = text.split('.');
  if (version !== VERSION || print === undefined || after === undefined || rest.length > 0) {
    return { ok: false, message: 'page is not a next_page this API returned' };
  }
  if (!PRIMARY_KEY.test(after)) {
    return { ok: false, message: 'page is not a next_page this API returned' };
  }
  if (print !== fingerprint(resource, query)) {
    return {
      ok: false,
      message: 'page belongs to a different query; pass the query it was returned with',
    };
  }
  return { ok: true, after };
}
