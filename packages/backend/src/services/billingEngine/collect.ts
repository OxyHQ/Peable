/**
 * Collecting an invoice (ADR 0018 §1): the provider is used ONLY here.
 *
 * - **Card**: one PaymentIntent per invoice, created for the amount still due
 *   against the customer's saved method and confirmed OFF-SESSION. The intent
 *   is linked to the invoice BEFORE it is confirmed, so the payment hook below
 *   — which runs inside the intent's own transition transaction — always finds
 *   the invoice it pays. A retry re-confirms the same intent; an intent whose
 *   amount no longer matches (a credit note moved it) is cancelled and
 *   replaced.
 * - **FairCoin**: never a debit (ADR 0016 §4). Paying is the PAYER's act: the
 *   hosted invoice page asks for a FairCoin PaymentIntent for the amount due,
 *   whose `next_action.faircoin_payment` the payer's wallet pays. The same
 *   invoice answers the same intent while it can still be paid.
 *
 * ## The payment hook
 *
 * {@link onInvoicePaymentTransition} is called by `transitionIntent` in the
 * transaction that moves an intent — the invoice, its subscription and their
 * events commit WITH the payment, or not at all (ADR 0018 §4, ADR 0001 D7):
 *
 * - `succeeded` → the invoice is `paid` (tax committed, subscription active);
 * - a decline → `invoice.payment_failed`, the attempt counted and the next
 *   retry scheduled from the merchant's dunning settings, the subscription
 *   `past_due`; after the last retry, the final action;
 * - `requires_action` → `invoice.payment_action_required` (the payer must
 *   authenticate: the hosted invoice page completes it);
 * - `canceled` → the invoice forgets the intent, so the next attempt makes one.
 */
