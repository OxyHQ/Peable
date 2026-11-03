import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CardDetails, CurrencyCode, PaymentIntentStatus } from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { charges } from '../schema';
import type { StoredChargeOutcome } from '../schema/charges';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { DatabaseOrTransaction } from '../postgres';
import { newId } from '../../lib/ids';
import type { PaymentIntentRow } from './paymentIntentRepository';

/**
 * Reads and writes for `charges` — the read-only `ch_…` of a card payment's
 * successful authorization (ADR 0019). One per intent, written only by
 * {@link ensureChargeForIntent} inside the transition that produced it.
 */
export interface ChargeRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly paymentIntentPublicId: string;
  /** The intent's status — whether the authorization was captured, held or released. */
  readonly intentStatus: PaymentIntentStatus;
  readonly customerPublicId: string | null;
  readonly paymentMethodPublicId: string | null;
  readonly amount: string;
  readonly amountCaptured: string;
  /** The sum of succeeded refunds — never stored. */
  readonly amountRefunded: string;
  readonly currency: CurrencyCode;
  readonly disputed: boolean;
  readonly outcome: StoredChargeOutcome | null;
  readonly paymentMethodDetails: { type: 'card'; card: CardDetails } | null;
  readonly description: string | null;
  readonly receiptEmail: string | null;
  readonly metadata: Record<string, string>;
  readonly applicationFeeAmount: string | null;
  readonly applicationFeePublicId: string | null;
  readonly balanceTransactionPublicId: string | null;
  readonly createdAt: Date;
}

/** `charges.payment_intent_id`, qualified — see `INTENT_COLUMNS` on why these are raw. */
const INTENT_OF = '"charges"."payment_intent_id"';
const viaIntent = (expression: string) =>
  sql.raw(`(select ${expression} from payment_intents p where p.id = ${INTENT_OF})`);

const CHARGE_COLUMNS = {
  livemode: merchantLivemodeOf(charges.merchantId),
  id: charges.id,
  publicId: charges.publicId,
  merchantId: charges.merchantId,
  paymentIntentId: charges.paymentIntentId,
  paymentIntentPublicId: sql<string>`${viaIntent('p.public_id')}`,
  intentStatus: sql<string>`${viaIntent('p.status')}`,
  customerPublicId: sql<string | null>`${viaIntent(
    '(select c.public_id from customers c where c.id = p.customer_id)',
  )}`,
  paymentMethodPublicId: sql<string | null>`${viaIntent(
    '(select m.public_id from payment_methods m where m.id = p.payment_method_id)',
  )}`,
  amount: charges.amount,
  amountCaptured: charges.amountCaptured,
  amountRefunded: sql<string>`${sql.raw(
    `(select coalesce(sum(r.amount::numeric), 0)::text from refunds r where r.payment_intent_id = ${INTENT_OF} and r.status = 'succeeded')`,
  )}`,
  currency: charges.currency,
  disputed: sql<boolean>`${sql.raw(
    `exists (select 1 from disputes d where d.payment_intent_id = ${INTENT_OF})`,
  )}`,
  outcome: charges.outcome,
  paymentMethodDetails: charges.paymentMethodDetails,
  description: sql<string | null>`${viaIntent('p.description')}`,
  receiptEmail: sql<string | null>`${viaIntent('p.receipt_email')}`,
  metadata: sql<Record<string, string>>`${viaIntent('p.metadata')}`,
  applicationFeeAmount: sql<string | null>`${viaIntent('p.application_fee_amount')}`,
  // The fee the provider actually took, and the ledger's own row for this
  // charge (ADR 0015) — each `null` until it exists, never guessed.
  applicationFeePublicId: sql<string | null>`${sql.raw(
    `(select f.public_id from application_fees f where f.payment_intent_id = ${INTENT_OF})`,
  )}`,
  balanceTransactionPublicId: sql<string | null>`${sql.raw(
    `(select b.public_id from balance_transactions b where b.source_type = 'charge' and b.source_id = "charges"."public_id" order by b.occurred_at limit 1)`,
  )}`,
  createdAt: charges.createdAt,
} as const;

function toChargeRow(row: Record<string, unknown>): ChargeRow {
  return row as unknown as ChargeRow;
}

/**
 * Record the authorization a card intent just obtained, or bring its captured
 * amount up to date — in the CALLER's transaction, the one that moved the
 * intent to `requires_capture` or `succeeded`, so an intent that reports a
 * charge always has one.
 *
 * ONE statement: `insert … on conflict (payment_intent_id) do update`, so a
 * capture after an authorization updates the row the authorization wrote.
 */
export async function ensureChargeForIntent(
  tx: DatabaseOrTransaction,
  intent: PaymentIntentRow,
): Promise<void> {
  const captured = intent.status === 'succeeded' ? intent.amountReceived : '0';
  await tx
    .insert(charges)
    .values({
      id: uuidv7(),
      publicId: newId('ch'),
      merchantId: intent.merchantId,
      paymentIntentId: intent.id,
      amount: intent.amount,
      amountCaptured: captured,
      currency: intent.currency,
    })
    .onConflictDoUpdate({
      target: charges.paymentIntentId,
      set: { amountCaptured: captured },
    });
}

/** The provider's snapshot of the charge: outcome and card, never the raw prose. */
export async function updateChargeSnapshot(
  db: DatabaseOrTransaction,
  paymentIntentId: string,
  snapshot: {
    readonly outcome: StoredChargeOutcome | null;
    readonly paymentMethodDetails: { type: 'card'; card: CardDetails } | null;
  },
): Promise<boolean> {
  const rows = await db
    .update(charges)
    .set({
      outcome: snapshot.outcome,
      paymentMethodDetails: snapshot.paymentMethodDetails,
      syncedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(eq(charges.paymentIntentId, paymentIntentId))
    .returning({ id: charges.id });
  return rows.length === 1;
}

export async function findChargeForIntent(
  db: DatabaseOrTransaction,
  paymentIntentId: string,
): Promise<ChargeRow | null> {
  const [row] = await db
    .select(CHARGE_COLUMNS)
    .from(charges)
    .where(eq(charges.paymentIntentId, paymentIntentId));
  return row ? toChargeRow(row) : null;
}

/** `ch_…` scoped to the owner, in ONE predicate — a foreign id and an unknown one both answer `null`. */
export async function findChargeForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<ChargeRow | null> {
  const [row] = await db
    .select(CHARGE_COLUMNS)
    .from(charges)
    .where(and(eq(charges.publicId, publicId), eq(charges.merchantId, merchantId)));
  return row ? toChargeRow(row) : null;
}

/** The `expand[]` loader: several charges by public id, merchant-scoped, one query. */
export async function findChargesForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<ChargeRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(CHARGE_COLUMNS)
    .from(charges)
    .where(and(eq(charges.merchantId, merchantId), inArray(charges.publicId, [...publicIds])));
  return rows.map(toChargeRow);
}

export async function listChargesForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    /** INTERNAL id, already resolved inside the merchant's scope. */
    readonly paymentIntentId?: string | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: ChargeRow[]; hasMore: boolean }> {
  const walk = keyset(charges.id, charges.createdAt, params.page);
  const rows = await db
    .select(CHARGE_COLUMNS)
    .from(charges)
    .where(
      and(
        eq(charges.merchantId, params.merchantId),
        params.paymentIntentId === undefined
          ? undefined
          : eq(charges.paymentIntentId, params.paymentIntentId),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toChargeRow));
}
