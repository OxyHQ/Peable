import { and, desc, eq } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import type { OxyServiceEnvironment } from '@oxy.so/core/server';
import type { CurrencyCode, PaymentIntentRail } from '@peable.to/shared-types';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { checkoutSessions } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * Reads and writes for `checkout_sessions` — a hosted-checkout session wrapping
 * exactly one payment intent.
 *
 * NOT WIRED TO ANY ROUTE YET; see `db/merchants/merchantRepository.ts`'s header.
 *
 * There is no update function, and that is the model rather than an omission: a
 * session is immutable after creation, and a merchant needing a different amount
 * creates a new one. The `client_secret` is deliberately not duplicated here
 * either — it is read off the wrapped intent, so there stays exactly one place a
 * client secret is ever persisted.
 */

export interface CheckoutSessionRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  readonly paymentIntentId: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly rail: PaymentIntentRail;
  /** FairCoin rail only — `null` on a card session (ADR 0001 D6). */
  readonly network: NetworkType | null;
  readonly metadata: Record<string, string>;
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SESSION_COLUMNS = {
  id: checkoutSessions.id,
  publicId: checkoutSessions.publicId,
  merchantId: checkoutSessions.merchantId,
  oxyAppId: checkoutSessions.oxyAppId,
  environment: checkoutSessions.environment,
  paymentIntentId: checkoutSessions.paymentIntentId,
  amount: checkoutSessions.amount,
  currency: checkoutSessions.currency,
  rail: checkoutSessions.rail,
  network: checkoutSessions.network,
  metadata: checkoutSessions.metadata,
  successUrl: checkoutSessions.successUrl,
  cancelUrl: checkoutSessions.cancelUrl,
  createdAt: checkoutSessions.createdAt,
  updatedAt: checkoutSessions.updatedAt,
} as const;

function toSessionRow(row: {
  environment: string;
  currency: string;
  rail: string;
  network: string | null;
  [key: string]: unknown;
}): CheckoutSessionRow {
  return {
    ...row,
    environment: row.environment as OxyServiceEnvironment,
    currency: row.currency as CurrencyCode,
    rail: row.rail as PaymentIntentRail,
    network: row.network as NetworkType | null,
  } as unknown as CheckoutSessionRow;
}

export interface InsertCheckoutSessionParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  /** The INTERNAL id of the wrapped intent, not its `pi_…`. */
  readonly paymentIntentId: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly rail: PaymentIntentRail;
  /** FairCoin rail only; `null` on a card session. */
  readonly network: NetworkType | null;
  readonly metadata: Record<string, string>;
  readonly successUrl?: string | undefined;
  readonly cancelUrl?: string | undefined;
}

/**
 * Create a session around an intent.
 *
 * @returns the new row, or `null` when that intent is ALREADY wrapped by another
 *   session. "Wraps exactly one payment intent" is a unique index rather than a
 *   sentence, so two sessions sharing an intent is refused by the database. Every
 *   session mints a fresh intent today, so this refuses nothing that happens —
 *   what it refuses is a future change that would let two buyers' sessions point
 *   at one payment.
 */
export async function insertCheckoutSession(
  db: DatabaseOrTransaction,
  params: InsertCheckoutSessionParams
): Promise<CheckoutSessionRow | null> {
  try {
    const [row] = await db
      .insert(checkoutSessions)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        oxyAppId: params.oxyAppId,
        environment: params.environment,
        paymentIntentId: params.paymentIntentId,
        amount: params.amount,
        currency: params.currency,
        rail: params.rail,
        network: params.network,
        metadata: params.metadata,
        successUrl: params.successUrl ?? null,
        cancelUrl: params.cancelUrl ?? null,
      })
      .returning(SESSION_COLUMNS);
    return row ? toSessionRow(row) : null;
  } catch (error) {
    if (isUniqueViolation(error, 'checkout_sessions_payment_intent_id_key')) {
      return null;
    }
    throw error;
  }
}

/**
 * The PUBLIC checkout-page read: `cs_…` alone.
 *
 * The page at `/c/:id` is loaded by an anonymous payer and authorized by the
 * wrapped intent's `client_secret`, not by ownership — so this read has no owner
 * to scope by, and is separate from {@link findSessionForMerchant} for the
 * reason given on the payment-intent reads.
 */
export async function findSessionByPublicId(
  db: DatabaseOrTransaction,
  publicId: string
): Promise<CheckoutSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(eq(checkoutSessions.publicId, publicId));
  return row ? toSessionRow(row) : null;
}

/** The MERCHANT read: ownership in the WHERE clause, so a foreign session 404s like a missing one. */
export async function findSessionForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string
): Promise<CheckoutSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(
      and(eq(checkoutSessions.publicId, publicId), eq(checkoutSessions.merchantId, merchantId))
    );
  return row ? toSessionRow(row) : null;
}

/** Sessions a merchant owns, newest first. Same ordering contract as the intent list. */
export async function listSessionsForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
  limit: number
): Promise<CheckoutSessionRow[]> {
  const rows = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(eq(checkoutSessions.merchantId, merchantId))
    .orderBy(desc(checkoutSessions.id))
    .limit(limit);
  return rows.map(toSessionRow);
}
