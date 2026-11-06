import type {
  CheckoutSessionPublic,
  FaircoinUnavailableReason,
  PaymentIntent,
} from '@peable.to/shared-types';
import type { CheckoutItem, CheckoutRequest } from '@oxy.so/bloom/checkout-sheet';
import { DEFAULT_CHECKOUT_URL, sessionIdFromClientSecret } from '../browser/embedProtocol';

/**
 * The pure half of `PeableSheetCheckout`: every decision the sheet makes about
 * an order that needs no React, no provider frame and no network, so each is
 * unit-tested where the component cannot be.
 *
 * Nothing here decides that a payment succeeded. The sheet reports what the
 * GATEWAY says about the order (`complete`, `expired`); whether the payer now
 * has what they paid for is the host backend's answer, handed back as the
 * sheet's `outcome`.
 */

/**
 * What the sheet pays.
 *
 * - `checkout_session` — an ORDER (ADR 0021 D1): its lines, its tax, what it
 *   collects, and every method it offers — FairCoin always among them. The
 *   integration that always offers FairCoin.
 * - `payment_intent` — ONE payment on ONE rail (ADR 0019). The sheet pays it on
 *   that rail; it never switches a payment to another one.
 *
 * Both carry the payer's capability, never a merchant credential.
 */
export type SheetCheckoutSource =
  | { readonly type: 'checkout_session'; readonly id: string; readonly clientSecret: string }
  | { readonly type: 'payment_intent'; readonly id: string; readonly clientSecret: string };

const INTENT_ID = /^pi_[0-9a-f]{24,}$/;

/** A payment intent's capability, or `null` when the secret is not that intent's. */
export function intentSource(
  id: string,
  clientSecret: string,
): Extract<SheetCheckoutSource, { type: 'payment_intent' }> | null {
  return INTENT_ID.test(id) && clientSecret.startsWith(`${id}_secret_`)
    ? { type: 'payment_intent', id, clientSecret }
    : null;
}

/** A session's capability from its secret alone (`cs_…_secret_…` names the session). */
export function sessionSource(
  clientSecret: string,
): Extract<SheetCheckoutSource, { type: 'checkout_session' }> | null {
  const id = sessionIdFromClientSecret(clientSecret);
  return id ? { type: 'checkout_session', id, clientSecret } : null;
}

/**
 * The source a Peable hosted-checkout URL carries — `/c/<cs_…>#cs=<secret>` or
 * `/i/<pi_…>#client_secret=<secret>` on `checkoutUrl`'s origin — or `null`.
 *
 * For a host whose backend hands it Peable's hosted URL (Oxy's product
 * checkout does): the secret rides in the fragment, which no server sees, and
 * it must name the same object as the path.
 */
export function sheetSourceFromUrl(
  url: string,
  checkoutUrl: string = DEFAULT_CHECKOUT_URL,
): SheetCheckoutSource | null {
  let parsed: URL;
  let origin: string;
  try {
    parsed = new URL(url);
    origin = new URL(checkoutUrl).origin;
  } catch {
    return null;
  }
  if (parsed.origin !== origin || parsed.search) return null;
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const [, kind, id, ...rest] = parsed.pathname.split('/');
  if (rest.length > 0 || !id) return null;
  if (kind === 'c') {
    const source = sessionSource(fragment.get('cs') ?? '');
    return source?.id === id ? source : null;
  }
  if (kind === 'i') return intentSource(id, fragment.get('client_secret') ?? '');
  return null;
}

/** Peable's hosted page for the same source — the card path where secure fields cannot mount. */
export function hostedUrlFor(
  source: SheetCheckoutSource,
  checkoutUrl: string = DEFAULT_CHECKOUT_URL,
): string {
  const base = checkoutUrl.replace(/\/$/, '');
  return source.type === 'checkout_session'
    ? `${base}/c/${encodeURIComponent(source.id)}#cs=${encodeURIComponent(source.clientSecret)}`
    : `${base}/i/${encodeURIComponent(source.id)}#client_secret=${encodeURIComponent(source.clientSecret)}`;
}

