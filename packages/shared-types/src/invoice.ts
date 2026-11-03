// Invoices (`in_…`), their lines (`il_…`), invoice items (`ii_…`) and credit
// notes (`cn_…`) — Orbit's native billing engine (ADR 0018).
//
// ## Signed amounts
//
// Every amount is a base-unit STRING (ADR 0014 D1). Most are never negative;
// the ones documented as SIGNED may start with `-`: a proration credit line,
// an invoice whose credits exceed its charges, and a customer balance (where
// negative is credit the customer holds, Stripe's convention). A signed amount
// still has exactly one spelling: no `+`, no `-0`, no leading zeros.
import type { CollectionMethod, Discount, DiscountParams, Subscription } from './subscription';
import type { Customer } from './customer';
import type { ListParams, RangeQuery } from './list';
import type { CurrencyCode } from './money';
import type { PaymentIntent } from './paymentIntent';
import type { Price, PriceDataParams } from './catalog';

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

/** One tax amount on a line. `amount` is SIGNED (a credit line carries negative tax). */
export interface InvoiceTaxAmount {
  amount: string;
  inclusive: boolean;
  /** The Peable Tax calculation (`taxcalc_…`) it came from, or `null` for a derived credit. */
  tax_calculation: string | null;
  taxability_reason: string | null;
}

export interface InvoiceLineItem {
  id: string;
  object: 'line_item';
  livemode: boolean;
  invoice: string;
  type: 'subscription' | 'invoiceitem';
  /** SIGNED: before discounts; tax-inclusive when the price is. */
  amount: string;
  currency: CurrencyCode;
  description: string | null;
  discount_amounts: { amount: string; discount: string }[];
  discountable: boolean;
  period: { start: number; end: number };
  price: Price | null;
  quantity: number | null;
  proration: boolean;
  subscription: string | null;
  subscription_item: string | null;
  invoice_item: string | null;
  tax_amounts: InvoiceTaxAmount[];
  metadata: Record<string, string>;
}

export interface Invoice {
  id: string;
  object: 'invoice';
  livemode: boolean;
  /** `null` while a draft; `PREFIX-0001` once finalized — gapless per merchant. */
  number: string | null;
  customer: string | Customer;
  customer_email: string | null;
  customer_name: string | null;
  subscription: string | Subscription | null;
  status: InvoiceStatus;
  billing_reason: InvoiceBillingReason;
  collection_method: CollectionMethod;
  currency: CurrencyCode;
  description: string | null;
  auto_advance: boolean;
  /** When a draft with `auto_advance` will finalize. */
  automatically_finalizes_at: number | null;
  lines: { object: 'list'; data: InvoiceLineItem[]; has_more: boolean; url: string };
  /** SIGNED. Sum of the lines before discounts. */
  subtotal: string;
  /** SIGNED. `subtotal` less the tax included in it (inclusive prices). */
  subtotal_excluding_tax: string;
  total_discount_amounts: { amount: string; discount: string }[];
  discount: Discount | null;
  /** SIGNED; `null` on a draft whose tax is not calculated yet. */
  tax: string | null;
  /** SIGNED. */
  total: string;
  /** SIGNED. */
  total_excluding_tax: string;
  /** SIGNED: the customer's balance applied when it finalized. */
  starting_balance: string;
  /** SIGNED: what the customer's balance became; `null` until finalized. */
  ending_balance: string | null;
  amount_due: string;
  amount_paid: string;
  amount_remaining: string;
  pre_payment_credit_notes_amount: string;
  post_payment_credit_notes_amount: string;
  attempt_count: number;
  attempted: boolean;
  next_payment_attempt: number | null;
  due_date: number | null;
  days_until_due: number | null;
  period_start: number;
  period_end: number;
  payment_intent: string | PaymentIntent | null;
  default_payment_method: string | null;
  automatic_tax: {
    enabled: boolean;
    status: AutomaticTaxStatus | null;
    /** The Peable Tax calculation (`taxcalc_…`) the invoice finalized with. */
    tax_calculation: string | null;
  };
  /** The payer-facing page (anonymous, an unguessable token); `null` while a draft. */
  hosted_invoice_url: string | null;
  /** The PDF of the same; `null` while a draft. */
  invoice_pdf: string | null;
  last_finalization_error: { code: string; message: string } | null;
  status_transitions: {
    finalized_at: number | null;
    paid_at: number | null;
    voided_at: number | null;
    marked_uncollectible_at: number | null;
  };
  paid_out_of_band: boolean;
  test_clock: string | null;
  metadata: Record<string, string>;
  created: number;
  effective_at: number | null;
}

/** What `DELETE /v1/invoices/:id` (a draft) answers. */
export interface DeletedInvoice {
  id: string;
  object: 'invoice';
  deleted: true;
}

