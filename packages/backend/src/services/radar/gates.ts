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
import {
  findIntentById,
  lockIntentForUpdate,
  type PaymentIntentRow,
} from '../../db/payments/paymentIntentRepository';
import { findPaymentMethodById } from '../../db/customers/paymentMethodRepository';
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
  /**
   * A rule blocked; the attempt is declined (or, on a read, would be).
   * `moved`: the row was declined (`requires_payment_method` with
   * `last_payment_error`). `false` for a payment whose card is already attached
   * at the provider (`requires_confirmation`): the row is left as it is, the
   * provider's payment too, and the answer is the decline — nothing is confirmed
   * and no credential is handed out, so the provider's payment cannot complete
   * through Peable, and the row never says "declined" over a payment the
   * provider still holds confirmable.
   */
  | { readonly kind: 'blocked'; readonly intent: PaymentIntentRow; readonly moved: boolean }
  /** The payment moved while it was judged; nothing was written. */
  | { readonly kind: 'stale'; readonly current: PaymentIntentRow | null };

/**
 * Where a pre-authorization block may decline from (ADR 0022 D3).
 *
 *  - `credential` (handing out the payer's confirmation credential):
 *    `requires_payment_method`, and `requires_confirmation` judged with the
 *    saved card attached. Never `requires_action`: a 3DS challenge the payer is
 *    in is in flight at the provider, and only the post-authorization
 *    judgment can decide it.
 *  - `server_confirm` (the gateway confirming a saved card it names): those
 *    two, and `requires_action` too — a NEW confirm with a card the gateway
 *    names is a new attempt, judged with that card. From `requires_action` and
 *    `requires_confirmation` the row is never moved (see the verdict).
 */
export type PreAuthorizationPoint = 'credential' | 'server_confirm';

const GATED_FROM: Readonly<Record<PreAuthorizationPoint, readonly PaymentIntentStatus[]>> = {
  credential: ['requires_payment_method', 'requires_confirmation'],
  server_confirm: ['requires_payment_method', 'requires_confirmation', 'requires_action'],
};

/**
 * A card collected by a Terminal reader (ADR 0024 D8): merchant risk rules do
 * not evaluate it — before authorization, after it, or at capture. Stripe
 * Radar does not screen card-present payments either, and a rule written for
 * an online payer has no point on a reader the merchant operates.
 */
export function isCardPresent(intent: Pick<PaymentIntentRow, 'paymentMethodTypes'>): boolean {
  return intent.paymentMethodTypes?.includes('card_present') === true;
}

/** Whether a payment can be judged before authorization at this point. */
export function gatesBeforeAuthorization(
  intent: PaymentIntentRow,
  point: PreAuthorizationPoint,
): boolean {
  return (
    intent.rail === 'card' && !isCardPresent(intent) && GATED_FROM[point].includes(intent.status)
  );
}

/**
 * Judge an attempt before authorization.
 *
 * @param sources.card the card the attempt would use; absent, the payment's
 *   own saved card when one is attached, else no card (the payer has not
 *   entered one yet).
 * @param options.record `false` for a read (the merchant's GET): a block is
 *   answered but nothing is written — a read never records an attempt.
 * @param options.providerUnattached the provider holds no payment for this row
 *   yet (a create with `confirm` judges before it creates one): the row can be
 *   declined whatever its status, and the provider's payment is then created
 *   without the card.
 */
