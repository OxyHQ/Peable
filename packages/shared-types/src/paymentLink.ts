// Payment Link (Orbit Phase 3) — Stripe's model: a shareable URL over catalog
// PRICES. A payer visiting it creates a Checkout Session with the link's line
// items and options; the session creates the payment when the payer confirms.
//
// The wire types are the contract's (`@peable.to/contracts`
// `paymentLinkSchema`), re-exported as types.
export { PAYMENT_LINK_LIMITS } from '@peable.to/contracts/vocabulary';
export type {
  CheckoutAdjustableQuantity,
  CreatePaymentLinkParams,
  CreatePaymentLinkSessionParams,
  ListPaymentLinksParams,
  PaymentLink,
  PaymentLinkAfterCompletionParams,
  PaymentLinkLineItemParams,
  PaymentLinkSessionStart,
  PublicPaymentLink,
  UpdatePaymentLinkParams,
} from '@peable.to/contracts';