export interface CreateInvoiceParams {
  customer: string;
  /** Default: the subscription's, else the customer's billing currency. */
  currency?: CurrencyCode;
  subscription?: string;
  auto_advance?: boolean;
  collection_method?: CollectionMethod;
  days_until_due?: number;
  /** Unix seconds; `send_invoice` only. */
  due_date?: number;
  description?: string;
  default_payment_method?: string;
  discounts?: DiscountParams[];
  automatic_tax?: { enabled: boolean };
  /** Pull the customer's pending invoice items in. Default `exclude` (Stripe's). */
  pending_invoice_items_behavior?: 'include' | 'exclude';
  metadata?: Record<string, string>;
}

/** `POST /v1/invoices/:id` — drafts only, except `metadata` and `auto_advance`. */
export interface UpdateInvoiceParams {
  auto_advance?: boolean;
  collection_method?: CollectionMethod;
  days_until_due?: number;
  due_date?: number;
  description?: string | '';
  default_payment_method?: string | '';
  discounts?: DiscountParams[] | '';
  automatic_tax?: { enabled: boolean };
  metadata?: Record<string, string>;
}

export interface InvoiceListParams extends ListParams {
  customer?: string;
  subscription?: string;
  status?: InvoiceStatus;
  collection_method?: CollectionMethod;
  due_date?: number | RangeQuery;
}

export interface FinalizeInvoiceParams {
  auto_advance?: boolean;
}

export interface PayInvoiceParams {
  /** A saved `pm_…` of the customer; defaults to the invoice's, then the subscription's, then the customer's. */
  payment_method?: string;
  /** Record a payment made outside Orbit. */
  paid_out_of_band?: boolean;
  /** Default true: the customer is not present. */
  off_session?: boolean;
}

/** `GET /v1/invoices/upcoming` — a preview, never stored. */
export interface UpcomingInvoiceParams {
  customer: string;
  subscription?: string;
  /** Preview a change: the items it would have. */
  subscription_items?: { id?: string; price?: string; quantity?: number; deleted?: boolean }[];
  subscription_proration_behavior?: 'create_prorations' | 'none' | 'always_invoice';
  subscription_proration_date?: number;
}

export interface InvoiceItem {
  id: string;
  object: 'invoiceitem';
  livemode: boolean;
  customer: string | Customer;
  /** The draft it is on, or `null` while pending. */
  invoice: string | Invoice | null;
  subscription: string | Subscription | null;
  subscription_item: string | null;
  price: Price | null;
  quantity: number;
  /** Base units per unit; `null` for a proration (an amount for a period, not per unit). */
  unit_amount: string | null;
  /** SIGNED (an engine-made proration credit is negative). */
  amount: string;
  currency: CurrencyCode;
  description: string | null;
  discountable: boolean;
  period: { start: number; end: number };
  proration: boolean;
  metadata: Record<string, string>;
  date: number;
}

export interface DeletedInvoiceItem {
  id: string;
  object: 'invoiceitem';
  deleted: true;
}

/**
 * `POST /v1/invoiceitems`. A price (`price` or `price_data`) times `quantity`,
 * or a fixed `amount` + `currency`. Never negative — a credit is a credit note
 * or a customer balance transaction.
 */
export interface CreateInvoiceItemParams {
  customer: string;
  invoice?: string;
  subscription?: string;
  price?: string;
  price_data?: PriceDataParams;
  quantity?: number;
  amount?: string;
  currency?: CurrencyCode;
  description?: string;
  discountable?: boolean;
  period?: { start: number; end: number };
  metadata?: Record<string, string>;
}

export interface UpdateInvoiceItemParams {
  description?: string | '';
  quantity?: number;
  discountable?: boolean;
  metadata?: Record<string, string>;
}

export interface InvoiceItemListParams extends ListParams {
  customer?: string;
  invoice?: string;
  /** Only items not on any invoice yet. */
  pending?: boolean;
}

// ---- Credit notes -------------------------------------------------------------

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

export interface CreditNoteLineItem {
  id: string;
  object: 'credit_note_line_item';
  type: 'invoice_line_item' | 'custom_line_item';
  invoice_line_item: string | null;
  description: string | null;
  quantity: number | null;
  /** Before tax; tax-inclusive when the invoice line is. */
  amount: string;
  tax_amount: string;
}

