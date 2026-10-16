// Browser entry (`@peable.to/sdk/contributions`) — organization contribution
// management over a caller-supplied transport (the wallet's Oxy linked client).
// Deliberately separate from the server entry, which carries the merchant-authed
// service-token and billing-verification code (`node:crypto`) a browser or
// React Native bundle must never pull in.
export { ContributionsResource, type ContributionScope } from './resources/contributions';
export type { RestClient, RestClientRequestOptions } from './core/client';
