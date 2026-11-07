// Invoices, invoice items, credit notes and the customer balance (ADR 0018
// §2–4) — the closed value sets their schemas are built from. Zod-free:
// `@peable.to/shared-types` re-exports them at runtime.

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Why an invoice exists. */
export const INVOICE_BILLING_REASONS = [
  'manual',
  'subscription_create',
  'subscription_cycle',
  'subscription_update',
  'subscription_cancel',
  'upcoming',
  // A one-time quote's invoice (Stripe's name); a recurring quote's first
  // invoice is its subscription's `subscription_create`.
  'quote_accept',
] as const;
export type InvoiceBillingReason = (typeof INVOICE_BILLING_REASONS)[number];

/**
 * `automatic_tax.status` — Peable Tax (ADR 0011) is computed before an invoice
 * finalizes (ADR 0018 §2).
 *
 *  - `requires_location_inputs` — the customer's location could not be
 *    established; the invoice cannot finalize until it can.
 *  - `failed`                   — the calculation failed closed (the provider
 *    was unavailable, or disagreed with Peable's registrations); retried.
 *  - `complete`                 — calculated (including `not_registered`,
 *    which is a calculation that collects zero).
 */
export const AUTOMATIC_TAX_STATUSES = ['requires_location_inputs', 'failed', 'complete'] as const;
export type AutomaticTaxStatus = (typeof AUTOMATIC_TAX_STATUSES)[number];

/** Where an invoice line comes from: a subscription item's period, or an invoice item. */
export const INVOICE_LINE_TYPES = ['subscription', 'invoiceitem'] as const;
export type InvoiceLineType = (typeof INVOICE_LINE_TYPES)[number];

/** `pending_invoice_items_behavior` on an invoice create. Default `exclude` (Stripe's). */
export const PENDING_INVOICE_ITEMS_BEHAVIORS = ['include', 'exclude'] as const;
export type PendingInvoiceItemsBehavior = (typeof PENDING_INVOICE_ITEMS_BEHAVIORS)[number];

export const CREDIT_NOTE_STATUSES = ['issued', 'void'] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];

/** `pre_payment` reduces what an open invoice asks for; `post_payment` gives back on a paid one. */
export const CREDIT_NOTE_TYPES = ['pre_payment', 'post_payment'] as const;
export type CreditNoteType = (typeof CREDIT_NOTE_TYPES)[number];

export const CREDIT_NOTE_REASONS = [
  'duplicate',
  'fraudulent',
  'order_change',
  'product_unsatisfactory',
] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];

/** A credit note line: part of an invoice line, or a custom amount. */
export const CREDIT_NOTE_LINE_TYPES = ['invoice_line_item', 'custom_line_item'] as const;
export type CreditNoteLineType = (typeof CREDIT_NOTE_LINE_TYPES)[number];

export const CUSTOMER_BALANCE_TRANSACTION_TYPES = [
  'adjustment',
  'applied_to_invoice',
  'credit_note',
  'invoice_overpaid',
  'unapplied_from_invoice',
] as const;
export type CustomerBalanceTransactionType = (typeof CUSTOMER_BALANCE_TRANSACTION_TYPES)[number];

/** The rails a hosted invoice is paid on: a card through the provider's fields, FairCoin from the payer's wallet. */
export const PUBLIC_INVOICE_PAYMENT_METHOD_TYPES = ['card', 'faircoin'] as const;
export type PublicInvoicePaymentMethodType = (typeof PUBLIC_INVOICE_PAYMENT_METHOD_TYPES)[number];
