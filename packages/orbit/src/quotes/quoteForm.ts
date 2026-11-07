import type {
  CollectionMethod,
  CreateQuoteParams,
  Price,
  Quote,
  QuoteStatus,
  UpdateQuoteParams,
} from '@peable.to/shared-types';
import type { StatusTone } from '../payments/status';
import type { LinkPriceChoice } from '../links/linkForm';

/**
 * The quote builder as pure data (ADR 0018 §5): the form a screen edits, every
 * rule the gateway would refuse checked here first, the exact request bodies,
 * and what a quote's status allows.
 *
 * The value sets and bounds are restated rather than imported: the
 * `@peable.to/shared-types` root barrel also exports the `node:crypto` webhook
 * signer, which a browser bundle cannot load. `quoteForm.test.ts` pins each one
 * to its shared-types original.
 */

export const ORBIT_QUOTE_STATUSES: readonly QuoteStatus[] = [
  'draft',
  'open',
  'accepted',
  'canceled',
];

export const ORBIT_QUOTE_LIMITS = {
  lineItemsMax: 20,
  quantityMax: 1_000_000,
  headerMax: 50,
  footerMax: 500,
  descriptionMax: 1500,
  defaultExpiryDays: 30,
  expiryMaxDays: 365,
  trialPeriodDaysMax: 730,
} as const;

/** `send_invoice` days, as the invoice settings bound them. */
const DAYS_UNTIL_DUE_MAX = 365;

const DAY_SECONDS = 86_400;

/** A catalog price as the quote builder holds it: a payment link's choice plus its recurrence. */
export interface QuotePriceChoice extends LinkPriceChoice {
  /** `month:1` for a recurring price; `null` for a one-time one. */
  interval: string | null;
}

export function intervalOf(price: Pick<Price, 'recurring'>): string | null {
  return price.recurring ? `${price.recurring.interval}:${price.recurring.interval_count}` : null;
}

export interface QuoteLineForm {
  price: QuotePriceChoice;
  quantity: string;
}

export type QuoteDiscountKind = 'none' | 'coupon' | 'promotion_code';

export interface QuoteForm {
  /** `cus_…`; fixed once the quote exists. */
  customer: string;
  lines: QuoteLineForm[];
  collectionMethod: CollectionMethod;
  /** `send_invoice` only; empty for the billing settings' default. */
  daysUntilDue: string;
  discountKind: QuoteDiscountKind;
  /** A coupon id or a promotion code id (`promo_…`). */
  discountId: string;
  /** Days from now; empty keeps the quote's own expiry (30 days, on the customer's clock, for a new one). */
  expiresInDays: string;
  automaticTax: boolean;
  /** Days of trial for the subscription a recurring quote starts; empty for none. */
  trialDays: string;
  header: string;
  description: string;
  footer: string;
}

export const EMPTY_QUOTE_FORM: QuoteForm = {
  customer: '',
  lines: [],
  collectionMethod: 'charge_automatically',
  daysUntilDue: '',
  discountKind: 'none',
  discountId: '',
  // Empty: the gateway's default (30 days on the customer's own clock).
  expiresInDays: '',
  automaticTax: false,
  trialDays: '',
  header: '',
  description: '',
  footer: '',
};

export type QuoteFormErrorCode =
  | 'required'
  | 'too_many'
  | 'quantity'
  | 'duplicate'
  | 'currency_mismatch'
  | 'interval_mismatch'
  | 'inactive'
  | 'metered'
  | 'expiry'
  | 'days'
  | 'trial'
  | 'trial_needs_recurring'
  | 'faircoin_send'
  | 'length'
  | 'server';

/** Keyed by the gateway's own `param` spelling, so a server refusal marks the same field. */
export type QuoteFormErrors = Record<string, QuoteFormErrorCode>;

export function lineForQuote(price: QuotePriceChoice): QuoteLineForm {
  return { price, quantity: '1' };
}

/** The currency the lines are in (the first line's). */
export function quoteCurrency(lines: readonly QuoteLineForm[]): string | null {
  return lines[0]?.price.currency ?? null;
}

export function hasRecurring(lines: readonly QuoteLineForm[]): boolean {
  return lines.some((line) => line.price.interval !== null);
}