import { randomUUID } from 'node:crypto';
import type { CurrencyCode } from '@peable.to/shared-types';
import {
  findSessionByIntentId,
  replaceSessionPayment,
} from '../../db/payments/checkoutSessionRepository';
import { findCustomerById } from '../../db/customers/customerRepository';
import {
  findPaymentMethodById,
  findPaymentMethodForMerchant,
  type PaymentMethodRow,
} from '../../db/customers/paymentMethodRepository';
import { findMerchantById, type MerchantRow } from '../../db/merchants/merchantRepository';
import { findIntentById, type PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import {
  findInvoiceById,
  listPaidSubscriptionIntents,
  lockInvoice,
  lockInvoiceByPaymentIntent,
  type InvoiceRow,
} from '../../db/billingEngine/invoiceRepository';
import { ensureBillingSettings } from '../../db/billingEngine/settingsRepository';
import {
  findSubscriptionById,
  lockSubscription,
} from '../../db/billingEngine/subscriptionRepository';
import { getDb, type Transaction } from '../../db/postgres';
import { renderInvoice } from '../../lib/serializeBilling';
import { cancelCardPaymentAtProvider } from '../cardCancellation';
import { confirmCardIntent } from '../confirmIntent';
import { createIntent } from '../createIntent';
import { retireIfNoLongerOffered } from '../faircoin/keyBinding';
import { FaircoinNetworkClosedError, FaircoinWalletMissingError } from '../faircoin/recipient';
import { FaircoinCapacityError } from '../faircoin/addressPool';
import { announceIntentChange, transitionIntent, transitionIntentIn } from '../intentTransition';
import {
  type FaircoinQuote,
  FaircoinPriceUnavailableError,
  quoteFaircoin,
  toFaircoinQuoteDTO,
} from '../faircoin/quote';
import { ProviderError, isRetryableProviderError } from '../providers/provider';
import { kickWebhookOutbox } from '../webhookOutbox';
import { BillingEngineError } from './errors';
import { markInvoicePaid, markUncollectibleInTx } from './invoiceEngine';
import { owePaymentFailedEmail } from './notices';
import { addDays } from './periods';
import { engineNow } from './runtime';
import {
  patchInvoice,
  patchSubscription,
  recordBillingEvent,
  transitionSubscription,
} from './transitions';

/** How long a provider outage defers an automatic attempt (it does not count as one). */
const PROVIDER_RETRY_MS = 3600_000;
/** How long a payer has to pay a FairCoin invoice intent before it expires. */
const FAIRCOIN_INVOICE_PAYMENT_SECONDS = 60 * 60;

function remainingOf(invoice: InvoiceRow): bigint {
  const left =
    BigInt(invoice.amountDue) -
    BigInt(invoice.amountPaid) -
    BigInt(invoice.prePaymentCreditNotesAmount);
  return left > 0n ? left : 0n;
}

export function railOf(currency: CurrencyCode): 'card' | 'faircoin' {
  return currency === 'FAIR' ? 'faircoin' : 'card';
}

/** The saved method an automatic attempt charges: the invoice's, the subscription's, the customer's. */
async function chargeableMethod(invoice: InvoiceRow): Promise<PaymentMethodRow | null> {
  const db = getDb();
  let id = invoice.defaultPaymentMethodId;
  if (!id && invoice.subscriptionId) {
    id = (await findSubscriptionById(db, invoice.subscriptionId))?.defaultPaymentMethodId ?? null;
  }
  if (!id) id = (await findCustomerById(db, invoice.customerId))?.defaultPaymentMethodId ?? null;
  // A subscription started on-session (a checkout) saved the card its first
  // invoice was paid with: that card pays its renewals.
  if (!id && invoice.subscriptionId) id = await savedSubscriptionMethod(invoice.subscriptionId);
  if (!id) return null;
  const method = await findPaymentMethodById(db, id);
  return method && method.customerId === invoice.customerId ? method : null;
}

/** The method a subscription's paid invoice saved (`setup_future_usage`), newest first. */
async function savedSubscriptionMethod(subscriptionId: string): Promise<string | null> {
  const db = getDb();
  const paid = await listPaidSubscriptionIntents(db, subscriptionId);
  for (const intentId of paid) {
    const intent = await findIntentById(db, intentId);
    if (intent?.paymentMethodId) return intent.paymentMethodId;
  }
  return null;
}

/** Cancel an invoice intent the invoice no longer wants (its amount moved). */
async function retireIntent(intent: PaymentIntentRow): Promise<boolean> {
  if (
    !['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status)
  ) {
    return false;
  }
  if (intent.rail === 'card') {
    const outcome = await cancelCardPaymentAtProvider(intent, `invoice-retire:${intent.publicId}`);
    if (outcome.kind !== 'canceled' && outcome.kind !== 'nothing_to_cancel') return false;
  }
  const result = await transitionIntent(intent.id, {
    from: intent.status,
    status: 'canceled',
    cancellationReason: 'abandoned',
  });
  if (result.kind === 'updated') announceIntentChange(result.row);
  return result.kind === 'updated';
}

/**
 * The intent that collects `invoice` now: the linked one while it still asks
 * for the amount due, or a new one (linked under a CAS on the invoice's
 * current link, so two attempts cannot both link one).
 */
async function intentFor(
  merchant: MerchantRow,
  invoice: InvoiceRow,
  rail: 'card' | 'faircoin',
  method: PaymentMethodRow | null,
): Promise<PaymentIntentRow> {
  const db = getDb();
  const amount = remainingOf(invoice);
  if (invoice.paymentIntentId) {
    const linked = await findIntentById(db, invoice.paymentIntentId);
    if (
      linked &&
      linked.status !== 'canceled' &&
      ((linked.rail === rail &&
        orderAmountOfIntent(linked) === amount.toString() &&
        quoteHasTime(linked)) ||
        ['processing', 'succeeded', 'requires_capture'].includes(linked.status))
    ) {
      return linked;
    }
    if (linked && linked.status !== 'canceled' && !(await retireIntent(linked))) {
      throw new BillingEngineError(
        'invoice_unexpected_state',
        'a payment of this invoice is in flight; wait for it to finish',
        undefined,
        409,
      );
    }
  }
  const created = await createInvoiceIntent(merchant, invoice, rail, method, amount);
  // `createIntent` answers the row it inserted; the provider object was linked after.
  const fresh = (await findIntentById(db, created.id)) ?? created;
  const linked = await db.transaction(async (tx) => {
    const locked = await lockInvoice(tx, invoice.id);
    if (!locked || locked.paymentIntentId !== invoice.paymentIntentId) return false;
    await patchInvoice(tx, locked, { paymentIntentId: created.id }, { record: false });
    return true;
  });
  if (!linked) {
    await retireIntent(fresh);
    throw new BillingEngineError(
      'invoice_unexpected_state',
      'another payment of this invoice started at the same time',
      undefined,
      409,
    );
  }
  return fresh;
}

/** The order amount an invoice payment pays: a quoted FairCoin payment's is its quote's. */
function orderAmountOfIntent(intent: PaymentIntentRow): string {
  return intent.faircoinQuote?.amount ?? intent.amount;
}

/** A quote lapsing within this long is not handed to a payer. */
const QUOTE_MIN_REMAINING_MS = 60_000;

/** Whether a quoted payment's quote still has time on it (an unquoted one always has). */
function quoteHasTime(intent: PaymentIntentRow): boolean {
  const quote = intent.faircoinQuote;
  return quote === null || quote.expires_at * 1000 - Date.now() > QUOTE_MIN_REMAINING_MS;
}

/**
 * Create — not link — the payment that collects `amount` of `invoice` on
 * `rail`. FairCoin on a FIAT invoice is quoted first (ADR 0021 D4): the
 * payment is for the quoted FAIR amount, carries the quote and expires with it.
 */
async function createInvoiceIntent(
  merchant: MerchantRow,
  invoice: InvoiceRow,
  rail: 'card' | 'faircoin',
  method: PaymentMethodRow | null,
  amount: bigint,
): Promise<PaymentIntentRow> {
  const db = getDb();
  const customer = await findCustomerById(db, invoice.customerId);
  if (!customer) throw new Error('invoice customer vanished');
  let quoted: FaircoinQuote | null = null;
  if (rail === 'faircoin' && invoice.currency !== 'FAIR') {
    try {
      quoted = await quoteFaircoin(invoice.currency, amount.toString());
    } catch (error) {
      if (!(error instanceof FaircoinPriceUnavailableError)) throw error;
      throw new BillingEngineError(
        'faircoin_price_unavailable',
        'FairCoin cannot be priced right now; pay another way or try FairCoin again shortly',
        'payment_method_type',
        503,
      );
    }
  }
  const quoteSeconds = quoted
    ? Math.max(60, Math.floor((quoted.expiresAt.getTime() - Date.now()) / 1000))
    : null;
  let created: Awaited<ReturnType<typeof createIntent>>;
  try {
    created = await createIntent({
      merchant,
      amount: quoted ? quoted.faircoinAmount : amount.toString(),
      rail,
      currency: quoted ? 'FAIR' : invoice.currency,
      ...(quoted ? { faircoinQuote: toFaircoinQuoteDTO(quoted) } : {}),
      ...(rail === 'faircoin' && merchant.network ? { network: merchant.network } : {}),
      customer: customer.publicId,
      ...(rail === 'card' && method ? { paymentMethod: method.publicId } : {}),
      // A subscription the payer starts on-session saves the card it is paid
      // with, so its renewals can be charged off-session.
      ...(rail === 'card' &&
      !method &&
      invoice.subscriptionId &&
      invoice.collectionMethod === 'charge_automatically'
        ? { setupFutureUsage: 'off_session' as const }
        : {}),
      description: `Invoice ${invoice.number ?? invoice.publicId}`,
      metadata: { invoice: invoice.publicId },
      // A fresh key per replacement: the previous intent was retired.
      idempotencyKey: `invoice:${invoice.publicId}:${randomUUID()}`,
      ...(quoteSeconds !== null
        ? { expiresInSeconds: Math.min(quoteSeconds, FAIRCOIN_INVOICE_PAYMENT_SECONDS) }
        : rail === 'faircoin'
          ? { expiresInSeconds: FAIRCOIN_INVOICE_PAYMENT_SECONDS }
          : {}),
    });
  } catch (error) {
    // The owner's Peable wallet is not set up, or the network is not open (ADR
    // 0021 D5): FairCoin cannot pay this invoice yet; a card still can.
    if (error instanceof FaircoinWalletMissingError) {
      throw new BillingEngineError(
        'faircoin_wallet_missing',
        error.message,
        'payment_method_type',
        409,
      );
    }
    if (error instanceof FaircoinNetworkClosedError) {
      throw new BillingEngineError(
        'faircoin_network_closed',
        error.message,
        'payment_method_type',
        409,
      );
    }
    // Every address the recipient can hold open is open (ADR 0021 D9).
    if (error instanceof FaircoinCapacityError) {
      throw new BillingEngineError(
        'faircoin_capacity_reached',
        error.message,
        'payment_method_type',
        503,
      );
    }
    throw error;
  }
  return created.intent;
}

export type AttemptOutcome =
  | { readonly kind: 'attempted'; readonly invoice: InvoiceRow; readonly intent: PaymentIntentRow }
  | { readonly kind: 'no_payment_method'; readonly invoice: InvoiceRow }
  | { readonly kind: 'deferred'; readonly invoice: InvoiceRow };

/**
 * Charge an open card invoice off-session against a saved method.
 * `paymentMethod` (a `pm_…` of the customer) overrides the defaults.
 */
export async function attemptInvoicePayment(
  invoiceId: string,
  options: { readonly paymentMethod?: string; readonly offSession?: boolean } = {},
): Promise<AttemptOutcome> {
  const db = getDb();
  const invoice = await findInvoiceById(db, invoiceId);
  if (!invoice)
    throw new BillingEngineError('resource_missing', 'invoice not found', undefined, 404);
  if (invoice.status !== 'open' && invoice.status !== 'uncollectible') {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      `this invoice is ${invoice.status}; only an open or uncollectible invoice can be paid`,
    );
  }
  if (railOf(invoice.currency) === 'faircoin') {
    throw new BillingEngineError(
      'faircoin_cannot_debit',
      'a FairCoin invoice is paid by the payer from their wallet, on its hosted invoice page',
    );
  }
  const merchant = await findMerchantById(db, invoice.merchantId);
  if (!merchant) throw new Error('invoice merchant vanished');
  let method: PaymentMethodRow | null;
  if (options.paymentMethod !== undefined) {
    method = await findPaymentMethodForMerchant(db, options.paymentMethod, merchant.id);
    if (!method || method.customerId !== invoice.customerId) {
      throw new BillingEngineError(
        'resource_missing',
        `no payment method '${options.paymentMethod}' attached to this invoice's customer`,
        'payment_method',
      );
    }
  } else method = await chargeableMethod(invoice);
  if (!method) return { kind: 'no_payment_method', invoice };
  const customer = await findCustomerById(db, invoice.customerId);
  if (!customer) throw new Error('invoice customer vanished');
  try {
    const intent = await intentFor(merchant, invoice, 'card', method);
    if (intent.status === 'succeeded' || intent.status === 'processing') {
      return {
        kind: 'attempted',
        invoice: (await findInvoiceById(db, invoice.id)) ?? invoice,
        intent,
      };
    }
    const outcome = await confirmCardIntent({
      intent,
      paymentMethod: method,
      customer,
      offSession: options.offSession ?? true,
      idempotencyKey: `invoice-attempt:${invoice.publicId}:${invoice.attemptCount + 1}`,
    });
    if (outcome.kind === 'unavailable') {
      return { kind: 'deferred', invoice: await deferAttempt(invoice) };
    }
    await settleAttemptSchedule(invoice.id);
    const after = (await findInvoiceById(db, invoice.id)) ?? invoice;
    const current = outcome.kind === 'confirmed' ? outcome.intent : (outcome.current ?? intent);
    return { kind: 'attempted', invoice: after, intent: current };
  } catch (error) {
    if (error instanceof ProviderError && isRetryableProviderError(error)) {
      return { kind: 'deferred', invoice: await deferAttempt(invoice) };
    }
    throw error;
  }
}

/**
 * An attempt that did not end in a scheduled retry (the payment is
 * processing, or waits on the payer's authentication) leaves nothing for the
 * scheduler to do: the payment's own outcome moves the invoice.
 */
async function settleAttemptSchedule(invoiceId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const locked = await lockInvoice(tx, invoiceId);
    if (locked?.status !== 'open' || locked.nextPaymentAttempt === null) return;
    const now = await engineNow(tx, locked.testClockId);
    if (locked.nextPaymentAttempt.getTime() > now.getTime()) return;
    await patchInvoice(
      tx,
      locked,
      { nextPaymentAttempt: null, nextActionAt: null },
      { record: false },
    );
  });
}

