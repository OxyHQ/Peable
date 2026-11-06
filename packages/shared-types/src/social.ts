// Social-receive and transaction-enrichment contracts — the wallet's routes.
// The wire types are the contract's (`@peable.to/contracts` `socialRoutes`),
// re-exported here as types; the bounds a request is refused for are the
// contract's zod-free vocabulary (the column CHECKs read the same numbers).
export type {
  EnrichmentResult,
  EnrichRequest,
  EnrichResponse,
  SocialNextAddressRequest,
  SocialNextAddressResponse,
  SocialPayment,
  SocialPaymentSource,
  SocialPaymentsParams,
  SocialPaymentsResponse,
  SocialReceiveAddress,
  SocialReceiveAddressesParams,
  SocialReceiveAddressesResponse,
  SocialReceiveCursorParams,
  SocialReceiveCursorResponse,
} from '@peable.to/contracts';
export {
  ENRICH_MAX_ADDRESSES,
  ENRICHMENT_KINDS,
  type EnrichmentKind,
  SOCIAL_PAYMENT_DIRECTIONS,
  SOCIAL_RECEIVE_ADDRESSES_PAGE_DEFAULT,
  SOCIAL_RECEIVE_ADDRESSES_PAGE_MAX,
  SOCIAL_SOURCE_APP_MAX_LENGTH,
  SOCIAL_SOURCE_REF_MAX_LENGTH,
  type SocialPaymentDirection,
} from '@peable.to/contracts/vocabulary';