/** Why a price cannot be added to these lines, or `null`. */
export function quotePriceRefusal(
  lines: readonly QuoteLineForm[],
  price: QuotePriceChoice,
): QuoteFormErrorCode | null {
  if (!price.active) return 'inactive';
  if (lines.some((line) => line.price.id === price.id)) return 'duplicate';
  if (lines.length >= ORBIT_QUOTE_LIMITS.lineItemsMax) return 'too_many';
  const currency = quoteCurrency(lines);
  if (currency !== null && currency !== price.currency) return 'currency_mismatch';
  if (price.interval !== null) {
    const other = lines.find((line) => line.price.interval !== null);
    if (other && other.price.interval !== price.interval) return 'interval_mismatch';
  }
  return null;
}

/** A whole number in `[min, max]`, or `null`. */
function wholeIn(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

interface Checked {
  lines: { price: string; quantity: number }[];
  daysUntilDue: number | null;
  trialDays: number | null;
  expiresInDays: number | null;
}

function check(form: QuoteForm, { requireCustomer }: { requireCustomer: boolean }) {
  const errors: QuoteFormErrors = {};
  if (requireCustomer && !form.customer.trim()) errors.customer = 'required';
  if (form.lines.length === 0) errors.line_items = 'required';
  else if (form.lines.length > ORBIT_QUOTE_LIMITS.lineItemsMax) errors.line_items = 'too_many';
  const seen = new Set<string>();
  const currency = quoteCurrency(form.lines);
  const interval = form.lines.find((line) => line.price.interval !== null)?.price.interval ?? null;
  const lines = form.lines.map((line, index) => {
    const at = `line_items[${index}]`;
    if (seen.has(line.price.id)) errors[`${at}[price]`] = 'duplicate';
    else if (line.price.currency !== currency) errors[`${at}[price]`] = 'currency_mismatch';
    else if (line.price.interval !== null && line.price.interval !== interval) {
      errors[`${at}[price]`] = 'interval_mismatch';
    }
    seen.add(line.price.id);
    const quantity = wholeIn(line.quantity, 1, ORBIT_QUOTE_LIMITS.quantityMax);
    if (quantity === null) errors[`${at}[quantity]`] = 'quantity';
    return { price: line.price.id, quantity: quantity ?? 1 };
  });
  const fair = currency === 'FAIR';
  if (fair && form.collectionMethod === 'charge_automatically') {
    errors.collection_method = 'faircoin_send';
  }
  let daysUntilDue: number | null = null;
  if (form.collectionMethod === 'send_invoice' && form.daysUntilDue.trim()) {
    daysUntilDue = wholeIn(form.daysUntilDue, 0, DAYS_UNTIL_DUE_MAX);
    if (daysUntilDue === null) errors['invoice_settings[days_until_due]'] = 'days';
  }
  let trialDays: number | null = null;
  if (form.trialDays.trim()) {
    trialDays = wholeIn(form.trialDays, 1, ORBIT_QUOTE_LIMITS.trialPeriodDaysMax);
    if (trialDays === null) errors['subscription_data[trial_period_days]'] = 'trial';
    else if (!hasRecurring(form.lines)) {
      errors['subscription_data[trial_period_days]'] = 'trial_needs_recurring';
    }
  }
  let expiresInDays: number | null = null;
  if (form.expiresInDays.trim()) {
    expiresInDays = wholeIn(form.expiresInDays, 1, ORBIT_QUOTE_LIMITS.expiryMaxDays);
    if (expiresInDays === null) errors.expires_at = 'expiry';
  }
  if (form.discountKind !== 'none' && !form.discountId.trim()) errors.discounts = 'required';
  if (form.header.length > ORBIT_QUOTE_LIMITS.headerMax) errors.header = 'length';
  if (form.description.length > ORBIT_QUOTE_LIMITS.descriptionMax) errors.description = 'length';
  if (form.footer.length > ORBIT_QUOTE_LIMITS.footerMax) errors.footer = 'length';
  const checked: Checked = { lines, daysUntilDue, trialDays, expiresInDays };
  return { errors, checked };
}

function discountsOf(form: QuoteForm) {
  const id = form.discountId.trim();
  if (form.discountKind === 'coupon') return [{ coupon: id }];
  if (form.discountKind === 'promotion_code') return [{ promotion_code: id }];
  return null;
}

export type BuildResult<T> = { ok: true; body: T } | { ok: false; errors: QuoteFormErrors };

/** `POST …/quotes`. `now` is Unix seconds. */
export function buildCreateQuoteBody(form: QuoteForm, now: number): BuildResult<CreateQuoteParams> {
  const { errors, checked } = check(form, { requireCustomer: true });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const discounts = discountsOf(form);
  return {
    ok: true,
    body: {
      customer: form.customer.trim(),
      line_items: checked.lines,
      collection_method: form.collectionMethod,
      ...(checked.daysUntilDue !== null
        ? { invoice_settings: { days_until_due: checked.daysUntilDue } }
        : {}),
      ...(checked.trialDays !== null
        ? { subscription_data: { trial_period_days: checked.trialDays } }
        : {}),
      ...(discounts ? { discounts } : {}),
      ...(form.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      ...(checked.expiresInDays !== null
        ? { expires_at: now + checked.expiresInDays * DAY_SECONDS }
        : {}),
      ...(form.header.trim() ? { header: form.header.trim() } : {}),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      ...(form.footer.trim() ? { footer: form.footer.trim() } : {}),
    },
  };
}

/**
 * `POST …/quotes/:id` for a draft: every field restated (`line_items`
 * replaces the lines); an emptied text or discount is sent as `""`, which
 * clears it.
 */
export function buildUpdateQuoteBody(form: QuoteForm, now: number): BuildResult<UpdateQuoteParams> {
  const { errors, checked } = check(form, { requireCustomer: false });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const discounts = discountsOf(form);
  return {
    ok: true,
    body: {
      line_items: checked.lines,
      collection_method: form.collectionMethod,
      ...(checked.daysUntilDue !== null
        ? { invoice_settings: { days_until_due: checked.daysUntilDue } }
        : {}),
      ...(checked.trialDays !== null
        ? { subscription_data: { trial_period_days: checked.trialDays } }
        : {}),
      discounts: discounts ?? '',
      automatic_tax: { enabled: form.automaticTax },
      ...(checked.expiresInDays !== null
        ? { expires_at: now + checked.expiresInDays * DAY_SECONDS }
        : {}),
      header: form.header.trim(),
      description: form.description.trim(),
      footer: form.footer.trim(),
    },
  };
}

/** A stored quote (and its lines' prices) as the form that edits it. */
export function quoteFormOf(quote: Quote, lines: QuoteLineForm[]): QuoteForm {
  const discount = quote.discount;
  return {
    customer: typeof quote.customer === 'string' ? quote.customer : quote.customer.id,
    lines,
    collectionMethod: quote.collection_method,
    daysUntilDue:
      quote.invoice_settings.days_until_due === null
        ? ''
        : String(quote.invoice_settings.days_until_due),
    discountKind: discount ? (discount.promotion_code ? 'promotion_code' : 'coupon') : 'none',
    discountId: discount ? (discount.promotion_code ?? discount.coupon) : '',
    // Empty: the stored `expires_at` stays unless a new number of days is typed.
    expiresInDays: '',
    automaticTax: quote.automatic_tax.enabled,
    trialDays:
      quote.subscription_data.trial_period_days === null
        ? ''
        : String(quote.subscription_data.trial_period_days),
    header: quote.header ?? '',
    description: quote.description ?? '',
    footer: quote.footer ?? '',
  };
}

/** The form field a gateway `param` names (its own spelling), or `null` when no field shows it. */
export function serverQuoteErrors(param: string | undefined): QuoteFormErrors {
  if (!param) return {};
  const known =
    /^(customer|line_items(\[[0-9]+\]\[(price|quantity)\])?|collection_method|invoice_settings\[days_until_due\]|subscription_data\[trial_period_days\]|discounts(\[0\]\[(coupon|promotion_code)\])?|expires_at|header|description|footer)$/;
  if (!known.test(param)) return {};
  const field = param.startsWith('discounts') ? 'discounts' : param;
  return { [field]: 'server' };
}

// ---- Status --------------------------------------------------------------------------

const QUOTE_TONES: Record<QuoteStatus, StatusTone> = {
  draft: 'neutral',
  open: 'info',
  accepted: 'success',
  canceled: 'neutral',
};

export function quoteStatusTone(status: QuoteStatus): StatusTone {
  return QUOTE_TONES[status] ?? 'neutral';
}

export type QuoteScreenAction = 'edit' | 'finalize' | 'accept' | 'cancel';

/**
 * What the gateway accepts from where the quote stands — the buttons a
 * detail offers. Only a draft is edited and finalized; an open quote is
 * accepted or cancelled; an accepted or cancelled one is history.
 */
export function quoteActions(quote: Pick<Quote, 'status'>): QuoteScreenAction[] {
  switch (quote.status) {
    case 'draft':
      return ['edit', 'finalize', 'cancel'];
    case 'open':
      return ['accept', 'cancel'];
    default:
      return [];
  }
}

/** The PDF's file name: the quote's number once finalized, else its id. */
export function quotePdfFilename(quote: Pick<Quote, 'id' | 'number'>): string {
  return `${quote.number ?? quote.id}.pdf`;
}