/** A provider outage: try again later without spending a dunning attempt. */
async function deferAttempt(invoice: InvoiceRow): Promise<InvoiceRow> {
  return getDb().transaction(async (tx) => {
    const locked = await lockInvoice(tx, invoice.id);
    if (!locked) throw new Error('invoice vanished');
    const now = await engineNow(tx, locked.testClockId);
    const retry = new Date(now.getTime() + PROVIDER_RETRY_MS);
    return patchInvoice(
      tx,
      locked,
      { nextPaymentAttempt: retry, nextActionAt: retry },
      { record: false },
    );
  });
}

/**
 * An automatic attempt with no method to charge: a failed attempt like a
 * decline (dunning runs), recorded by the engine.
 */
export async function recordMissingPaymentMethod(invoiceId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const invoice = await lockInvoice(tx, invoiceId);
    if (invoice?.status !== 'open') return;
    await recordFailedAttempt(tx, invoice, await engineNow(tx, invoice.testClockId));
  });
  kickWebhookOutbox();
}

/**
 * The intent a payer completes on an invoice's hosted page (or a subscription
 * checkout), in the method they chose (ADR 0021 D3): the card rail of a fiat
 * invoice, or FairCoin — always offered, quoted on a fiat invoice. A linked
 * payment that answers the choice is answered as it is; one in the other
 * method that has not moved money is REPLACED (`replaceInvoicePayment`).
 */
