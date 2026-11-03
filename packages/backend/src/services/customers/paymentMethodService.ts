/**
 * Saved payment methods (`pm_…`, ADR 0016).
 *
 * ## How a `pm_…` comes to exist
 *
 * The card is collected by the provider's own Elements in the payer's browser,
 * so Peable never sees a card number — and never accepts a PROVIDER id where a
 * Peable one is expected (ADR 0016 D3). A `pm_…` is therefore BORN attached, in
 * exactly two ways, both from the provider's own word about a payment method it
 * already holds for this customer:
 *
 *  1. a SetupIntent succeeds (`setupIntentService.ts`), in the transaction that
 *     moves the SetupIntent, beside `setup_intent.succeeded`;
 *  2. a card PaymentIntent with `setup_future_usage` and a customer succeeds —
 *     the provider attaches the card it was paid with ({@link saveIntentPaymentMethod}).
 *
 * There is no `attach` endpoint: a detached method is dead (Stripe's model), and
 * re-attaching a provider method by its id is the provider-id door D3 shuts.
 */
import type { CardDetails } from '@peable.to/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import {
  detachPaymentMethod,
  findPaymentMethodForMerchant,
  registerPaymentMethod,
  type PaymentMethodRow,
} from '../../db/customers/paymentMethodRepository';
import {
  findIntentById,
  setIntentSavedPaymentMethod,
  type PaymentIntentRow,
} from '../../db/payments/paymentIntentRepository';
import { newId } from '../../lib/ids';
import { toPaymentMethodDTO } from '../../lib/serialize';
import { recordCustomerObjectEvent } from '../intentTransition';
import { kickWebhookOutbox } from '../webhookOutbox';
import { selectStoredProvider } from '../providers/environmentGuard';
import {
  isSetupHoldingProvider,
  type ProviderId,
  type ProviderPaymentMethodSnapshot,
} from '../providers/provider';

export class PaymentMethodsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentMethodsUnavailableError';
  }
}

/**
 * Register a provider method as a `pm_…` of this customer, in the CALLER's
 * transaction, with `payment_method.attached` — only when this call created it.
 */
export async function registerProviderPaymentMethod(
  tx: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly customerId: string;
    readonly provider: ProviderId;
    readonly snapshot: ProviderPaymentMethodSnapshot;
  },
): Promise<{ row: PaymentMethodRow; created: boolean }> {
  const card: CardDetails = params.snapshot.card;
  const registered = await registerPaymentMethod(tx, {
    publicId: newId('pm'),
    merchantId: params.merchantId,
    customerId: params.customerId,
    card,
    billingDetails: params.snapshot.billingDetails,
    provider: params.provider,
    providerObjectId: params.snapshot.providerObjectId,
  });
  if (registered.created) {
    await recordCustomerObjectEvent(
      tx,
      params.merchantId,
      'payment_method.attached',
      toPaymentMethodDTO(registered.row),
    );
  }
  return registered;
}

/** Detach a method at the provider — the card can never be charged there again. */
export async function detachAtProvider(method: PaymentMethodRow): Promise<void> {
  const provider = selectStoredProvider(method.provider, method.livemode);
  if (!provider || !isSetupHoldingProvider(provider)) {
    throw new PaymentMethodsUnavailableError(
      `the ${method.provider} rail is not configured for ${method.livemode ? 'live' : 'test'} mode on this deployment`,
    );
  }
  await provider.detachPaymentMethod({
    providerObjectId: method.providerObjectId,
    idempotencyKey: `pmdetach:${method.publicId}`,
  });
}

/**
 * Detach a merchant's `pm_…`: at the PROVIDER first — a method detached only
 * here could still be charged there — then locally with the customer's default
 * cleared and `payment_method.detached`, in one transaction.
 *
 * @returns the detached row; the row unchanged when it was already detached;
 *   `null` when the merchant has no such method.
 */
export async function detachPaymentMethodForMerchant(
  merchantId: string,
  publicId: string,
): Promise<{ row: PaymentMethodRow; detached: boolean } | null> {
  const db = getDb();
  const method = await findPaymentMethodForMerchant(db, publicId, merchantId);
  if (!method) return null;
  if (method.detachedAt !== null) return { row: method, detached: false };
  await detachAtProvider(method);
  const row = await db.transaction(async (tx) => {
    const detached = await detachPaymentMethod(tx, method.id);
    if (detached) {
      await recordCustomerObjectEvent(
        tx,
        merchantId,
        'payment_method.detached',
        toPaymentMethodDTO(detached),
      );
    }
    return detached;
  });
  if (row) kickWebhookOutbox();
  return { row: row ?? method, detached: row !== null };
}

/**
 * A card payment that SAVED its card (`setup_future_usage` with a customer)
 * has succeeded: register the provider's payment method as the customer's
 * `pm_…`, and record it on the intent.
 *
 * Best-effort and OUTSIDE the status transaction, deliberately: it needs two
 * provider reads (the payment's method, then the method), and the payment's
 * success must never wait on — or roll back with — a card being saved. It is
 * idempotent (`unique (provider, provider_object_id)`), so the drain's
 * `payment_intent.succeeded`, a reconciliation and a server-side confirm can all
 * call it and converge on one `pm_…`.
 */
export async function saveIntentPaymentMethod(intent: PaymentIntentRow): Promise<void> {
  if (
    intent.rail !== 'card' ||
    intent.status !== 'succeeded' ||
    intent.setupFutureUsage === null ||
    intent.customerId === null ||
    intent.paymentMethodId !== null ||
    !intent.provider ||
    !intent.providerObjectId
  ) {
    return;
  }
  const provider = selectStoredProvider(intent.provider, intent.livemode);
  if (!provider || !isSetupHoldingProvider(provider)) return;
  try {
    const payment = await provider.getStatus(intent.providerObjectId);
    if (payment.paymentMethodObjectId === undefined) return;
    const snapshot = await provider.getPaymentMethod(payment.paymentMethodObjectId);
    const customerId = intent.customerId;
    await getDb().transaction(async (tx) => {
      const fresh = await findIntentById(tx, intent.id);
      if (!fresh || fresh.paymentMethodId !== null) return;
      const { row } = await registerProviderPaymentMethod(tx, {
        merchantId: intent.merchantId,
        customerId,
        provider: provider.id,
        snapshot,
      });
      await setIntentSavedPaymentMethod(tx, intent.id, row.id);
    });
    kickWebhookOutbox();
  } catch {
    // Best-effort: the next `payment_intent.succeeded` delivery or
    // reconciliation reaches here again.
  }
}
