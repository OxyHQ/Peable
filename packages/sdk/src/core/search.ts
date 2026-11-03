// Search (Stripe's Search API): `GET /v1/<resource>/search?query=…`, one
// helper for every searchable resource so none spells the query, the page token
// or the auto-pagination differently.
//
//   const page = await peable.customers.search({ query: 'email:"jenny@example.com"' });
//   for await (const intent of peable.paymentIntents.search({
//     query: "status:'succeeded' AND metadata['order_id']:'6735'",
//   })) { … }

import type { SearchableResource, SearchParams, SearchResult } from '@peable.to/shared-types';
import type { RestClient } from './client';
import { type ApiSearchPromise, searchPromise, searchQuery } from './list';

/** Search one resource; the answer is a page promise and an async iterable over every match. */
export function searchResource<T>(
  client: RestClient,
  resource: SearchableResource,
  params: SearchParams,
): ApiSearchPromise<T> {
  return searchPromise(
    (page: SearchParams) =>
      client.request<SearchResult<T>>('GET', `/v1/${resource}/search`, {
        query: searchQuery(page),
      }),
    params,
  );
}