export async function payerIntentForInvoice(
  invoice: InvoiceRow,
  paymentMethodType?: 'card' | 'faircoin',
): Promise<PaymentIntentRow> {
  if (invoice.status !== 'open' && invoice.status !== 'uncollectible') {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      `this invoice is ${invoice.status} and cannot be paid`,
    );
  }
  const rail = paymentMethodType ?? railOf(invoice.currency);
  if (rail === 'card' && invoice.currency === 'FAIR') {
    throw new BillingEngineError(
      'parameter_invalid',
      'a FAIR invoice is paid in FairCoin',
      'payment_method_type',
    );
  }
  const db = getDb();
  const merchant = await findMerchantById(db, invoice.merchantId);
  if (!merchant) throw new Error('invoice merchant vanished');
  let current = invoice;
  let linked = invoice.paymentIntentId ? await findIntentById(db, invoice.paymentIntentId) : null;
  // A FairCoin payment whose recipient key was replaced is never handed to a
  // payer again (ADR 0002, amended 2026-11-06): it is retired, the invoice
  // forgets it in that transaction, and the payer is answered a fresh one.
  if (linked?.rail === 'faircoin' && linked.status === 'requires_action') {
    const after = await retireIfNoLongerOffered(linked);
    if (after.status === 'canceled') {
      current = (await findInvoiceById(db, invoice.id)) ?? invoice;
      linked = null;
    }
  }
  if (
    linked &&
    REPLACEABLE.has(linked.status) &&
    linked.txid === null &&
    (linked.rail !== rail || !quoteHasTime(linked))
  ) {
    return replaceInvoicePayment(merchant, current, linked, rail);
  }
  return intentFor(merchant, current, rail, null);
}