/** A base-unit string as a safe integer, or `null` (the sheet never shows a rounded amount). */
export function baseUnits(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * What the host reviewed before opening the sheet; an order that differs is not
 * paid here.
 *
 * For a session `amount` is its SUBTOTAL — the price before discount and tax —
 * because tax is priced only once the payer says where they pay from and a
 * promotion code may lower the total; neither changes what was reviewed. For a
 * single payment it is the payment's amount (a quoted FairCoin payment's fiat
 * amount).
 */
export interface SheetExpectation {
  /** Base units of `currency`, as the gateway spells them. */
  readonly amount: string;
  readonly currency: string;
  readonly livemode?: boolean;
}

/** Whether the order the gateway answered is the one the payer reviewed. */
export function matchesExpectation(
  order: { readonly amount: string; readonly currency: string; readonly livemode: boolean },
  expected: SheetExpectation | undefined,
): boolean {
  if (!expected) return true;
  return (
    order.amount === expected.amount &&
    order.currency.toUpperCase() === expected.currency.toUpperCase() &&
    (expected.livemode === undefined || order.livemode === expected.livemode)
  );
}

/**
 * Why FairCoin cannot be chosen here, beside Peable's own closed set:
 * `not_offered` is a single payment created on the card rail, which ADR 0019
 * keeps on that rail.
 */
export type SheetFaircoinReason = FaircoinUnavailableReason | 'not_offered';

/** FairCoin is always LISTED (ADR 0021); this says whether it can be chosen now, and why not. */
export type SheetFaircoinAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: SheetFaircoinReason };

export function sessionFaircoin(session: CheckoutSessionPublic): SheetFaircoinAvailability {
  if (!session.payment_method_types.includes('faircoin') || !session.faircoin)
    return { available: false, reason: 'not_offered' };
  if (session.faircoin.available) return { available: true };
  return {
    available: false,
    reason: session.faircoin.unavailable_reason ?? 'temporarily_unavailable',
  };
}

/** A refusal's code as the reason the payer reads, when it is one. */
export function faircoinRefusal(code: string | undefined): FaircoinUnavailableReason | null {
  switch (code) {
    case 'faircoin_wallet_missing':
      return 'faircoin_wallet_missing';
    case 'faircoin_network_closed':
      return 'faircoin_network_closed';
    case 'faircoin_price_unavailable':
      return 'price_unavailable';
    default:
      return null;
  }
}

/** A FairCoin payment with its chain half — the only kind a wallet request can be built for. */
export type FaircoinPaymentIntent = PaymentIntent & {
  rail: 'faircoin';
  faircoin: NonNullable<PaymentIntent['faircoin']>;
};

export function isFaircoinPayment(
  intent: PaymentIntent | null | undefined,
): intent is FaircoinPaymentIntent {
  return !!intent && intent.rail === 'faircoin' && intent.faircoin !== null;
}

/** Where a FairCoin payment stands, as `PeableMethodContent`'s external view shows it. */
export type FaircoinTransferState =
  | 'awaiting'
  | 'detected'
  | 'processing'
  | 'succeeded'
  | 'failure'
  | 'expired';

/**
 * The transfer state from the payment as the gateway holds it. A quote that
 * lapsed before the payer broadcast is `expired` even before the sweeper
 * cancels the payment, so a payer is never shown a price that no longer holds.
 */
export function faircoinTransferState(
  intent: FaircoinPaymentIntent,
  nowSeconds: number,
): FaircoinTransferState {
  switch (intent.status) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
      return intent.faircoin.confirmations > 0 ? 'processing' : 'detected';
    case 'canceled':
      // Ended without money moving, the order still open: a lapsed request, or
      // one retired because the recipient's key was replaced (ADR 0002) — the
      // payer is offered a fresh one either way.
      return intent.cancellation_reason === 'abandoned' ||
        intent.cancellation_reason === 'recipient_key_changed'
        ? 'expired'
        : 'failure';
    default: {
      const quote = intent.faircoin.quote;
      return quote && quote.expires_at <= nowSeconds ? 'expired' : 'awaiting';
    }
  }
}