export interface CreditNote {
  id: string;
  object: 'credit_note';
  livemode: boolean;
  /** `<invoice number>-CN-<nn>`. */
  number: string;
  invoice: string | Invoice;
  customer: string | Customer;
  status: CreditNoteStatus;
  type: CreditNoteType;
  reason: CreditNoteReason | null;
  currency: CurrencyCode;
  lines: { object: 'list'; data: CreditNoteLineItem[]; has_more: boolean; url: string };
  subtotal: string;
  tax: string;
  /** What is credited, tax included. */
  total: string;
  /** Of `total`: refunded through the invoice's payment. */
  refund_amount: string;
  /** Of `total`: credited to the customer balance. */
  credit_amount: string;
  /** Of `total`: recorded as returned outside Orbit. */
  out_of_band_amount: string;
  /** The Refund (`re_…`) when part of it was refunded. */
  refund: string | null;
  customer_balance_transaction: string | null;
  memo: string | null;
  metadata: Record<string, string>;
  voided_at: number | null;
  created: number;
}

/**
 * `POST /v1/credit_notes` (and `GET /v1/credit_notes/preview` with the same
 * fields as a query). Credit `lines`, or a whole `amount` (custom).
 *
 * On a `paid` invoice the credit must be distributed: `refund_amount` (through
 * the invoice's payment; card only), `credit_amount` (to the customer balance)
 * and `out_of_band_amount` must add up to the total. Omitted, all of it is
 * refunded on a card invoice and credited to the balance otherwise. On an
 * `open` invoice it reduces `amount_due` and none of the three apply.
 */
export interface CreateCreditNoteParams {
  invoice: string;
  lines?: {
    type: 'invoice_line_item' | 'custom_line_item';
    invoice_line_item?: string;
    /** For an invoice line: the amount of it to credit (default all of it). */
    amount?: string;
    quantity?: number;
    description?: string;
  }[];
  /** Credit this much of the invoice, tax included, spread over its lines. */
  amount?: string;
  reason?: CreditNoteReason;
  memo?: string;
  refund_amount?: string;
  credit_amount?: string;
  out_of_band_amount?: string;
  metadata?: Record<string, string>;
}

export interface CreditNoteListParams extends ListParams {
  invoice?: string;
  customer?: string;
}

// ---- Customer balance ----------------------------------------------------------

export const CUSTOMER_BALANCE_TRANSACTION_TYPES = [
  'adjustment',
  'applied_to_invoice',
  'credit_note',
  'invoice_overpaid',
  'unapplied_from_invoice',
] as const;
export type CustomerBalanceTransactionType = (typeof CUSTOMER_BALANCE_TRANSACTION_TYPES)[number];

/** One movement of a customer's balance. Negative is credit the customer holds. */
export interface CustomerBalanceTransaction {
  id: string;
  object: 'customer_balance_transaction';
  livemode: boolean;
  customer: string | Customer;
  type: CustomerBalanceTransactionType;
  /** SIGNED. */
  amount: string;
  currency: CurrencyCode;
  /** SIGNED: the balance after this transaction. */
  ending_balance: string;
  description: string | null;
  invoice: string | Invoice | null;
  credit_note: string | null;
  metadata: Record<string, string>;
  created: number;
}

/** `POST /v1/customers/:id/balance_transactions` — an adjustment. */
export interface CreateCustomerBalanceTransactionParams {
  /** SIGNED: negative credits the customer, positive debits. */
  amount: string;
  currency: CurrencyCode;
  description?: string;
  metadata?: Record<string, string>;
}

/** A payer-facing invoice, as `GET /v1/invoices/public/:token` answers it. */
export interface PublicInvoice {
  object: 'public_invoice';
  livemode: boolean;
  number: string | null;
  status: InvoiceStatus;
  currency: CurrencyCode;
  merchant: { name: string | null; avatar_url: string | null };
  customer_name: string | null;
  customer_email: string | null;
  description: string | null;
  lines: {
    description: string | null;
    quantity: number | null;
    amount: string;
    period: { start: number; end: number };
    proration: boolean;
  }[];
  subtotal: string;
  total_discount: string;
  tax: string | null;
  total: string;
  amount_due: string;
  amount_paid: string;
  amount_remaining: string;
  due_date: number | null;
  created: number;
  finalized_at: number | null;
  paid_at: number | null;
  /** Which rail pays it: a card through the provider's fields, FairCoin from the payer's wallet. */
  payment_method_types: ('card' | 'faircoin')[];
  invoice_pdf: string;
}

/**
 * What `POST /v1/invoices/public/:token/pay` answers: the PaymentIntent the
 * payer completes on the hosted checkout (`/i/:id#client_secret=…`) — a card
 * through the provider's own fields, FairCoin from the payer's wallet. The
 * same invoice always answers the same intent while it can still be paid.
 */
export interface PublicInvoicePayment {
  object: 'public_invoice_payment';
  payment_intent: string;
  /** The intent's payer credential (`pi_…_secret_…`), as a payment link hands out. */
  client_secret: string;
}