/** Statuses in which no money has started to move, so a payment can still be replaced. */
const REPLACEABLE: ReadonlySet<PaymentIntentRow['status']> = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);

/**
 * Replace an invoice's unpaid payment with one on `rail` (ADR 0021 D3): the new
 * payment is created, then ONE transaction links it to the invoice — and to the
 * checkout session that wrapped the old one, if any — and cancels the old one,
 * linking first so the old payment's cancellation finds neither. A card is
 * cancelled at the provider before that transaction; a card that might still be
 * charged stays the invoice's payment.
 */
async function replaceInvoicePayment(
  merchant: MerchantRow,
  invoice: InvoiceRow,
  old: PaymentIntentRow,
  rail: 'card' | 'faircoin',
): Promise<PaymentIntentRow> {
  const db = getDb();
  if (old.rail === 'card') {
    const outcome = await cancelCardPaymentAtProvider(
      old,
      `invoice-retire:${old.publicId}`,
      'requested_by_customer',
    );
    if (outcome.kind !== 'canceled' && outcome.kind !== 'nothing_to_cancel') {
      throw new BillingEngineError(
        'invoice_unexpected_state',
        'a card payment of this invoice is in flight; wait for it to finish',
        undefined,
        409,
      );
    }
  }
  const fresh = await createInvoiceIntent(merchant, invoice, rail, null, remainingOf(invoice));
  const replaced = await db
    .transaction(async (tx) => {
      const locked = await lockInvoice(tx, invoice.id);
      if (!locked || locked.paymentIntentId !== old.id) return null;
      await patchInvoice(tx, locked, { paymentIntentId: fresh.id }, { record: false });
      const session = await findSessionByIntentId(tx, old.id);
      if (session && !(await replaceSessionPayment(tx, session.id, old.id, fresh.id))) {
        throw new ReplacementAbandoned();
      }
      const moved = await transitionIntentIn(tx, old.id, {
        from: old.status,
        status: 'canceled',
        cancellationReason: 'requested_by_customer',
      });
      if (moved.kind !== 'updated') throw new ReplacementAbandoned();
      return moved.row;
    })
    .catch((error: unknown) => {
      if (error instanceof ReplacementAbandoned) return null;
      throw error;
    });
  if (!replaced) {
    await retireIntent(fresh);
    throw new BillingEngineError(
      'invoice_unexpected_state',
      'this invoice changed while its payment was being replaced; try again',
      undefined,
      409,
    );
  }
  announceIntentChange(replaced);
  kickWebhookOutbox();
  return (await findIntentById(db, fresh.id)) ?? fresh;
}

