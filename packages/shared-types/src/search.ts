// The search contract (Stripe's Search API): `GET /v1/<objects>/search?query=…`
// — the contract's (`@peable.to/contracts` `searchResultOf` / `searchQuery`).
export type { SearchParams, SearchResult } from '@peable.to/contracts';
export {
  SEARCH_QUERY_MAX_CLAUSES,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_SUBSTRING_MIN_LENGTH,
  SEARCHABLE_RESOURCES,
  type SearchableResource,
} from '@peable.to/contracts/vocabulary';
