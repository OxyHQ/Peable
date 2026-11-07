// Quotes (`qt_…`) — Orbit's native billing engine (ADR 0018 §5). The wire
// types are the contract's (`@peable.to/contracts`), re-exported here as
// types; the closed value sets come from the zod-free
// `@peable.to/contracts/vocabulary`. A quote's lines are Stripe's `item`
// (`CheckoutLineItem`), the same object a Checkout Session's lines are.

export { QUOTE_LIMITS, QUOTE_STATUSES, type QuoteStatus } from '@peable.to/contracts/vocabulary';

export type {
  CreateQuoteParams,
  FinalizeQuoteParams,
  Quote,
  QuoteActionParams,
  QuoteLineItemListParams,
  QuoteListParams,
  UpdateQuoteParams,
} from '@peable.to/contracts';