/** Rolls a replacement back: something it would have changed moved meanwhile. */
class ReplacementAbandoned extends Error {
  constructor() {
    super('the payment replacement was abandoned');
    this.name = 'ReplacementAbandoned';
  }
}

// ---- The payment hook ---------------------------------------------------------

/**
 * Called by `transitionIntent` inside the intent's transition transaction.
 * Does nothing for an intent that collects no invoice.
 */
export async function onInvoicePaymentTransition(
  tx: Transaction,
  intent: PaymentIntentRow,
  from: PaymentIntentRow['status'],
): Promise<void> {
  const invoice = await lockInvoiceByPaymentIntent(tx, intent.id);
  if (!invoice) return;
  const now = await engineNow(tx, invoice.testClockId);
  if (intent.status === 'succeeded') {
    if (invoice.status !== 'open' && invoice.status !== 'uncollectible') return;
    // A quoted FairCoin payment pays the invoice's fiat amount it was quoted
    // for (ADR 0021 D3); its own amount is FAIR.
    const quote = intent.faircoinQuote;
    await markInvoicePaid(tx, invoice, now, {
      amountPaid: BigInt(
        quote !== null
          ? quote.amount
          : intent.amountReceived === '0'
            ? intent.amount
            : intent.amountReceived,
      ),
      countAttempt: intent.rail === 'card',
    });
    if (quote !== null) await invoiceFaircoinSubscription(tx, invoice);
    return;
  }
  if (invoice.status !== 'open') return;
  if (intent.status === 'requires_payment_method' && intent.lastPaymentError !== null) {
    await recordFailedAttempt(tx, invoice, now);
    return;
  }
  if (intent.status === 'requires_action' && intent.rail === 'card' && from !== 'requires_action') {
    const row = await patchInvoice(
      tx,
      invoice,
      { attemptCount: invoice.attemptCount + 1, nextPaymentAttempt: null, nextActionAt: null },
      { record: false },
    );
    await recordBillingEvent(
      tx,
      row.merchantId,
      'invoice.payment_action_required',
      await renderInvoice(tx, row),
    );
    await markSubscriptionPastDue(tx, row);
    return;
  }
  if (intent.status === 'canceled') {
    await patchInvoice(tx, invoice, { paymentIntentId: null }, { record: false });
  }
}

/**
 * FairCoin is never debited (ADR 0018 §3): a fiat subscription whose FIRST
 * invoice the payer paid in FairCoin is invoiced from then on — every renewal
 * an invoice the payer pays on its hosted page, by card or FairCoin, at that
 * period's quote (ADR 0021 D3). A card-started subscription keeps its saved card.
 */