export async function gateBeforeAuthorization(
  intent: PaymentIntentRow,
  sources: { readonly card?: CardDetails | null },
  options: {
    readonly record: boolean;
    readonly point: PreAuthorizationPoint;
    readonly providerUnattached?: boolean;
  },
): Promise<PreAuthorizationVerdict> {
  if (!gatesBeforeAuthorization(intent, options.point)) return { kind: 'proceed' };
  let decision: RadarDecision | null;
  try {
    // The card the attempt will use: the one named, else — only where the
    // provider already holds it (`requires_confirmation`) — the saved card
    // attached. A card stored on a payment back in `requires_payment_method`
    // is one that was declined or replaced: the payer is about to enter
    // another, so the card is unknown.
    const card =
      sources.card ??
      (intent.status !== 'requires_confirmation' || intent.paymentMethodId === null
        ? null
        : ((await findPaymentMethodById(getDb(), intent.paymentMethodId))?.card ?? null));
    decision = await evaluateRules(intent, 'pre_authorization', { card });
  } catch (error) {
    console.error(`[radar] pre-authorization evaluation of ${intent.publicId} failed`, error);
    return { kind: 'proceed' };
  }
  if (decision?.action !== 'block') return { kind: 'proceed' };
  const declinesRow =
    intent.status === 'requires_payment_method' || options.providerUnattached === true;
  if (!options.record) return { kind: 'blocked', intent, moved: declinesRow };
  // The same rule (and version) already declined this payment's last attempt:
  // the answer is the same, and nothing new is recorded — a payer page that
  // asks again is not another attempt, and not another event.
  if (
    !declinesRow ||
    (intent.status === 'requires_payment_method' &&
      intent.lastPaymentError?.decline_code === RADAR_BLOCK_DECLINE_CODE)
  ) {
    const last = await findLatestRadarEvaluation(getDb(), intent.id, 'pre_authorization');
    if (last?.ruleId === decision.rule.publicId && last.ruleVersion === decision.rule.version) {
      return { kind: 'blocked', intent, moved: declinesRow };
    }
  }
  const evaluation = {
    merchantId: intent.merchantId,
    paymentIntentId: intent.id,
    phase: 'pre_authorization' as const,
    decision: 'block' as const,
    rule: decision.rule,
    facts: decision.facts,
  };
  if (!declinesRow) {
    // The card is attached at the provider: the row is left as it is, and the
    // decision is recorded (the explanation of the 402).
    await insertRadarEvaluation(getDb(), evaluation);
    return { kind: 'blocked', intent, moved: false };
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
    if (moved.kind === 'updated') await insertRadarEvaluation(tx, evaluation);
    return moved;
  });
  if (result.kind !== 'updated') {
    return { kind: 'stale', current: await findIntentById(getDb(), intent.id) };
  }
  announceIntentChange(result.row);
  return { kind: 'blocked', intent: result.row, moved: true };
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
  // Wallets are cards; anything else on the card rail is not judged — and a
  // card_present payment never is (ADR 0024 D8), whatever its snapshot holds.
  // Its charge is still CLAIMED below, so the judge sweep does not keep it.
  const isCard = charge.paymentMethodDetails?.type === 'card' && !isCardPresent(intent);
  const decision = isCard ? await evaluateRules(intent, 'post_authorization', { charge }) : null;

  const opened = await db.transaction(async (tx) => {
    // The payment as it is NOW, locked: a cancellation or a refund committing
    // while the rules were judged must not be followed by a review of a
    // payment that has ended (ADR 0022 D3).
    const locked = await lockIntentForUpdate(tx, intent.id);
    if (!(await claimChargeRadarEvaluation(tx, intent.id))) return { claimed: false as const };
    if (decision === null || !locked) return { claimed: true as const, act: 'none' as const };
    await insertRadarEvaluation(tx, {
      merchantId: intent.merchantId,
      paymentIntentId: intent.id,
      phase: 'post_authorization',
      decision: decision.action,
      rule: decision.rule,
      facts: decision.facts,
    });
    const refundedInFull =
      locked.amountReceived !== '0' &&
      BigInt(locked.amountRefunded) >= BigInt(locked.amountReceived);
    const live =
      (locked.status === 'requires_capture' || locked.status === 'succeeded') && !refundedInFull;
    if (!live || decision.action === 'allow')
      return { claimed: true as const, act: 'none' as const };
    // A review, and a block on money already captured, open the queue now.
    if (decision.action === 'review' || locked.status === 'succeeded') {
      await openReviewIn(tx, locked, decision.rule);
      return { claimed: true as const, act: 'reviewed' as const };
    }
    return { claimed: true as const, act: 'release' as const, intent: locked };
  });
  if (!opened.claimed || decision === null) return;
  if (opened.act === 'reviewed') kickWebhookOutbox();
  if (opened.act === 'release') await releaseBlockedAuthorization(opened.intent, decision);
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
  if (intent.rail !== 'card' || isCardPresent(intent)) return { kind: 'clear' };
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
