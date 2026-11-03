/**
 * Checkout Sessions (Orbit Phase 3) — Stripe Checkout's model, at the root.
 *
 * A session is an ORDER: priced lines, at most one discount, Peable Tax, and
 * what to collect from the payer. Its payment (or, in setup mode, its
 * SetupIntent) is created when the payer CONFIRMS, with the amount the
 * session computed, and linked to it; completing the session is the payment's
 * to decide (`completion.ts`), never a client's.
 *
 * ## Writes are compare-and-swaps
 *
 * The payer's edit is computed from a read (prices, discount, a tax call to
 * the provider — none of it inside a transaction) and written only if the
 * session is still the one that was read (`writeSessionOrder`'s `updated_at`).
 * The confirm creates the payment first and then, in ONE transaction under the
 * discount's row lock, checks the reservation and links the payment — so two
 * payers racing for a code's last redemption cannot both get it.
 */
import type {
  Address,
  AddressParams,
  CheckoutCustomerDetails,
  CheckoutShippingDetails,
  CurrencyCode,
} from '@peable.to/shared-types';
import { config } from '../../config';
import {
  findCouponById,
  findCouponForMerchant,
  lockCouponById,
} from '../../db/catalog/couponRepository';
import {
  findActivePromotionCodeByCode,
  findPromotionCodeById,
  findPromotionCodeForMerchant,
  lockPromotionCodeById,
} from '../../db/catalog/promotionCodeRepository';
import { findBranding } from '../../db/merchants/brandingRepository';
import {
  findCustomerById,
  findLiveCustomerForMerchant,
  insertCustomer,
  type CustomerRow,
} from '../../db/customers/customerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  type CheckoutLineItemRow,
  type CheckoutSessionRow,
  countReservedRedemptions,
  expireSessionRow,
  findSessionById,
  findSessionByLinkOperation,
  hasSucceededPayment,
  insertCheckoutSession,
  linkSessionObject,
  listLineItems,
  lockSession,
  writeSessionOrder,
} from '../../db/payments/checkoutSessionRepository';
import { findIntentById, type PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import { listLinkLineItems, type PaymentLinkRow } from '../../db/payments/paymentLinkRepository';
import { getDb } from '../../db/postgres';
import type { StoredCustomField } from '../../db/schema/payments';
import { findSetupIntentById } from '../../db/customers/setupIntentRepository';
import { newId } from '../../lib/ids';
import { fromBaseUnits, toBaseUnits } from '../../lib/money';
import { fromUnix } from '../../lib/time';
import { toCheckoutSessionDTO } from '../../lib/serializeCheckout';
import { toCustomerDTO } from '../../lib/serialize';
import { pricingCouponOf, pricingPromotionCodeOf } from '../catalog/pricingRows';
import type { DiscountRefusal } from '../catalog/pricing';
import { cancelCardPaymentAtProvider } from '../cardCancellation';
import {
  AccountNotReadyError,
  assertRailAvailable,
  ConnectedAccountNotFoundError,
  createIntent,
  NetworkMismatchError,
  RailMismatchError,
  RailUnavailableError,
  resolveConnectedAccountForPayment,
  resolveRail,
} from '../createIntent';
import { createSetupIntent, cancelSetupIntent } from '../customers/setupIntentService';
import { recordEvent } from '../events';
import {
  announceIntentChange,
  recordCustomerObjectEvent,
  transitionIntent,
} from '../intentTransition';
import { applyEvent } from '../intentState';
import type { TaxService } from '../tax/taxService';
import { kickWebhookOutbox } from '../webhookOutbox';
import { CheckoutError, invalid } from './errors';
import { completeZeroAmountSession } from './completion';
import {
  type ResolvedLine,
  resolveLinkLines,
  resolveRequestedLines,
  sessionLineOfLink,
  toNewLineItems,
} from './lineItems';
import {
  type CreateSessionBody,
  DEFAULT_COLLECTION,
  type PayerUpdate,
  storedCollectionOf,
  storedCustomFieldsOf,
} from './params';
import { subscriptionCheckoutFulfiller } from './subscriptionFulfiller';
import { checkoutTax, type CheckoutTaxResult } from './tax';
import { orderTotals, type TotalsDiscount, type TotalsLine, taxBases } from './totals';

export interface CheckoutDeps {
  /** Peable Tax — required for `automatic_tax`; a session without it never calls it. */
  readonly tax?: TaxService | undefined;
  readonly now?: () => Date;
}

const DAY_SECONDS = 24 * 3600;

const DISCOUNT_MESSAGES: Record<DiscountRefusal, string> = {
  coupon_invalid: 'this discount is no longer valid',
  coupon_currency_mismatch: 'this discount is in another currency',
  coupon_not_applicable: 'this discount does not apply to anything in the order',
  promotion_code_inactive: 'this code is no longer active',
  promotion_code_customer_mismatch: 'this code is for another customer',
  promotion_code_expired: 'this code has expired',
  promotion_code_max_redemptions: 'this code has been used up',
  promotion_code_minimum_amount: 'the order does not reach this code’s minimum amount',
  promotion_code_first_time_only: 'this code is for a first order only',
};

function discountError(reason: DiscountRefusal, param: string): CheckoutError {
  return invalid(reason, DISCOUNT_MESSAGES[reason], param);
}

// ---- Shared helpers ---------------------------------------------------------------

/** The discount a session carries, as pricing needs it. */
async function sessionDiscount(row: {
  couponId: string | null;
  promotionCodeId: string | null;
}): Promise<TotalsDiscount | null> {
  if (row.couponId === null) return null;
  const db = getDb();
  const coupon = await findCouponById(db, row.couponId);
  if (!coupon) return null;
  const code =
    row.promotionCodeId === null ? null : await findPromotionCodeById(db, row.promotionCodeId);
  return {
    coupon: pricingCouponOf(coupon),
    ...(code ? { promotionCode: pricingPromotionCodeOf(code) } : {}),
  };
}

function totalsLinesOf(
  lines: readonly CheckoutLineItemRow[],
  quantities?: ReadonlyMap<string, number>,
): TotalsLine[] {
  return lines.map((line) => ({
    key: line.publicId,
    currency: line.currency,
    price: line.price,
    quantity: quantities?.get(line.publicId) ?? line.quantity,
    productId: line.productId,
  }));
}

function emailOf(session: CheckoutSessionRow): string | null {
  return session.customerEmail ?? session.customerDetails?.email ?? null;
}

async function totalsContext(
  merchant: MerchantRow,
  session: { customerId: string | null; email: string | null },
  now: Date,
) {
  return {
    now,
    ...(session.customerId ? { customerId: session.customerId } : {}),
    firstTimeTransaction: !(await hasSucceededPayment(getDb(), merchant.id, session)),
  };
}

/** An address as the payer typed it → the wire's `Address` (every field present). */
function addressOf(
  input: AddressParams | undefined,
  previous: Address | null | undefined,
): Address | null {
  if (input === undefined) return previous ?? null;
  return {
    line1: input.line1 ?? null,
    line2: input.line2 ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    postal_code: input.postal_code ?? null,
    country: input.country ?? null,
  };
}

function remainingSeconds(expiresAt: Date | null, now: Date): number {
  const end = expiresAt ?? new Date(now.getTime() + DAY_SECONDS * 1000);
  return Math.floor((end.getTime() - now.getTime()) / 1000);
}

function translateRail(error: unknown, param: string): never {
  if (error instanceof NetworkMismatchError || error instanceof RailMismatchError) {
    throw invalid('parameter_invalid', error.message, param);
  }
  if (error instanceof RailUnavailableError) {
    throw new CheckoutError(503, 'rail_unavailable', error.message);
  }
  throw error;
}

// ---- Create ---------------------------------------------------------------------

interface SessionPlan {
  readonly lines: readonly ResolvedLine[];
  readonly currency: CurrencyCode;
}

/** Rail, network and seller for an order in `currency`. */
async function planRail(
  merchant: MerchantRow,
  currency: CurrencyCode,
  body: { payment_method_types?: string[] | undefined; connected_account?: string | undefined },
) {
  const rail = currency === 'FAIR' ? ('faircoin' as const) : ('card' as const);
  if (body.payment_method_types && body.payment_method_types[0] !== rail) {
    throw invalid(
      'parameter_invalid',
      `a ${currency} order is paid with '${rail}'`,
      'payment_method_types',
    );
  }
  try {
    const account =
      body.connected_account !== undefined
        ? await resolveConnectedAccountForPayment(merchant, body.connected_account)
        : undefined;
    const network = account?.network ?? merchant.network ?? undefined;
    const resolved = resolveRail(
      merchant,
      { rail, currency, ...(rail === 'faircoin' && network ? { network } : {}) },
      account,
    );
    assertRailAvailable(resolved.rail, merchant.environment);
    return { ...resolved, connectedAccountId: account?.id ?? null };
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    // A seller that is unknown or not ready: the field is `connected_account`.
    if (error instanceof ConnectedAccountNotFoundError) {
      throw invalid('resource_missing', error.message, 'connected_account');
    }
    if (error instanceof AccountNotReadyError) {
      throw invalid('account_not_ready', error.message, 'connected_account');
    }
    return translateRail(error, 'currency');
  }
}

/** Refuse a discount the order cannot take, naming the field that carried it. */
async function resolveCreateDiscount(
  merchant: MerchantRow,
  discounts: CreateSessionBody['discounts'],
): Promise<{
  couponId: string | null;
  promotionCodeId: string | null;
  discount: TotalsDiscount | null;
}> {
  const first = discounts?.[0];
  if (!first) return { couponId: null, promotionCodeId: null, discount: null };
  const db = getDb();
  if ('coupon' in first) {
    const coupon = await findCouponForMerchant(db, first.coupon, merchant.id);
    if (!coupon)
      throw invalid(
        'resource_missing',
        `no such coupon: '${first.coupon}'`,
        'discounts[0][coupon]',
      );
    return {
      couponId: coupon.id,
      promotionCodeId: null,
      discount: { coupon: pricingCouponOf(coupon) },
    };
  }
  const code = await findPromotionCodeForMerchant(db, first.promotion_code, merchant.id);
  if (!code) {
    throw invalid(
      'resource_missing',
      `no such promotion code: '${first.promotion_code}'`,
      'discounts[0][promotion_code]',
    );
  }
  const coupon = await findCouponById(db, code.couponId);
  if (!coupon) throw new Error(`promotion code ${code.publicId} names an unreadable coupon`);
  return {
    couponId: coupon.id,
    promotionCodeId: code.id,
    discount: { coupon: pricingCouponOf(coupon), promotionCode: pricingPromotionCodeOf(code) },
  };
}

/** Price `lines` (no tax yet: there is no address) and refuse a discount that does not apply. */
function priceAtCreate(
  plan: SessionPlan,
  discount: TotalsDiscount | null,
  context: Awaited<ReturnType<typeof totalsContext>>,
  discountParam: string,
) {
  const totalsLines: TotalsLine[] = plan.lines.map((line, index) => ({
    key: String(index),
    currency: line.currency,
    price: line.price,
    quantity: line.quantity,
    productId: line.productId,
  }));
  const priced = orderTotals(totalsLines, discount, context);
  if (!priced.ok) throw discountError(priced.reason, discountParam);
  return priced.totals;
}

async function assertTermsAvailable(merchant: MerchantRow, wanted: boolean, param: string) {
  if (!wanted) return;
  const branding = await findBranding(getDb(), merchant.id);
  if (!branding.termsOfServiceUrl) {
    throw invalid(
      'parameter_invalid',
      'set a terms of service URL in your branding settings before asking payers to accept it',
      param,
    );
  }
}

async function assertTaxActive(
  merchant: MerchantRow,
  deps: CheckoutDeps,
  wanted: boolean,
  param: string,
) {
  if (!wanted) return;
  const settings = deps.tax ? await deps.tax.getSettings(merchant) : null;
  if (settings?.status !== 'active') {
    throw invalid(
      'tax_settings_not_active',
      'automatic tax needs Peable Tax settings approved by the account owner',
      param,
    );
  }
}

/** `POST /v1/checkout_sessions`. */
export async function createCheckoutSession(
  merchant: MerchantRow,
  body: CreateSessionBody,
  deps: CheckoutDeps = {},
): Promise<CheckoutSessionRow> {
  const now = deps.now?.() ?? new Date();
  const db = getDb();
  const mode = body.mode ?? 'payment';

  let expiresAt = new Date(now.getTime() + DAY_SECONDS * 1000);
  if (body.expires_at !== undefined) {
    const seconds = body.expires_at - Math.floor(now.getTime() / 1000);
    if (seconds < 30 * 60 || seconds > DAY_SECONDS) {
      throw invalid(
        'parameter_invalid',
        'expires_at must be between 30 minutes and 24 hours from now',
        'expires_at',
      );
    }
    expiresAt = fromUnix(body.expires_at);
  }

  let customer: CustomerRow | null = null;
  if (body.customer !== undefined) {
    customer = await findLiveCustomerForMerchant(db, body.customer, merchant.id);
    if (!customer)
      throw invalid('resource_missing', `no such customer: '${body.customer}'`, 'customer');
  }
  const email = body.customer_email ?? customer?.email ?? null;

  await assertTermsAvailable(
    merchant,
    body.consent_collection?.terms_of_service === 'required',
    'consent_collection[terms_of_service]',
  );
  await assertTaxActive(
    merchant,
    deps,
    body.automatic_tax?.enabled === true,
    'automatic_tax[enabled]',
  );

  const collection = storedCollectionOf(body);
  const customFields = storedCustomFieldsOf(body.custom_fields);
  const common = {
    publicId: newId('cs'),
    merchantId: merchant.id,
    oxyAppId: merchant.oxyAppId,
    environment: merchant.environment,
    metadata: body.metadata ?? {},
    mode,
    uiMode: body.ui_mode ?? 'hosted',
    locale: body.locale ?? null,
    submitType: body.submit_type ?? 'auto',
    customerId: customer?.id ?? null,
    customerEmail: email,
    customerCreation: body.customer_creation ?? 'if_required',
    collection,
    customFields,
    clientReferenceId: body.client_reference_id ?? null,
    successUrl: body.success_url,
    cancelUrl: body.cancel_url,
    expiresAt,
  } as const;

  if (mode === 'setup') {
    const currency = body.currency ?? 'EUR';
    if (currency === 'FAIR') {
      throw invalid(
        'parameter_invalid',
        'FairCoin has no saved payment methods: the payer signs every payment on their device',
        'currency',
      );
    }
    const rail = await planRail(merchant, currency, body);
    const row = await insertCheckoutSession(db, {
      ...common,
      amount: '0',
      currency: rail.currency,
      rail: rail.rail,
      network: rail.network,
    });
    if (!row) throw new Error('a fresh session id collided');
    return row;
  }

  const lines = await resolveRequestedLines(db, merchant.id, body.line_items ?? []);
  const currency = lines[0]?.currency;
  if (!currency) throw invalid('parameter_missing', 'line_items is required', 'line_items');
  lines.forEach((line, index) => {
    if (mode === 'payment' && line.recurring) {
      throw invalid(
        'parameter_invalid',
        'a recurring price needs mode: subscription',
        `line_items[${index}][price]`,
      );
    }
    if (mode === 'subscription' && !line.recurring) {
      throw invalid(
        'parameter_invalid',
        'a subscription session takes recurring prices',
        `line_items[${index}][price]`,
      );
    }
  });
  const rail = await planRail(merchant, currency, body);
  const plan = { lines, currency };
  const { couponId, promotionCodeId, discount } = await resolveCreateDiscount(
    merchant,
    body.discounts,
  );
  const context = await totalsContext(merchant, { customerId: customer?.id ?? null, email }, now);
  const totals = priceAtCreate(
    plan,
    discount,
    context,
    body.discounts?.[0] && 'coupon' in body.discounts[0]
      ? 'discounts[0][coupon]'
      : 'discounts[0][promotion_code]',
  );

  if (mode === 'subscription') {
    const fulfiller = subscriptionCheckoutFulfiller();
    if (!fulfiller) {
      throw invalid(
        'mode_unavailable',
        'subscription checkout is not available yet: create the subscription through billing',
        'mode',
      );
    }
    await fulfiller.validate(
      merchant,
      toNewLineItems(lines, new Map(totals.lines.map((l) => [l.key, l]))),
    );
  }

  const row = await insertCheckoutSession(db, {
    ...common,
    amount: fromBaseUnits(totals.amountTotal),
    totals: {
      amountSubtotal: fromBaseUnits(totals.amountSubtotal),
      amountDiscount: fromBaseUnits(totals.amountDiscount),
      amountTax: '0',
      amountShipping: '0',
      amountTotal: fromBaseUnits(totals.amountTotal),
    },
    currency: rail.currency,
    rail: rail.rail,
    network: rail.network,
    connectedAccountId: rail.connectedAccountId,
    allowPromotionCodes: body.allow_promotion_codes ?? false,
    couponId,
    promotionCodeId,
    automaticTax: body.automatic_tax?.enabled === true,
    automaticTaxStatus: body.automatic_tax?.enabled === true ? 'requires_location_inputs' : null,
    lineItems: toNewLineItems(lines, new Map(totals.lines.map((l) => [l.key, l]))),
  });
  if (!row) throw new Error('a fresh session id collided');
  return row;
}

/**
 * A payer starting checkout from a payment link (Stripe's semantics: a visit
 * creates a session). Everything comes from the STORED link; the payer may
 * only choose a free contribution's amount. `operationKey` makes the start
 * idempotent: the same key returns the session it created.
 */
export async function createSessionFromLink(
  link: PaymentLinkRow,
  merchant: MerchantRow,
  input: { readonly amount?: string | undefined; readonly operationKey?: string | undefined },
  deps: CheckoutDeps = {},
): Promise<CheckoutSessionRow> {
  const db = getDb();
  if (input.operationKey) {
    const existing = await findSessionByLinkOperation(db, link.id, input.operationKey);
    if (existing) {
      if (
        link.contribution &&
        input.amount !== undefined &&
        existing.amountSubtotal !== input.amount
      ) {
        throw new CheckoutError(
          409,
          'idempotency_error',
          'This operation key belongs to a different contribution',
        );
      }
      return existing;
    }
  }
  if (!link.active) throw invalid('payment_link_inactive', 'this payment link is no longer active');
  const now = deps.now?.() ?? new Date();

  let lines: ResolvedLine[];
  if (link.contribution) {
    const contribution = link.contribution;
    if (contribution.expiresAt && Date.parse(contribution.expiresAt) <= now.getTime()) {
      throw invalid('payment_link_inactive', 'this contribution link has expired');
    }
    let amount = link.amount ?? '0';
    if (contribution.amountMode === 'free') {
      if (!input.amount || input.amount === '0') {
        throw invalid('parameter_missing', 'Choose a contribution amount', 'amount');
      }
      amount = input.amount;
    } else if (input.amount !== undefined && input.amount !== link.amount) {
      throw invalid('parameter_invalid', 'This contribution has a fixed amount', 'amount');
    }
    lines = [
      {
        priceId: null,
        productId: null,
        description: contribution.purpose,
        images: [],
        taxCode: null,
        taxBehavior: 'unspecified',
        currency: link.currency,
        price: {
          billingScheme: 'per_unit',
          unitAmount: amount,
          tiers: null,
          tiersMode: null,
          transformQuantity: null,
          recurring: null,
        },
        recurring: false,
        quantity: 1,
        adjustable: null,
      },
    ];
  } else {
    if (input.amount !== undefined) {
      throw invalid('parameter_invalid', 'this link’s amounts are its prices', 'amount');
    }
    const entries = await resolveLinkLines(db, merchant.id, await listLinkLineItems(db, link.id));
    for (const entry of entries) {
      if (!entry.price.active || !entry.product.active) {
        throw invalid('payment_link_inactive', 'something on this link is no longer sold');
      }
    }
    lines = entries.map(sessionLineOfLink);
  }

  const rail = await planRail(merchant, link.currency, {});
  const context = await totalsContext(merchant, { customerId: null, email: null }, now);
  const totals = priceAtCreate({ lines, currency: link.currency }, null, context, 'line_items');
  const row = await insertCheckoutSession(db, {
    publicId: newId('cs'),
    merchantId: merchant.id,
    oxyAppId: merchant.oxyAppId,
    environment: merchant.environment,
    metadata: {},
    mode: 'payment',
    uiMode: 'hosted',
    locale: link.locale,
    submitType: link.contribution ? 'donate' : link.submitType,
    customerCreation: link.customerCreation,
    collection: link.collection ?? DEFAULT_COLLECTION,
    customFields: link.customFields,
    allowPromotionCodes: link.allowPromotionCodes,
    automaticTax: link.automaticTax,
    automaticTaxStatus: link.automaticTax ? 'requires_location_inputs' : null,
    paymentLinkId: link.id,
    successUrl:
      link.afterCompletionType === 'redirect' ? (link.afterCompletionUrl ?? undefined) : undefined,
    confirmationMessage:
      link.afterCompletionType === 'hosted_confirmation' ? link.afterCompletionMessage : null,
    linkOperationKey: input.operationKey ?? null,
    expiresAt: new Date(now.getTime() + DAY_SECONDS * 1000),
    amount: fromBaseUnits(totals.amountTotal),
    totals: {
      amountSubtotal: fromBaseUnits(totals.amountSubtotal),
      amountDiscount: '0',
      amountTax: '0',
      amountShipping: '0',
      amountTotal: fromBaseUnits(totals.amountTotal),
    },
    currency: rail.currency,
    rail: rail.rail,
    network: rail.network,
    lineItems: toNewLineItems(lines, new Map(totals.lines.map((l) => [l.key, l]))),
  });
  if (row) return row;
  // A concurrent start under the same operation key won the unique index.
  if (input.operationKey) {
    const winner = await findSessionByLinkOperation(db, link.id, input.operationKey);
    if (winner) return winner;
  }
  throw new Error('a fresh session id collided');
}

// ---- The payer's edit --------------------------------------------------------------

function assertEditable(session: CheckoutSessionRow, now: Date): void {
  if (session.status !== 'open') {
    throw invalid('checkout_session_not_open', `this checkout session is ${session.status}`);
  }
  if (session.expiresAt && session.expiresAt.getTime() <= now.getTime()) {
    throw invalid('checkout_session_expired', 'this checkout session has expired');
  }
  if (session.paymentIntentId !== null || session.setupIntentId !== null) {
    throw invalid(
      'checkout_session_locked',
      'this order is confirmed and can no longer be changed',
    );
  }
}

function customFieldsAfter(
  fields: readonly StoredCustomField[],
  updates: PayerUpdate['custom_fields'],
): StoredCustomField[] {
  if (!updates) return [...fields];
  const next = fields.map((field) => ({ ...field }));
  updates.forEach((update, index) => {
    const field = next.find((candidate) => candidate.key === update.key);
    const param = `custom_fields[${index}][value]`;
    if (!field)
      throw invalid(
        'parameter_invalid',
        `no custom field '${update.key}'`,
        `custom_fields[${index}][key]`,
      );
    const value = update.value.trim();
    if (value === '') {
      field.value = null;
      return;
    }
    if (field.type === 'dropdown') {
      if (!(field.options ?? []).some((option) => option.value === value)) {
        throw invalid('parameter_invalid', 'choose one of the options', param);
      }
    } else {
      if (field.type === 'numeric' && !/^[0-9]+$/.test(value)) {
        throw invalid('parameter_invalid', 'enter digits only', param);
      }
      if (field.minimumLength !== null && value.length < field.minimumLength) {
        throw invalid(
          'parameter_invalid',
          `enter at least ${field.minimumLength} characters`,
          param,
        );
      }
      if (field.maximumLength !== null && value.length > field.maximumLength) {
        throw invalid(
          'parameter_invalid',
          `enter at most ${field.maximumLength} characters`,
          param,
        );
      }
    }
    field.value = value;
  });
  return next;
}

function taxLinesOf(
  lines: readonly CheckoutLineItemRow[],
  totalsLines: readonly TotalsLine[],
  bases: ReadonlyMap<string, bigint>,
) {
  return lines.map((line, index) => ({
    key: line.publicId,
    amount: bases.get(line.publicId) ?? 0n,
    quantity: totalsLines[index]?.quantity ?? line.quantity,
    taxCode: line.taxCode,
    taxBehavior: line.taxBehavior,
  }));
}

/** The order priced as it stands with these quantities, this discount and this address. */
async function priceOrder(
  merchant: MerchantRow,
  session: CheckoutSessionRow,
  lines: readonly CheckoutLineItemRow[],
  quantities: ReadonlyMap<string, number>,
  discount: TotalsDiscount | null,
  details: { customerId: string | null; email: string | null; address: Address | null },
  deps: CheckoutDeps,
  discountParam: string,
): Promise<{
  totals: Extract<ReturnType<typeof orderTotals>, { ok: true }>['totals'];
  tax: CheckoutTaxResult;
}> {
  const now = deps.now?.() ?? new Date();
  const totalsLines = totalsLinesOf(lines, quantities);
  const context = await totalsContext(merchant, details, now);
  const bases = taxBases(totalsLines, discount, context);
  if (!bases.ok) throw discountError(bases.reason, discountParam);
  const tax = await checkoutTax(deps.tax, merchant, {
    enabled: session.automaticTax,
    sessionPublicId: session.publicId,
    currency: session.currency,
    address: details.address,
    lines: taxLinesOf(lines, totalsLines, bases.bases),
  });
  const priced = orderTotals(totalsLines, discount, context, tax.taxes);
  if (!priced.ok) throw discountError(priced.reason, discountParam);
  return { totals: priced.totals, tax };
}

/** `POST /v1/checkout_sessions/:id/public` — the payer's edit of an open, unconfirmed order. */
export async function updateSessionAsPayer(
  session: CheckoutSessionRow,
  merchant: MerchantRow,
  body: PayerUpdate,
  deps: CheckoutDeps = {},
): Promise<CheckoutSessionRow> {
  const now = deps.now?.() ?? new Date();
  assertEditable(session, now);
  const db = getDb();
  const lines = await listLineItems(db, session.id);
  const collection = session.collection ?? DEFAULT_COLLECTION;

  // Quantities, within each line's bounds.
  const quantities = new Map(lines.map((line) => [line.publicId, line.quantity]));
  body.line_items?.forEach((update, index) => {
    const line = lines.find((candidate) => candidate.publicId === update.id);
    const param = `line_items[${index}][quantity]`;
    if (!line)
      throw invalid('parameter_invalid', `no line '${update.id}'`, `line_items[${index}][id]`);
    if (!line.adjustableEnabled) {
      if (update.quantity !== line.quantity) {
        throw invalid('parameter_invalid', 'this line’s quantity cannot be changed', param);
      }
      return;
    }
    const min = line.adjustableMinimum ?? 0;
    const max = line.adjustableMaximum ?? 99;
    if (update.quantity < min || update.quantity > max) {
      throw invalid('parameter_invalid', `choose a quantity between ${min} and ${max}`, param);
    }
    quantities.set(line.publicId, update.quantity);
  });
  if ([...quantities.values()].every((quantity) => quantity === 0)) {
    throw invalid('parameter_invalid', 'the order needs at least one item', 'line_items');
  }

  // Details.
  const previous = session.customerDetails;
  const input = body.customer_details;
  if (input?.email !== undefined && session.customerEmail !== null) {
    if (input.email.toLowerCase() !== session.customerEmail.toLowerCase()) {
      throw invalid(
        'parameter_invalid',
        'the email is set by the merchant',
        'customer_details[email]',
      );
    }
  }
  if (input?.phone !== undefined && !collection.phoneNumber) {
    throw invalid(
      'parameter_unknown',
      'this checkout does not collect a phone number',
      'customer_details[phone]',
    );
  }
  if (input?.tax_ids !== undefined && !collection.taxId) {
    throw invalid(
      'parameter_unknown',
      'this checkout does not collect a tax id',
      'customer_details[tax_ids]',
    );
  }
  const details: CheckoutCustomerDetails = {
    email: session.customerEmail ?? input?.email ?? previous?.email ?? null,
    name: input?.name ?? previous?.name ?? null,
    phone: input?.phone ?? previous?.phone ?? null,
    address: addressOf(input?.address, previous?.address),
    tax_ids: input?.tax_ids ?? previous?.tax_ids ?? [],
  };
  let shipping: CheckoutShippingDetails | null | undefined;
  if (body.shipping_details !== undefined) {
    if (!collection.shippingCountries) {
      throw invalid(
        'parameter_unknown',
        'this checkout does not collect a shipping address',
        'shipping_details',
      );
    }
    if (body.shipping_details === null) shipping = null;
    else {
      const address = addressOf(body.shipping_details.address, null);
      if (!address?.country || !collection.shippingCountries.includes(address.country)) {
        throw invalid(
          'parameter_invalid',
          'this merchant does not ship to that country',
          'shipping_details[address][country]',
        );
      }
      shipping = { name: body.shipping_details.name, address };
    }
  }
  const customFields = customFieldsAfter(session.customFields, body.custom_fields);
  let consent = session.consent;
  if (body.consent?.terms_of_service !== undefined) {
    if (!collection.termsOfService) {
      throw invalid(
        'parameter_unknown',
        'this checkout asks for no terms acceptance',
        'consent[terms_of_service]',
      );
    }
    consent = { terms_of_service: 'accepted' };
  }

  // The discount: a code the payer typed (or removed), else what the session has.
  let couponId = session.couponId;
  let promotionCodeId = session.promotionCodeId;
  let discount: TotalsDiscount | null;
  let discountParam = 'line_items';
  if (body.promotion_code !== undefined) {
    discountParam = 'promotion_code';
    if (!session.allowPromotionCodes) {
      throw invalid(
        'parameter_unknown',
        'this checkout does not take promotion codes',
        'promotion_code',
      );
    }
    if (body.promotion_code === '') {
      couponId = null;
      promotionCodeId = null;
      discount = null;
    } else {
      const code = await findActivePromotionCodeByCode(db, merchant.id, body.promotion_code);
      if (!code)
        throw invalid('promotion_code_invalid', 'this code is not valid', 'promotion_code');
      const coupon = await findCouponById(db, code.couponId);
      if (!coupon)
        throw invalid('promotion_code_invalid', 'this code is not valid', 'promotion_code');
      couponId = coupon.id;
      promotionCodeId = code.id;
      discount = { coupon: pricingCouponOf(coupon), promotionCode: pricingPromotionCodeOf(code) };
    }
  } else {
    discount = await sessionDiscount(session);
  }

  const { totals, tax } = await priceOrder(
    merchant,
    session,
    lines,
    quantities,
    discount,
    { customerId: session.customerId, email: details.email, address: details.address },
    deps,
    discountParam,
  );
  const priced = new Map(totals.lines.map((line) => [line.key, line]));
  const written = await db.transaction(async (tx) => {
    const current = await lockSession(tx, session.id);
    if (!current || current.updatedAt.getTime() !== session.updatedAt.getTime()) return false;
    return writeSessionOrder(tx, session.id, {
      totals: {
        amountSubtotal: fromBaseUnits(totals.amountSubtotal),
        amountDiscount: fromBaseUnits(totals.amountDiscount),
        amountTax: fromBaseUnits(totals.amountTax),
        amountShipping: fromBaseUnits(totals.amountShipping),
        amountTotal: fromBaseUnits(totals.amountTotal),
      },
      lines: lines.map((line) => {
        const amounts = priced.get(line.publicId);
        return {
          id: line.id,
          quantity: quantities.get(line.publicId) ?? line.quantity,
          amountSubtotal: fromBaseUnits(amounts?.amountSubtotal ?? 0n),
          amountDiscount: fromBaseUnits(amounts?.amountDiscount ?? 0n),
          amountTax: fromBaseUnits(amounts?.amountTax ?? 0n),
          amountTotal: fromBaseUnits(amounts?.amountTotal ?? 0n),
        };
      }),
      customerDetails: details,
      ...(shipping !== undefined ? { shippingDetails: shipping } : {}),
      customFields,
      consent,
      couponId,
      promotionCodeId,
      automaticTaxStatus: tax.status,
      taxCalculationId: tax.calculationId,
    });
  });
  if (!written) {
    throw new CheckoutError(
      409,
      'checkout_session_changed',
      'this checkout changed while you were editing it; reload and try again',
    );
  }
  const row = await findSessionById(db, session.id);
  if (!row) throw new Error(`session ${session.publicId} vanished`);
  return row;
}

// ---- Confirm --------------------------------------------------------------------

/** What the order still needs before it can be paid, by the field that needs it. */
function missingField(
  session: CheckoutSessionRow,
  lines: readonly CheckoutLineItemRow[],
): CheckoutError | null {
  const collection = session.collection ?? DEFAULT_COLLECTION;
  const details = session.customerDetails;
  const email = emailOf(session);
  if (!email) return invalid('parameter_missing', 'enter your email', 'customer_details[email]');
  const addressNeeded = collection.billingAddressCollection === 'required' || session.automaticTax;
  if (addressNeeded) {
    if (!details?.address?.country) {
      return invalid(
        'parameter_missing',
        'enter your billing address',
        'customer_details[address]',
      );
    }
    if (collection.billingAddressCollection === 'required' && !details.name) {
      return invalid('parameter_missing', 'enter your name', 'customer_details[name]');
    }
  }
  if (collection.phoneNumber && !details?.phone) {
    return invalid('parameter_missing', 'enter your phone number', 'customer_details[phone]');
  }
  if (collection.shippingCountries && !session.shippingDetails) {
    return invalid('parameter_missing', 'enter your shipping address', 'shipping_details');
  }
  const missing = session.customFields.find((field) => !field.optional && field.value === null);
  if (missing) {
    return invalid(
      'parameter_missing',
      `fill in ${missing.label}`,
      `custom_fields[${missing.key}]`,
    );
  }
  if (collection.termsOfService && session.consent?.terms_of_service !== 'accepted') {
    return invalid('parameter_missing', 'accept the terms of service', 'consent[terms_of_service]');
  }
  if (session.mode !== 'setup' && lines.every((line) => line.quantity === 0)) {
    return invalid('parameter_invalid', 'the order needs at least one item', 'line_items');
  }
  return null;
}

/** A customer for a session that needs one (setup mode; `customer_creation: always` at completion). */
async function customerFor(
  merchant: MerchantRow,
  session: CheckoutSessionRow,
): Promise<CustomerRow> {
  if (session.customerId) {
    const existing = await findCustomerById(getDb(), session.customerId);
    if (existing) return existing;
  }
  const details = session.customerDetails;
  const created = await getDb().transaction(async (tx) => {
    const row = await insertCustomer(tx, {
      publicId: newId('cus'),
      merchantId: merchant.id,
      metadata: {},
      email: emailOf(session),
      name: details?.name ?? null,
      phone: details?.phone ?? null,
      address: details?.address ?? null,
    });
    await recordCustomerObjectEvent(tx, merchant.id, 'customer.created', toCustomerDTO(row));
    return row;
  });
  kickWebhookOutbox();
  return created;
}

/** Hold the discount's redemption for this session, or refuse it — under the code's row lock. */
async function reserveDiscount(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  session: CheckoutSessionRow,
): Promise<DiscountRefusal | null> {
  if (session.promotionCodeId !== null) {
    const code = await lockPromotionCodeById(tx, session.promotionCodeId);
    if (!code) return 'promotion_code_inactive';
    if (code.maxRedemptions !== null) {
      const held = await countReservedRedemptions(tx, { promotionCodeId: code.id }, session.id);
      if (code.timesRedeemed + held >= code.maxRedemptions) return 'promotion_code_max_redemptions';
    }
  }
  if (session.couponId !== null) {
    const coupon = await lockCouponById(tx, session.couponId);
    if (!coupon || coupon.deletedAt !== null) return 'coupon_invalid';
    if (coupon.maxRedemptions !== null) {
      const held = await countReservedRedemptions(tx, { couponId: coupon.id }, session.id);
      if (coupon.timesRedeemed + held >= coupon.maxRedemptions) return 'coupon_invalid';
    }
  }
  return null;
}

function describeOrder(lines: readonly CheckoutLineItemRow[]): string | undefined {
  const sold = lines.filter((line) => line.quantity > 0);
  const first = sold[0];
  if (!first) return undefined;
  const text =
    sold.length === 1 ? first.description : `${first.description} and ${sold.length - 1} more`;
  return text.slice(0, 1000);
}

/**
 * `POST /v1/checkout_sessions/:id/public/confirm` — lock the order and create
 * its payment (or setup). Idempotent: a confirmed session answers as it is.
 */
export async function confirmSessionAsPayer(
  session: CheckoutSessionRow,
  merchant: MerchantRow,
  deps: CheckoutDeps = {},
): Promise<CheckoutSessionRow> {
  const now = deps.now?.() ?? new Date();
  if (session.status !== 'open') return session;
  if (session.paymentIntentId !== null || session.setupIntentId !== null) return session;
  if (session.expiresAt && session.expiresAt.getTime() <= now.getTime()) {
    throw invalid('checkout_session_expired', 'this checkout session has expired');
  }
  const db = getDb();
  let lines = await listLineItems(db, session.id);
  const missing = missingField(session, lines);
  if (missing) throw missing;

  // Re-price with a FRESH tax calculation: the one the payer last saw may have
  // expired, and the amount the payment is created for is the one committed.
  let current = session;
  if (session.mode !== 'setup') {
    const discount = await sessionDiscount(session);
    const { totals, tax } = await priceOrder(
      merchant,
      session,
      lines,
      new Map(lines.map((line) => [line.publicId, line.quantity])),
      discount,
      {
        customerId: session.customerId,
        email: emailOf(session),
        address: session.customerDetails?.address ?? null,
      },
      deps,
      session.promotionCodeId !== null ? 'promotion_code' : 'discounts',
    );
    if (session.automaticTax && tax.status !== 'complete') {
      throw invalid(
        'tax_calculation_failed',
        tax.status === 'requires_location_inputs'
          ? 'enter your billing address so tax can be calculated'
          : 'tax could not be calculated for this address, so this order cannot be paid',
        tax.status === 'requires_location_inputs' ? 'customer_details[address]' : 'automatic_tax',
      );
    }
    const priced = new Map(totals.lines.map((line) => [line.key, line]));
    const written = await db.transaction(async (tx) => {
      const locked = await lockSession(tx, session.id);
      if (!locked || locked.updatedAt.getTime() !== session.updatedAt.getTime()) return false;
      return writeSessionOrder(tx, session.id, {
        totals: {
          amountSubtotal: fromBaseUnits(totals.amountSubtotal),
          amountDiscount: fromBaseUnits(totals.amountDiscount),
          amountTax: fromBaseUnits(totals.amountTax),
          amountShipping: fromBaseUnits(totals.amountShipping),
          amountTotal: fromBaseUnits(totals.amountTotal),
        },
        lines: lines.map((line) => {
          const amounts = priced.get(line.publicId);
          return {
            id: line.id,
            quantity: line.quantity,
            amountSubtotal: fromBaseUnits(amounts?.amountSubtotal ?? 0n),
            amountDiscount: fromBaseUnits(amounts?.amountDiscount ?? 0n),
            amountTax: fromBaseUnits(amounts?.amountTax ?? 0n),
            amountTotal: fromBaseUnits(amounts?.amountTotal ?? 0n),
          };
        }),
        automaticTaxStatus: tax.status,
        taxCalculationId: tax.calculationId,
      });
    });
    if (!written) {
      throw new CheckoutError(
        409,
        'checkout_session_changed',
        'this checkout changed; reload and try again',
      );
    }
    const reread = await findSessionById(db, session.id);
    if (!reread) throw new Error(`session ${session.publicId} vanished`);
    current = reread;
    lines = await listLineItems(db, session.id);
  }

  if (current.mode === 'setup') {
    const customer = await customerFor(merchant, current);
    const { row: setup } = await createSetupIntent(merchant, customer, {
      usage: 'off_session',
      description: null,
      metadata: {},
    });
    const linked = await db.transaction((tx) =>
      linkSessionObject(tx, current.id, { setupIntentId: setup.id }, { customerId: customer.id }),
    );
    if (!linked)
      throw invalid('checkout_session_not_open', 'this checkout session is no longer open');
    return linked;
  }

  if (current.mode === 'subscription') {
    // The billing engine makes the subscription and the payment its first
    // invoice needs; the session wraps that payment exactly like a one-time one.
    const fulfiller = subscriptionCheckoutFulfiller();
    if (!fulfiller)
      throw invalid('mode_unavailable', 'subscription checkout is not available yet', 'mode');
    const customer = await customerFor(merchant, current);
    const { paymentIntentId } = await fulfiller.start({
      merchant,
      session: current,
      lines,
      customer,
    });
    const linked = await db.transaction(async (tx) => {
      const locked = await lockSession(tx, current.id);
      if (locked?.status !== 'open') return null;
      if ((await reserveDiscount(tx, locked)) !== null) return 'refused' as const;
      return linkSessionObject(tx, locked.id, { paymentIntentId }, { customerId: customer.id });
    });
    if (linked === 'refused') {
      throw discountError('promotion_code_max_redemptions', 'promotion_code');
    }
    if (!linked)
      throw invalid('checkout_session_not_open', 'this checkout session is no longer open');
    return linked;
  }

  // A discount that took the order to zero: nothing to pay, and nothing to
  // create — completion is immediate, and its redemption is counted under the
  // same lock the reservation would have taken.
  if (toBaseUnits(current.amount) === 0n) {
    const completed = await completeZeroAmountSession(current, reserveDiscount);
    if (completed === 'refused') {
      throw discountError(
        current.promotionCodeId !== null ? 'promotion_code_max_redemptions' : 'coupon_invalid',
        current.promotionCodeId !== null ? 'promotion_code' : 'discounts',
      );
    }
    return completed;
  }

  const email = emailOf(current);
  const shipping = current.shippingDetails;
  let intent: PaymentIntentRow;
  try {
    intent = (
      await createIntent({
        merchant,
        amount: current.amount,
        rail: current.rail,
        currency: current.currency,
        ...(current.network ? { network: current.network } : {}),
        ...(current.connectedAccountPublicId
          ? { connectedAccount: current.connectedAccountPublicId }
          : {}),
        ...(current.customerPublicId ? { customer: current.customerPublicId } : {}),
        ...(email ? { receiptEmail: email } : {}),
        ...(describeOrder(lines) ? { description: describeOrder(lines) } : {}),
        ...(shipping
          ? {
              shipping: {
                name: shipping.name,
                phone: current.customerDetails?.phone ?? null,
                address: shipping.address,
                carrier: null,
                tracking_number: null,
              },
            }
          : {}),
        ...(current.paymentLinkId ? { paymentLinkId: current.paymentLinkId } : {}),
        expiresInSeconds: Math.max(60, remainingSeconds(current.expiresAt, now)),
        // The session and its amount name the payment: a retried confirm finds
        // the payment the first one created, and a re-priced order a new one.
        idempotencyKey: `checkout:${current.publicId}:${current.amount}`,
        metadata: {},
      })
    ).intent;
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    return translateRail(error, 'payment_method_types');
  }

  const outcome = await db.transaction(async (tx) => {
    const locked = await lockSession(tx, current.id);
    if (locked?.status !== 'open') return { kind: 'moved' as const };
    if (locked.paymentIntentId === intent.id) return { kind: 'linked' as const, row: locked };
    if (locked.paymentIntentId !== null || locked.amount !== intent.amount) {
      return { kind: 'moved' as const };
    }
    const refusal = await reserveDiscount(tx, locked);
    if (refusal) return { kind: 'refused' as const, refusal };
    const linked = await linkSessionObject(tx, locked.id, { paymentIntentId: intent.id });
    return linked ? { kind: 'linked' as const, row: linked } : { kind: 'moved' as const };
  });
  if (outcome.kind === 'refused') {
    // The payment was created and will never be linked: cancel it, so no payer
    // can pay a price the order no longer has.
    await cancelOrphanIntent(intent);
    throw discountError(
      outcome.refusal,
      current.promotionCodeId !== null ? 'promotion_code' : 'discounts',
    );
  }
  if (outcome.kind === 'moved') {
    throw new CheckoutError(
      409,
      'checkout_session_changed',
      'this checkout changed; reload and try again',
    );
  }
  return outcome.row;
}

/** Cancel a payment a confirm created and could not link. Best effort: its own expiry covers a failure. */
async function cancelOrphanIntent(intent: PaymentIntentRow): Promise<void> {
  try {
    await cancelSessionPayment(intent);
  } catch (error) {
    process.emitWarning(
      `checkout: could not cancel unlinked payment ${intent.publicId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---- Expire ----------------------------------------------------------------------

type CancelOutcome = 'canceled' | 'already' | 'in_flight' | 'settled' | 'unknown';

/** Cancel a session's payment — at the provider first, then the transition (`cardCancellation.ts`). */
async function cancelSessionPayment(intent: PaymentIntentRow): Promise<CancelOutcome> {
  if (intent.status === 'canceled') return 'already';
  let next: ReturnType<typeof applyEvent>;
  try {
    next = applyEvent(intent.status, 'cancel', intent.rail);
  } catch {
    return intent.status === 'succeeded' ? 'settled' : 'in_flight';
  }
  const cancellation = await cancelCardPaymentAtProvider(
    intent,
    `cancel:${intent.publicId}`,
    'abandoned',
  );
  if (cancellation.kind === 'settled') return 'settled';
  if (cancellation.kind === 'in_flight') return 'in_flight';
  if (cancellation.kind === 'unknown') return 'unknown';
  const moved = await transitionIntent(intent.id, {
    from: intent.status,
    status: next,
    cancellationReason: 'abandoned',
  });
  if (moved.kind !== 'updated') return 'in_flight';
  announceIntentChange(moved.row);
  return 'canceled';
}

/**
 * `POST /v1/checkout_sessions/:id/expire` — only an OPEN session. Its payment,
 * if the payer confirmed, is cancelled first (at the provider, then here), and
 * the session expires WITH it in that transition (`completion.ts`); a payment
 * already in flight cannot be called off, and says so.
 */
export async function expireSessionForMerchant(
  session: CheckoutSessionRow,
): Promise<CheckoutSessionRow> {
  if (session.status !== 'open') {
    throw invalid(
      'checkout_session_not_open',
      `only an open checkout session can be expired; this one is ${session.status}`,
    );
  }
  const db = getDb();
  if (session.paymentIntentId !== null) {
    const intent = await findIntentById(db, session.paymentIntentId);
    if (!intent) throw new Error(`session ${session.publicId} wraps an unreadable intent`);
    const outcome = await cancelSessionPayment(intent);
    if (outcome === 'settled' || outcome === 'in_flight') {
      throw invalid(
        'checkout_session_not_open',
        'the payer is already paying this session; it cannot be expired',
      );
    }
    if (outcome === 'unknown') {
      throw new CheckoutError(
        502,
        'payment_cancellation_failed',
        'the payment could not be canceled at the provider; try again',
      );
    }
  }
  if (session.setupIntentId !== null) {
    const setup = await findSetupIntentById(db, session.setupIntentId);
    if (setup && setup.status !== 'succeeded' && setup.status !== 'canceled') {
      await cancelSetupIntent(setup, 'abandoned');
    }
  }
  const expired = await db.transaction(async (tx) => {
    const row = await expireSessionRow(tx, session.id);
    if (row) {
      await recordEvent(tx, {
        merchantId: row.merchantId,
        type: 'checkout.session.expired',
        object: toCheckoutSessionDTO(row),
        previousAttributes: { status: 'open' },
        account: row.connectedAccountPublicId,
      });
    }
    return row;
  });
  kickWebhookOutbox();
  const current = expired ?? (await findSessionById(db, session.id));
  if (!current) throw new Error(`session ${session.publicId} vanished`);
  if (current.status === 'complete') {
    throw invalid(
      'checkout_session_not_open',
      'this checkout session completed before it could be expired',
    );
  }
  return current;
}

/** An open session expired NOW (its deadline passed) — the test helper's clock; `null` when not open. */
export async function expireSessionNow(
  session: CheckoutSessionRow,
): Promise<CheckoutSessionRow | null> {
  const row = await getDb().transaction(async (tx) => {
    const expired = await expireSessionRow(tx, session.id);
    if (expired) {
      await recordEvent(tx, {
        merchantId: expired.merchantId,
        type: 'checkout.session.expired',
        object: toCheckoutSessionDTO(expired),
        previousAttributes: { status: 'open' },
        account: expired.connectedAccountPublicId,
      });
    }
    return expired;
  });
  kickWebhookOutbox();
  return row;
}

/** The card provider's public key for a session's mode, so its fields can mount before the payment exists. */
export function publishableKeyFor(session: CheckoutSessionRow): string | null {
  if (session.rail !== 'card') return null;
  return config.stripe[session.livemode ? 'live' : 'test']?.publishableKey ?? null;
}

export { setupClientSecretOf };

/** A setup session's SetupIntent as the payer needs it. */
async function setupClientSecretOf(session: CheckoutSessionRow) {
  if (session.setupIntentId === null) return null;
  const setup = await findSetupIntentById(getDb(), session.setupIntentId);
  return setup
    ? { id: setup.publicId, client_secret: setup.clientSecret, status: setup.status }
    : null;
}