/** Whether a payment has started moving money, so the order can no longer change method. */
export function paymentInFlight(intent: PaymentIntent | null | undefined): boolean {
  return (
    !!intent &&
    (intent.status === 'processing' ||
      intent.status === 'requires_capture' ||
      intent.status === 'succeeded')
  );
}

/**
 * What a session asks the payer for, and whether this sheet can ask it.
 *
 * The sheet asks for an email when the session has none, a shipping address
 * ONLY when the session collects one (`shipping_address_collection`), and a
 * billing country when tax or the merchant needs it. Phone numbers, tax ids,
 * custom fields, terms consent and `setup` mode are the hosted page's:
 * `unsupported` names the first such need, and the sheet offers that page
 * instead of guessing.
 */
export interface SessionCollection {
  readonly contact: boolean;
  readonly shipping: boolean;
  readonly billingAddress: boolean;
  readonly unsupported: 'setup' | 'phone' | 'tax_id' | 'custom_fields' | 'terms' | 'amount' | null;
}

export function sessionCollection(session: CheckoutSessionPublic): SessionCollection {
  const billingAddress =
    session.billing_address_collection === 'required' || session.automatic_tax.enabled;
  const unsupported: SessionCollection['unsupported'] =
    session.mode === 'setup'
      ? 'setup'
      : session.phone_number_collection.enabled
        ? 'phone'
        : session.tax_id_collection.enabled
          ? 'tax_id'
          : session.custom_fields.some((field) => !field.optional)
            ? 'custom_fields'
            : session.consent_collection?.terms_of_service === 'required'
              ? 'terms'
              : baseUnits(session.amount_total) === null
                ? 'amount'
                : null;
  return {
    contact: !session.customer_details.email,
    shipping: session.shipping_address_collection !== null,
    billingAddress,
    unsupported,
  };
}

/** Whether the session still needs the payer's billing location before it can be confirmed. */
export function needsBillingLocation(session: CheckoutSessionPublic): boolean {
  return sessionCollection(session).billingAddress && !session.customer_details.address?.country;
}

/** Host presentation the gateway does not carry. */
export interface SheetPresentation {
  /** Shown as "Pay <merchant>"; default the merchant's display name. */
  readonly merchant?: string;
  /** A subscription's cadence, shown beside the amount due today. */
  readonly recurring?: { readonly interval: 'month' | 'year'; readonly startsOn?: string };
  /** A line's detail (cadence, variant); default none. */
  readonly itemDetail?: (item: { readonly id: string; readonly description: string }) => string;
}

/** The Bloom sheet's request for a session — amounts exactly as the gateway priced them. */
export function sessionRequest(
  session: CheckoutSessionPublic,
  methods: readonly string[],
  presentation: SheetPresentation = {},
): CheckoutRequest {
  const collection = sessionCollection(session);
  const total = baseUnits(session.amount_total) ?? 0;
  const subtotal = baseUnits(session.amount_subtotal) ?? total;
  const discount = baseUnits(session.total_details.amount_discount) ?? 0;
  const tax = baseUnits(session.total_details.amount_tax) ?? 0;
  const items: CheckoutItem[] = session.line_items.map((line) => ({
    id: line.id,
    name: line.description,
    detail: presentation.itemDetail?.({ id: line.id, description: line.description }) ?? '',
    quantity: line.quantity,
    amountMinorUnits: baseUnits(line.amount_subtotal) ?? 0,
  }));
  return {
    merchant: presentation.merchant ?? session.merchant.name,
    currency: session.currency.toUpperCase(),
    dueTodayMinorUnits: total,
    items,
    requiresShipping: collection.shipping,
    requiresContact: collection.contact,
    paymentMethods: methods,
    ...(session.automatic_tax.enabled && session.automatic_tax.status === 'complete'
      ? {
          tax: {
            subtotalMinorUnits: subtotal,
            taxMinorUnits: tax,
            totalMinorUnits: total,
            // Exclusive tax is added to the total; inclusive tax is already in it.
            inclusive: tax > 0 && subtotal - discount + tax !== total,
          },
        }
      : {}),
    ...(presentation.recurring
      ? {
          recurring: {
            amountMinorUnits: total,
            interval: presentation.recurring.interval,
            ...(presentation.recurring.startsOn
              ? { startsOn: presentation.recurring.startsOn }
              : {}),
          },
        }
      : {}),
  };
}

