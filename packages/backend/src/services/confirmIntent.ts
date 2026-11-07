/**
 * Confirm a CARD payment server-side with a saved payment method (ADR 0019) —
 * the one path behind `POST /v1/payment_intents/:id/confirm` and an invoice's
 * off-session collection (ADR 0018), so a merchant's confirm and the billing
 * engine's cannot drift apart.
 *
 * The method (and what came with it) is recorded first, under the status CAS:
 * a confirmation racing another cannot repoint a payment that moved. The
 * provider's answer then goes through `applyProviderPaymentResult`, the one
 * path every provider answer takes — a decline is an answer
 * (`requires_payment_method` with `last_payment_error`), not an error.
 *
 * @throws {ProviderError} when the provider could not be asked or refused the request.
 */
import type { PaymentIntentSetupFutureUsage, Shipping } from '@peable.to/shared-types';
import type { CustomerRow } from '../db/customers/customerRepository';
import type { PaymentMethodRow } from '../db/customers/paymentMethodRepository';
import {
  findIntentById,
  setIntentPaymentMethod,
  type PaymentIntentRow,
} from '../db/payments/paymentIntentRepository';
import { getDb } from '../db/postgres';
import { ensureProviderCustomer } from './customers/providerCustomer';
import { applyProviderPaymentResult } from './intentReconciliation';
import { gateBeforeAuthorization } from './radar/gates';
import { selectStoredProvider } from './providers/environmentGuard';

export type ConfirmOutcome =
  | { readonly kind: 'confirmed'; readonly intent: PaymentIntentRow }
  /**
   * A risk rule declined the attempt on a payment whose card is attached at
   * the provider (`requires_confirmation`): nothing was confirmed and the row
   * is as it was; the answer is the decline (ADR 0022 D3).
   */
  | { readonly kind: 'blocked'; readonly intent: PaymentIntentRow }
  | { readonly kind: 'stale'; readonly current: PaymentIntentRow | null }
  | { readonly kind: 'unavailable' };

export async function confirmCardIntent(input: {
  readonly intent: PaymentIntentRow;
  readonly paymentMethod: PaymentMethodRow;
  readonly customer: CustomerRow;
  readonly offSession?: boolean | undefined;
  readonly setupFutureUsage?: PaymentIntentSetupFutureUsage | undefined;
  readonly receiptEmail?: string | undefined;
  readonly shipping?: Shipping | undefined;
  readonly returnUrl?: string | undefined;
  /** One provider operation per Peable request: the same key is the same confirmation. */
  readonly idempotencyKey: string;
}): Promise<ConfirmOutcome> {
  const { intent, paymentMethod, customer } = input;
  const provider = intent.provider
    ? selectStoredProvider(intent.provider, intent.livemode)
    : undefined;
  if (!provider || !intent.providerObjectId) return { kind: 'unavailable' };
  // The merchant's risk rules judge the attempt BEFORE the provider is asked
  // (ADR 0022 D3), with the saved card's facts. A block is a declined attempt
  // on the row, answered like any decline.
  const verdict = await gateBeforeAuthorization(
    intent,
    { card: paymentMethod.card },
    { record: true, point: 'server_confirm' },
  );
  if (verdict.kind === 'blocked') {
    return verdict.moved
      ? { kind: 'confirmed', intent: verdict.intent }
      : { kind: 'blocked', intent: verdict.intent };
  }
  if (verdict.kind === 'stale') return { kind: 'stale', current: verdict.current };
  const db = getDb();
  const prepared = await setIntentPaymentMethod(db, intent.id, intent.status, {
    paymentMethodId: paymentMethod.id,
    setupFutureUsage: input.setupFutureUsage,
    receiptEmail: input.receiptEmail,
    ...(input.shipping !== undefined ? { shipping: input.shipping } : {}),
  });
  if (!prepared) return { kind: 'stale', current: await findIntentById(db, intent.id) };
  const customerObjectId = await ensureProviderCustomer(customer, provider);
  const result = await provider.confirm({
    intentId: intent.publicId,
    providerObjectId: intent.providerObjectId,
    paymentMethodObjectId: paymentMethod.providerObjectId,
    customerObjectId,
    ...(input.offSession === true ? { offSession: true } : {}),
    ...(input.setupFutureUsage !== undefined ? { setupFutureUsage: input.setupFutureUsage } : {}),
    ...(input.returnUrl !== undefined ? { returnUrl: input.returnUrl } : {}),
    idempotencyKey: input.idempotencyKey,
  });
  await applyProviderPaymentResult(prepared, result);
  return { kind: 'confirmed', intent: (await findIntentById(db, intent.id)) ?? prepared };
}
