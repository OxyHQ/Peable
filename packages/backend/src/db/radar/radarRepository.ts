/**
 * Reads and writes for risk rules, their evaluations and reviews (ADR 0022).
 * The predicate is stored and returned as text; nothing here ever puts it in a
 * statement other than as a bound value.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  RADAR_LIMITS,
  type RadarEvaluationPhase,
  type RadarRuleAction,
  type ReviewClosedReason,
} from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { merchants, radarEvaluations, radarRules, reviews } from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { DatabaseOrTransaction } from '../postgres';
import { newId } from '../../lib/ids';

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RadarRuleRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly action: RadarRuleAction;
  readonly predicate: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const RULE_COLUMNS = {
  id: radarRules.id,
  publicId: radarRules.publicId,
  merchantId: radarRules.merchantId,
  livemode: merchantLivemodeOf(radarRules.merchantId),
  action: radarRules.action,
  predicate: radarRules.predicate,
  description: radarRules.description,
  enabled: radarRules.enabled,
  version: radarRules.version,
  createdAt: radarRules.createdAt,
  updatedAt: radarRules.updatedAt,
} as const;

const toRuleRow = (row: Record<string, unknown>) => row as unknown as RadarRuleRow;

/**
 * Insert a rule, refusing the merchant's 51st. The count is taken under the
 * merchant's row lock, so two concurrent creates cannot both be the 50th.
 */
export async function insertRadarRule(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly action: RadarRuleAction;
    readonly predicate: string;
    readonly description: string | null;
    readonly enabled: boolean;
  },
): Promise<RadarRuleRow | 'limit_reached'> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.id, params.merchantId))
      .for('update');
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(radarRules)
      .where(eq(radarRules.merchantId, params.merchantId));
    if ((count?.n ?? 0) >= RADAR_LIMITS.rulesPerMerchantMax) return 'limit_reached';
    const [row] = await tx
      .insert(radarRules)
      .values({
        id: uuidv7(),
        publicId: newId('rule'),
        merchantId: params.merchantId,
        action: params.action,
        predicate: params.predicate,
        description: params.description,
        enabled: params.enabled,
      })
      .returning(RULE_COLUMNS);
    if (!row) throw new Error('radar rule insert returned no row');
    return toRuleRow(row);
  });
}

export async function findRadarRuleForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<RadarRuleRow | null> {
  const [row] = await db
    .select(RULE_COLUMNS)
    .from(radarRules)
    .where(and(eq(radarRules.publicId, publicId), eq(radarRules.merchantId, merchantId)));
  return row ? toRuleRow(row) : null;
}

/** The merchant's enabled rules, oldest first — the order a tie is reported in. */
export async function listEnabledRadarRules(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<RadarRuleRow[]> {
  const rows = await db
    .select(RULE_COLUMNS)
    .from(radarRules)
    .where(and(eq(radarRules.merchantId, merchantId), eq(radarRules.enabled, true)))
    .orderBy(asc(radarRules.id))
    .limit(RADAR_LIMITS.rulesPerMerchantMax);
  return rows.map(toRuleRow);
}

export async function listRadarRules(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly page: KeysetPage;
    readonly action?: RadarRuleAction | undefined;
    readonly enabled?: boolean | undefined;
  },
): Promise<{ data: RadarRuleRow[]; hasMore: boolean }> {
  const walk = keyset(radarRules.id, radarRules.createdAt, params.page);
  const rows = await db
    .select(RULE_COLUMNS)
    .from(radarRules)
    .where(
      and(
        eq(radarRules.merchantId, params.merchantId),
        params.action === undefined ? undefined : eq(radarRules.action, params.action),
        params.enabled === undefined ? undefined : eq(radarRules.enabled, params.enabled),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRuleRow));
}

/**
 * Change a rule. A new action or predicate moves `version` in the same
 * statement — only when it actually differs, so re-sending the same text is
 * not a new version.
 */
