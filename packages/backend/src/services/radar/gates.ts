/**
 * Where the merchant's risk rules ACT on a card payment (ADR 0022 D3).
 *
 *  - {@link gateBeforeAuthorization}: before the gateway lets the provider
 *    authorize — a server confirm with a saved card, or handing out the payer's
 *    confirmation credential. A `block` declines the attempt exactly as a
 *    declined card does (ADR 0019): `requires_payment_method` with
 *    `last_payment_error`, `payment_intent.payment_failed`, still payable.
 *  - {@link judgeAuthorization}: once per charge, after the provider authorized
 *    and the charge's snapshot was read. A `block` on a held authorization
 *    releases it through `cardCancellation.ts`; everything that cannot be
 *    released (captured money, a lost cancellation) and every `review` opens a
 *    review instead. Captured money is never refunded here.
 *
 * Both are card-only and never throw into the payment path: a defect in the
 * evaluator is logged and the payment proceeds (ADR 0022 D3 "failure modes").
 */
import type {
  CardDetails,
  PaymentIntentLastPaymentError,
  PaymentIntentStatus,
} from '@peable.to/shared-types';
import { RADAR_BLOCK_DECLINE_CODE } from '@peable.to/shared-types';
import {
  claimChargeRadarEvaluation,
  findChargeForIntent,
} from '../../db/payments/chargeRepository';
import { findIntentById, type PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import { getDb } from '../../db/postgres';
import {
  findLatestRadarEvaluation,
  findReviewForIntent,
  insertRadarEvaluation,
  listEnabledRadarRules,
} from '../../db/radar/radarRepository';
import { syncChargeFromProvider } from '../charges';
import { cancelCardPaymentAtProvider } from '../cardCancellation';
import { applyEvent } from '../intentState';
import { reconcileIntentWithProvider } from '../intentReconciliation';
import { announceIntentChange, transitionIntent, transitionIntentIn } from '../intentTransition';
import { kickWebhookOutbox } from '../webhookOutbox';
import { evaluateRules, type RadarDecision } from './evaluate';
import { openReviewIn } from './reviewEvents';

/** The decline a pre-authorization `block` writes — Peable's words, nothing about the rule. */
export const RADAR_BLOCK_ERROR: PaymentIntentLastPaymentError = {
  type: 'card_error',
  code: 'card_declined',
  decline_code: RADAR_BLOCK_DECLINE_CODE,
  message: 'The payment was declined.',
};

export type PreAuthorizationVerdict =
  /** Nothing blocked: ask the provider. */
  | { readonly kind: 'proceed' }
  /** A rule blocked; the attempt is declined (or, on a read, would be). */
  | { readonly kind: 'blocked'; readonly intent: PaymentIntentRow }
  /** The payment moved while it was judged; nothing was written. */
  | { readonly kind: 'stale'; readonly current: PaymentIntentRow | null };

/**
 * Where a pre-authorization block may decline from. `credential`: handing out
 * the payer's confirmation credential — only a payment with nothing attached
 * at the provider (`requires_payment_method`). `server_confirm`: the gateway is
 * itself about to confirm a saved card, and nothing is in flight at the
 * provider (`requires_payment_method`, `requires_confirmation`). Never from
 * `requires_action`: a 3DS challenge is in flight at the provider, and only
 * the post-authorization judgment can decide it (ADR 0022 D3).
 */
export type PreAuthorizationPoint = 'credential' | 'server_confirm';

const GATED_FROM: Readonly<Record<PreAuthorizationPoint, readonly PaymentIntentStatus[]>> = {
  credential: ['requires_payment_method'],
  server_confirm: ['requires_payment_method', 'requires_confirmation'],
};

/** Whether a payment can be judged before authorization at this point. */
export function gatesBeforeAuthorization(
  intent: PaymentIntentRow,
  point: PreAuthorizationPoint,
): boolean {
  return intent.rail === 'card' && GATED_FROM[point].includes(intent.status);
}

/**
 * Judge an attempt before authorization.
 *
 * @param options.record `false` for a read (the merchant's GET): a block is
 *   answered but nothing is written — a read never records an attempt.
 */
export async function gateBeforeAuthorization(
  intent: PaymentIntentRow,
  sources: { readonly card?: CardDetails | null },
  options: { readonly record: boolean; readonly point: PreAuthorizationPoint },
): Promise<PreAuthorizationVerdict> {
  if (!gatesBeforeAuthorization(intent, options.point)) return { kind: 'proceed' };
  let decision: RadarDecision | null;
  try {
    decision = await evaluateRules(intent, 'pre_authorization', sources);
  } catch (error) {
    console.error(`[radar] pre-authorization evaluation of ${intent.publicId} failed`, error);
    return { kind: 'proceed' };
  }
  if (decision?.action !== 'block') return { kind: 'proceed' };
  if (!options.record) return { kind: 'blocked', intent };
  // The same rule (and version) already declined this payment's last attempt:
  // the answer is the same, and nothing new is recorded — a payer page that
  // asks again is not another attempt, and not another event.
  if (
    intent.status === 'requires_payment_method' &&
    intent.lastPaymentError?.decline_code === RADAR_BLOCK_DECLINE_CODE
  ) {
    const last = await findLatestRadarEvaluation(getDb(), intent.id, 'pre_authorization');
    if (last?.ruleId === decision.rule.publicId && last.ruleVersion === decision.rule.version) {
      return { kind: 'blocked', intent };
    }
  }

  let target: PaymentIntentRow['status'];
  try {
    target = applyEvent(intent.status, 'card_failed', intent.rail);
  } catch {
    // Not a status an attempt can be declined from: the caller's own state
    // check answers it; nothing was asked of the provider.
    return { kind: 'stale', current: intent };
  }
  const result = await getDb().transaction(async (tx) => {
    const moved = await transitionIntentIn(tx, intent.id, {
      from: intent.status,
      status: target,
      lastPaymentError: RADAR_BLOCK_ERROR,
    });
    if (moved.kind === 'updated') {
      await insertRadarEvaluation(tx, {
        merchantId: intent.merchantId,
        paymentIntentId: intent.id,
        phase: 'pre_authorization',
        decision: 'block',
        rule: decision.rule,
        facts: decision.facts,
      });
    }
    return moved;
  });
  if (result.kind !== 'updated') {
    return { kind: 'stale', current: await findIntentById(getDb(), intent.id) };
  }
  announceIntentChange(result.row);
  return { kind: 'blocked', intent: result.row };
}

/**
 * The post-authorization judgment, once per charge. Called after the charge's
 * provider snapshot was written; a caller that does not know whether it is
 * the first simply calls it — the claim decides.
 *
 * Never throws.
 */
export async function judgeAuthorization(intentId: string): Promise<void> {
  try {
    await judge(intentId);
  } catch (error) {
    console.error(`[radar] post-authorization judgment of ${intentId} failed`, error);
  }
}

async function judge(intentId: string): Promise<void> {
  const db = getDb();
  const intent = await findIntentById(db, intentId);
  if (intent?.rail !== 'card') return;
  if (intent.status !== 'requires_capture' && intent.status !== 'succeeded') return;
  const charge = await findChargeForIntent(db, intent.id);
  if (!charge || charge.radarEvaluatedAt !== null) return;
  // Wallets are cards; anything else on the card rail is not judged.
  const isCard = charge.paymentMethodDetails?.type === 'card';
  const decision = isCard ? await evaluateRules(intent, 'post_authorization', { charge }) : null;

  const opened = await db.transaction(async (tx) => {
    if (!(await claimChargeRadarEvaluation(tx, intent.id))) return { claimed: false as const };
    if (decision === null) return { claimed: true as const, review: false };
    await insertRadarEvaluation(tx, {
      merchantId: intent.merchantId,
      paymentIntentId: intent.id,
      phase: 'post_authorization',
      decision: decision.action,
      rule: decision.rule,
      facts: decision.facts,
    });
    // A review, and a block on money already captured, open the queue now.
    const reviewNow =
      decision.action === 'review' ||
      (decision.action === 'block' && intent.status === 'succeeded');
    if (reviewNow) await openReviewIn(tx, intent, decision.rule);
    return { claimed: true as const, review: reviewNow };
  });
  if (!opened.claimed || decision === null) return;
  if (opened.review) {
    kickWebhookOutbox();
    return;
  }
  if (decision.action === 'block' && intent.status === 'requires_capture') {
    await releaseBlockedAuthorization(intent, decision);
  }
}

/**
 * A post-authorization `block` on a held authorization: release it at the
 * provider, and only then say so. A cancellation that did not happen opens a
 * review, which holds capture — nothing announces a release the provider did
 * not make.
 */
async function releaseBlockedAuthorization(
  intent: PaymentIntentRow,
  decision: RadarDecision,
): Promise<void> {
  const cancellation = await cancelCardPaymentAtProvider(
    intent,
    `radar:${intent.publicId}:cancel`,
    'fraudulent',
  );
  if (cancellation.kind === 'canceled') {
    const moved = await transitionIntent(intent.id, {
      from: intent.status,
      status: 'canceled',
      cancellationReason: 'fraudulent',
    });
    if (moved.kind === 'updated') {
      announceIntentChange(moved.row);
      return;
    }
    // Moved under us: the provider's word decides.
    await reconcileIntentWithProvider(intent);
    return;
  }
  if (cancellation.kind === 'settled') await reconcileIntentWithProvider(intent);
  const current = (await findIntentById(getDb(), intent.id)) ?? intent;
  if (current.status === 'canceled') return;
  await getDb().transaction((tx) => openReviewIn(tx, current, decision.rule));
  kickWebhookOutbox();
}

/** Whether the merchant has any rule a charge must wait for before capture. */
export async function hasEnabledRules(merchantId: string): Promise<boolean> {
  return (await listEnabledRadarRules(getDb(), merchantId)).length > 0;
}

export type CaptureHold =
  /** Nothing holds it: capture. */
  | { readonly kind: 'clear' }
  /** An open review holds it until approved. */
  | { readonly kind: 'review'; readonly reviewId: string }
  /** A post-authorization block is releasing it. */
  | { readonly kind: 'blocked' }
  /** It moved while it was judged (a block released it). */
  | { readonly kind: 'moved'; readonly current: PaymentIntentRow }
  /** The rules could not judge it yet: its snapshot could not be read. */
  | { readonly kind: 'unjudged' };

/**
 * What stands between a held authorization and its capture (ADR 0022 D3): a
 * merchant cannot capture ahead of their own rules, nor while a review is open.
 */
export async function holdBeforeCapture(intent: PaymentIntentRow): Promise<CaptureHold> {
  if (intent.rail !== 'card') return { kind: 'clear' };
  const db = getDb();
  let charge = await findChargeForIntent(db, intent.id);
  if (charge && charge.radarEvaluatedAt === null && (await hasEnabledRules(intent.merchantId))) {
    // Reads the snapshot, which claims and runs the judgment.
    await syncChargeFromProvider(intent);
    charge = await findChargeForIntent(db, intent.id);
    // The provider could not be read: capture needs it anyway — try again.
    if (!charge || charge.syncedAt === null) return { kind: 'unjudged' };
    // The snapshot is there and the judgment still did not land (it threw):
    // one more try, then the payment proceeds — an evaluator defect must not
    // hold a merchant's money for ever (ADR 0022 D3, failure modes).
    if (charge.radarEvaluatedAt === null) {
      await judgeAuthorization(intent.id);
      charge = (await findChargeForIntent(db, intent.id)) ?? charge;
      if (charge.radarEvaluatedAt === null) {
        console.error(`[radar] ${intent.publicId} captured unjudged: the judgment kept failing`);
      }
    }
  }
  const current = (await findIntentById(db, intent.id)) ?? intent;
  if (current.status !== intent.status) return { kind: 'moved', current };
  const review = await findReviewForIntent(db, intent.id);
  if (review && review.closedReason === null) return { kind: 'review', reviewId: review.publicId };
  if (charge?.radarRule?.action === 'block' && review === null) return { kind: 'blocked' };
  return { kind: 'clear' };
}