async function invoiceFaircoinSubscription(tx: Transaction, invoice: InvoiceRow): Promise<void> {
  if (!invoice.subscriptionId || invoice.billingReason !== 'subscription_create') return;
  const subscription = await lockSubscription(tx, invoice.subscriptionId);
  if (!subscription || subscription.collectionMethod === 'send_invoice') return;
  const settings = await ensureBillingSettings(tx, subscription.merchantId);
  await patchSubscription(tx, subscription, {
    collectionMethod: 'send_invoice',
    daysUntilDue: settings.defaultDaysUntilDue,
    defaultPaymentMethodId: null,
  });
}

/** A renewal that could not be collected leaves its subscription `past_due`. */
async function markSubscriptionPastDue(tx: Transaction, invoice: InvoiceRow): Promise<void> {
  if (!invoice.subscriptionId || invoice.billingReason === 'subscription_create') return;
  const subscription = await lockSubscription(tx, invoice.subscriptionId);
  if (subscription?.status === 'active' && subscription.latestInvoiceId === invoice.id) {
    await transitionSubscription(tx, subscription, 'past_due');
  }
}

/**
 * Count a failed attempt and schedule what dunning does next: the next retry
 * `retry_schedule_days[n-1]` days after this attempt, or — the schedule spent
 * — the merchant's final action. A subscription's FIRST invoice is not dunned:
 * the subscription stays `incomplete` until it is paid or expires.
 */
export async function recordFailedAttempt(
  tx: Transaction,
  invoice: InvoiceRow,
  now: Date,
): Promise<InvoiceRow> {
  const settings = await ensureBillingSettings(tx, invoice.merchantId);
  const attempts = invoice.attemptCount + 1;
  const dunned =
    invoice.billingReason !== 'subscription_create' &&
    invoice.collectionMethod === 'charge_automatically';
  const delay = dunned ? settings.retryScheduleDays[attempts - 1] : undefined;
  const next = delay !== undefined ? addDays(now, delay) : null;
  let row = await patchInvoice(
    tx,
    invoice,
    { attemptCount: attempts, nextPaymentAttempt: next, nextActionAt: next },
    { record: false },
  );
  await recordBillingEvent(
    tx,
    row.merchantId,
    'invoice.payment_failed',
    await renderInvoice(tx, row),
  );
  await owePaymentFailedEmail(tx, row);
  await markSubscriptionPastDue(tx, row);
  if (dunned && next === null) row = await runFinalDunningAction(tx, row, now);
  return row;
}

/**
 * The schedule is spent: the invoice's action (`mark_uncollectible` or leave
 * it open), then the subscription's (`cancel`, `unpaid`, or leave it
 * `past_due`). Runs once per invoice (`dunning_exhausted_at`).
 */
export async function runFinalDunningAction(
  tx: Transaction,
  invoice: InvoiceRow,
  now: Date,
): Promise<InvoiceRow> {
  if (invoice.dunningExhaustedAt !== null) return invoice;
  const settings = await ensureBillingSettings(tx, invoice.merchantId);
  let row = await patchInvoice(
    tx,
    invoice,
    { dunningExhaustedAt: now, nextPaymentAttempt: null, nextActionAt: null },
    { record: false },
  );
  if (settings.invoiceAction === 'mark_uncollectible' && row.status === 'open') {
    row = await markUncollectibleInTx(tx, row, now);
  }
  if (!row.subscriptionId) return row;
  const subscription = await lockSubscription(tx, row.subscriptionId);
  if (!subscription || subscription.latestInvoiceId !== row.id) return row;
  if (!['active', 'past_due'].includes(subscription.status)) return row;
  if (settings.finalAction === 'cancel') {
    await transitionSubscription(tx, subscription, 'canceled', {
      canceledAt: now,
      endedAt: now,
      cancellationReason: 'payment_failed',
      nextActionAt: null,
    });
  } else if (settings.finalAction === 'unpaid') {
    await transitionSubscription(tx, subscription, 'unpaid');
  } else if (subscription.status === 'active') {
    await transitionSubscription(tx, subscription, 'past_due');
  }
  return row;
}