export async function updateRadarRule(
  db: DatabaseOrTransaction,
  id: string,
  patch: {
    readonly action?: RadarRuleAction | undefined;
    readonly predicate?: string | undefined;
    readonly description?: string | null | undefined;
    readonly enabled?: boolean | undefined;
  },
): Promise<RadarRuleRow | null> {
  const changesDecision: SQL[] = [];
  if (patch.action !== undefined)
    changesDecision.push(sql`${radarRules.action} <> ${patch.action}`);
  if (patch.predicate !== undefined) {
    changesDecision.push(sql`${radarRules.predicate} <> ${patch.predicate}`);
  }
  const [row] = await db
    .update(radarRules)
    .set({
      ...(patch.action !== undefined ? { action: patch.action } : {}),
      ...(patch.predicate !== undefined ? { predicate: patch.predicate } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(changesDecision.length > 0
        ? {
            version: sql`${radarRules.version} + case when ${sql.join(changesDecision, sql` or `)} then 1 else 0 end`,
          }
        : {}),
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(eq(radarRules.id, id))
    .returning(RULE_COLUMNS);
  return row ? toRuleRow(row) : null;
}

export async function deleteRadarRule(db: DatabaseOrTransaction, id: string): Promise<boolean> {
  const rows = await db
    .delete(radarRules)
    .where(eq(radarRules.id, id))
    .returning({ id: radarRules.id });
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

export interface RadarEvaluationRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly paymentIntentId: string;
  readonly paymentIntentPublicId: string;
  readonly phase: RadarEvaluationPhase;
  readonly decision: RadarRuleAction;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly rulePredicate: string;
  readonly facts: Record<string, string | null>;
  readonly createdAt: Date;
}

const EVALUATION_COLUMNS = {
  id: radarEvaluations.id,
  publicId: radarEvaluations.publicId,
  merchantId: radarEvaluations.merchantId,
  livemode: merchantLivemodeOf(radarEvaluations.merchantId),
  paymentIntentId: radarEvaluations.paymentIntentId,
  paymentIntentPublicId: sql<string>`${sql.raw(
    '(select p.public_id from payment_intents p where p.id = "radar_evaluations"."payment_intent_id")',
  )}`,
  phase: radarEvaluations.phase,
  decision: radarEvaluations.decision,
  ruleId: radarEvaluations.ruleId,
  ruleVersion: radarEvaluations.ruleVersion,
  rulePredicate: radarEvaluations.rulePredicate,
  facts: radarEvaluations.facts,
  createdAt: radarEvaluations.createdAt,
} as const;

const toEvaluationRow = (row: Record<string, unknown>) => row as unknown as RadarEvaluationRow;

export async function insertRadarEvaluation(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly paymentIntentId: string;
    readonly phase: RadarEvaluationPhase;
    readonly decision: RadarRuleAction;
    readonly rule: {
      readonly publicId: string;
      readonly version: number;
      readonly predicate: string;
    };
    readonly facts: Record<string, string | null>;
  },
): Promise<RadarEvaluationRow> {
  const [row] = await db
    .insert(radarEvaluations)
    .values({
      id: uuidv7(),
      publicId: newId('reval'),
      merchantId: params.merchantId,
      paymentIntentId: params.paymentIntentId,
      phase: params.phase,
      decision: params.decision,
      ruleId: params.rule.publicId,
      ruleVersion: params.rule.version,
      rulePredicate: params.rule.predicate,
      facts: params.facts,
    })
    .returning(EVALUATION_COLUMNS);
  if (!row) throw new Error('radar evaluation insert returned no row');
  return toEvaluationRow(row);
}

export async function findRadarEvaluationForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<RadarEvaluationRow | null> {
  const [row] = await db
    .select(EVALUATION_COLUMNS)
    .from(radarEvaluations)
    .where(
      and(eq(radarEvaluations.publicId, publicId), eq(radarEvaluations.merchantId, merchantId)),
    );
  return row ? toEvaluationRow(row) : null;
}

/** The payment's newest evaluation of one phase. */
export async function findLatestRadarEvaluation(
  db: DatabaseOrTransaction,
  paymentIntentId: string,
  phase: RadarEvaluationPhase,
): Promise<RadarEvaluationRow | null> {
  const [row] = await db
    .select(EVALUATION_COLUMNS)
    .from(radarEvaluations)
    .where(
      and(eq(radarEvaluations.paymentIntentId, paymentIntentId), eq(radarEvaluations.phase, phase)),
    )
    .orderBy(desc(radarEvaluations.id))
    .limit(1);
  return row ? toEvaluationRow(row) : null;
}

export async function listRadarEvaluations(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly page: KeysetPage;
    /** INTERNAL id, already resolved inside the merchant's scope. */
    readonly paymentIntentId?: string | undefined;
  },
): Promise<{ data: RadarEvaluationRow[]; hasMore: boolean }> {
  const walk = keyset(radarEvaluations.id, radarEvaluations.createdAt, params.page);
  const rows = await db
    .select(EVALUATION_COLUMNS)
    .from(radarEvaluations)
    .where(
      and(
        eq(radarEvaluations.merchantId, params.merchantId),
        params.paymentIntentId === undefined
          ? undefined
          : eq(radarEvaluations.paymentIntentId, params.paymentIntentId),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toEvaluationRow));
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

/** Each side of a velocity read stops counting here (ADR 0022 D2). */
export const VELOCITY_ROW_CAP = 10_000;
/** The customers one email can name in a velocity read. */
export const VELOCITY_CUSTOMERS_PER_EMAIL_CAP = 100;

export interface VelocityWindow {
  readonly hourly: { count: bigint; amount: bigint };
  readonly daily: { count: bigint; amount: bigint };
  readonly weekly: { count: bigint; amount: bigint };
}

interface VelocityRaw {
  readonly c1: string;
  readonly a1: string;
  readonly c24: string;
  readonly a24: string;
  readonly c7: string;
  readonly a7: string;
}

function toWindow(row: VelocityRaw | undefined): VelocityWindow {
  const n = (value: string | undefined) => BigInt(value ?? '0');
  return {
    hourly: { count: n(row?.c1), amount: n(row?.a1) },
    daily: { count: n(row?.c24), amount: n(row?.a24) },
    weekly: { count: n(row?.c7), amount: n(row?.a7) },
  };
}

/**
 * The merchant's OTHER card-rail payments in the last hour / day / week, by
 * customer, or by every customer of the merchant with the email
 * (case-insensitive): a count, and the amount in `currency` alone.
 *
 * Bounded: the window is a range of `payment_intents_customer_id_created_at_idx`
 * (customer, then the last seven days), each side reads at most
 * {@link VELOCITY_ROW_CAP} rows, and an email names at most
 * {@link VELOCITY_CUSTOMERS_PER_EMAIL_CAP} customers (through
 * `customers_merchant_id_lower_email_idx`); nothing reads `receipt_email`.
 */
export async function readVelocity(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly excludeIntentId: string;
    readonly currency: string;
    readonly customerId: string | null;
    readonly email: string | null;
  },
): Promise<{ customer: VelocityWindow | null; email: VelocityWindow | null }> {
  const windowOf = async (customers: SQL): Promise<VelocityWindow> => {
    const rows = await db.execute<VelocityRaw & Record<string, unknown>>(sql`
      with recent as (
        select p.amount, p.currency, p.created_at
        from payment_intents p
        where p.customer_id in (${customers})
          and p.merchant_id = ${params.merchantId}
          and p.rail = 'card'
          and p.id <> ${params.excludeIntentId}
          and p.created_at > now() - interval '7 days'
        order by p.created_at desc
        limit ${VELOCITY_ROW_CAP}
      )
      select
        count(*) filter (where created_at > now() - interval '1 hour')::text as c1,
        coalesce(sum(amount::numeric) filter (where created_at > now() - interval '1 hour' and currency = ${params.currency}), 0)::text as a1,
        count(*) filter (where created_at > now() - interval '24 hours')::text as c24,
        coalesce(sum(amount::numeric) filter (where created_at > now() - interval '24 hours' and currency = ${params.currency}), 0)::text as a24,
        count(*)::text as c7,
        coalesce(sum(amount::numeric) filter (where currency = ${params.currency}), 0)::text as a7
      from recent
    `);
    return toWindow(rows[0]);
  };
  return {
    customer: params.customerId === null ? null : await windowOf(sql`select ${params.customerId}`),
    email:
      params.email === null
        ? null
        : await windowOf(
            sql`select c.id from customers c where c.merchant_id = ${params.merchantId} and lower(c.email) = lower(${params.email}) limit ${VELOCITY_CUSTOMERS_PER_EMAIL_CAP}`,
          ),
  };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export interface ReviewRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly paymentIntentId: string;
  readonly paymentIntentPublicId: string;
  readonly chargePublicId: string | null;
  readonly openedReason: 'rule';
  readonly closedReason: ReviewClosedReason | null;
  readonly pendingClosedReason: ReviewClosedReason | null;
  readonly ruleId: string | null;
  readonly ruleVersion: number | null;
  readonly ruleAction: RadarRuleAction | null;
  readonly rulePredicate: string | null;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

const REVIEW_COLUMNS = {
  id: reviews.id,
  publicId: reviews.publicId,
  merchantId: reviews.merchantId,
  livemode: merchantLivemodeOf(reviews.merchantId),
  paymentIntentId: reviews.paymentIntentId,
  paymentIntentPublicId: sql<string>`${sql.raw(
    '(select p.public_id from payment_intents p where p.id = "reviews"."payment_intent_id")',
  )}`,
  chargePublicId: sql<string | null>`${sql.raw(
    '(select ch.public_id from charges ch where ch.payment_intent_id = "reviews"."payment_intent_id")',
  )}`,
  openedReason: reviews.openedReason,
  closedReason: reviews.closedReason,
  pendingClosedReason: reviews.pendingClosedReason,
  ruleId: reviews.ruleId,
  ruleVersion: reviews.ruleVersion,
  ruleAction: reviews.ruleAction,
  rulePredicate: reviews.rulePredicate,
  createdAt: reviews.createdAt,
  closedAt: reviews.closedAt,
} as const;

const toReviewRow = (row: Record<string, unknown>) => row as unknown as ReviewRow;

/**
 * Open the payment's review, in the caller's transaction. `null` when the
 * payment already has one (`reviews_payment_intent_id_key`): one per payment.
 */
export async function insertReview(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly paymentIntentId: string;
    readonly rule: {
      readonly publicId: string;
      readonly version: number;
      readonly action: RadarRuleAction;
      readonly predicate: string;
    } | null;
  },
): Promise<ReviewRow | null> {
  const [row] = await db
    .insert(reviews)
    .values({
      id: uuidv7(),
      publicId: newId('prv'),
      merchantId: params.merchantId,
      paymentIntentId: params.paymentIntentId,
      openedReason: 'rule',
      ruleId: params.rule?.publicId ?? null,
      ruleVersion: params.rule?.version ?? null,
      ruleAction: params.rule?.action ?? null,
      rulePredicate: params.rule?.predicate ?? null,
    })
    .onConflictDoNothing({ target: reviews.paymentIntentId })
    .returning(REVIEW_COLUMNS);
  return row ? toReviewRow(row) : null;
}

export async function findReviewForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<ReviewRow | null> {
  const [row] = await db
    .select(REVIEW_COLUMNS)
    .from(reviews)
    .where(and(eq(reviews.publicId, publicId), eq(reviews.merchantId, merchantId)));
  return row ? toReviewRow(row) : null;
}

export async function findReviewForIntent(
  db: DatabaseOrTransaction,
  paymentIntentId: string,
): Promise<ReviewRow | null> {
  const [row] = await db
    .select(REVIEW_COLUMNS)
    .from(reviews)
    .where(eq(reviews.paymentIntentId, paymentIntentId));
  return row ? toReviewRow(row) : null;
}

export async function findReviewsForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<ReviewRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(REVIEW_COLUMNS)
    .from(reviews)
    .where(and(eq(reviews.merchantId, merchantId), inArray(reviews.publicId, [...publicIds])));
  return rows.map(toReviewRow);
}