/** What a single payment pays for; the gateway's intent carries no lines. */
export interface SheetOrder {
  readonly merchant: string;
  readonly items: readonly CheckoutItem[];
  readonly recurring?: SheetPresentation['recurring'];
}

/** The Bloom sheet's request for a single payment. A FairCoin one is shown in its quoted currency. */
export function intentRequest(
  intent: PaymentIntent,
  order: SheetOrder,
  methods: readonly string[],
): CheckoutRequest {
  const quote = intent.faircoin?.quote ?? null;
  const amount = baseUnits(quote ? quote.amount : intent.amount) ?? 0;
  return {
    merchant: order.merchant,
    currency: (quote ? quote.currency : intent.currency).toUpperCase(),
    dueTodayMinorUnits: amount,
    items: [...order.items],
    requiresShipping: false,
    requiresContact: false,
    paymentMethods: methods,
    ...(order.recurring
      ? {
          recurring: {
            amountMinorUnits: amount,
            interval: order.recurring.interval,
            ...(order.recurring.startsOn ? { startsOn: order.recurring.startsOn } : {}),
          },
        }
      : {}),
  };
}

/** The gateway's word that the order is over: a session's status, or a payment's terminal one. */
export type SheetSettlement = 'complete' | 'expired';

export function sessionSettlement(session: CheckoutSessionPublic): SheetSettlement | null {
  return session.status === 'open' ? null : session.status;
}

export function intentSettlement(intent: PaymentIntent): SheetSettlement | null {
  if (intent.status === 'succeeded') return 'complete';
  if (intent.status === 'canceled') return 'expired';
  return null;
}

/**
 * The host backend's answer, after the gateway settled: `succeeded` — the payer
 * has what they paid for; `failed` — they do not and must not be told they do.
 * `null` while the host has not answered; the sheet stays on `processing`.
 */
export type SheetOutcome = 'succeeded' | 'failed' | null;

/** The sheet's billing-location draft for a session that needs one. */
export interface BillingLocation {
  readonly country: string;
  readonly postcode: string;
}

/** The gateway's `customer_details.address` for a billing location (country upper-cased). */
export function billingAddressParams(location: BillingLocation): {
  country: string;
  postal_code?: string;
} {
  const postcode = location.postcode.trim();
  return {
    country: location.country.trim().toUpperCase(),
    ...(postcode ? { postal_code: postcode } : {}),
  };
}

/** The gateway's `shipping_details` from the Bloom sheet's shipping draft, or `null` while incomplete. */
export function shippingDetailsParams(shipping: {
  readonly name: string;
  readonly address: string;
  readonly city: string;
  readonly postalCode: string;
  readonly country: string;
}): {
  name: string;
  address: { line1: string; city: string; postal_code: string; country: string };
} | null {
  const name = shipping.name.trim();
  const line1 = shipping.address.trim();
  const city = shipping.city.trim();
  const postal = shipping.postalCode.trim();
  const country = shipping.country.trim().toUpperCase();
  if (!name || !line1 || !city || !postal || !/^[A-Z]{2}$/.test(country)) return null;
  return { name, address: { line1, city, postal_code: postal, country } };
}