export async function listReviews(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly page: KeysetPage;
    readonly open?: boolean | undefined;
  },
): Promise<{ data: ReviewRow[]; hasMore: boolean }> {
  const walk = keyset(reviews.id, reviews.createdAt, params.page);
  const rows = await db
    .select(REVIEW_COLUMNS)
    .from(reviews)
    .where(
      and(
        eq(reviews.merchantId, params.merchantId),
        params.open === undefined
          ? undefined
          : params.open
            ? isNull(reviews.closedReason)
            : isNotNull(reviews.closedReason),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toReviewRow));
}

/** How long a refusal's claim holds before another close may take over. */
export const REVIEW_CLAIM_LEASE_SECONDS = 600;

/** No live claim: none, or one whose lease ran out (a NULL lease is held). */
const NO_LIVE_CLAIM = sql`(${reviews.pendingClosedReason} is null or ${reviews.pendingClosedUntil} < now())`;

/**
 * A refusal's claim: CAS on an open review with no live claim — or with this
 * same one, so a retried refusal resumes its own claim. A lease of
 * {@link REVIEW_CLAIM_LEASE_SECONDS}: a refusal that died between its claim
 * and the provider stops holding the review when it runs out.
 */
export async function claimReviewClose(
  db: DatabaseOrTransaction,
  id: string,
  reason: ReviewClosedReason,
): Promise<boolean> {
  const rows = await db
    .update(reviews)
    .set({
      pendingClosedReason: reason,
      pendingClosedUntil: sql`now() + make_interval(secs => ${REVIEW_CLAIM_LEASE_SECONDS})`,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(
      and(
        eq(reviews.id, id),
        isNull(reviews.closedReason),
        sql`(${NO_LIVE_CLAIM} or ${reviews.pendingClosedReason} = ${reason})`,
      ),
    )
    .returning({ id: reviews.id });
  return rows.length === 1;
}

/**
 * Hold a refusal's claim until its refund settles: the refund exists and is
 * pending, so the review is neither approvable nor closed yet.
 */
export async function holdReviewClose(
  db: DatabaseOrTransaction,
  id: string,
  reason: ReviewClosedReason,
): Promise<void> {
  await db
    .update(reviews)
    .set({ pendingClosedUntil: null, updatedAt: sql`date_trunc('milliseconds', now())` })
    .where(
      and(
        eq(reviews.id, id),
        isNull(reviews.closedReason),
        eq(reviews.pendingClosedReason, reason),
      ),
    );
}

/**
 * Let go of a refusal's claim: the provider refused to act, or the refund it
 * started failed. `where` names the review, or the payment whose review it is.
 */
export async function releaseReviewClose(
  db: DatabaseOrTransaction,
  where: { readonly id: string } | { readonly paymentIntentId: string },
  reasons: readonly ReviewClosedReason[],
): Promise<void> {
  await db
    .update(reviews)
    .set({
      pendingClosedReason: null,
      pendingClosedUntil: null,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(
      and(
        'id' in where
          ? eq(reviews.id, where.id)
          : eq(reviews.paymentIntentId, where.paymentIntentId),
        isNull(reviews.closedReason),
        inArray(reviews.pendingClosedReason, [...reasons]),
      ),
    );
}

/**
 * Close a review — a CAS on it being open. `requireNoPendingClaim` is an
 * approval's: it never closes over a refusal in progress. Anything closing it
 * because the money already moved (a cancellation, a refund, a dispute)
 * closes it whatever is pending.
 */
export async function closeReview(
  db: DatabaseOrTransaction,
  where: { readonly id: string } | { readonly paymentIntentId: string },
  reason: ReviewClosedReason,
  options: { readonly requireNoPendingClaim?: boolean } = {},
): Promise<ReviewRow | null> {
  const [row] = await db
    .update(reviews)
    .set({
      closedReason: reason,
      pendingClosedReason: null,
      pendingClosedUntil: null,
      closedAt: sql`date_trunc('milliseconds', now())`,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(
      and(
        'id' in where
          ? eq(reviews.id, where.id)
          : eq(reviews.paymentIntentId, where.paymentIntentId),
        isNull(reviews.closedReason),
        options.requireNoPendingClaim === true ? NO_LIVE_CLAIM : undefined,
      ),
    )
    .returning(REVIEW_COLUMNS);
  return row ? toReviewRow(row) : null;
}
