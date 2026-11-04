/**
 * When the engine must next look at a subscription — pure (ADR 0018 §5).
 *
 * The scheduler does not keep a job table: every subscription carries the
 * one instant its next obligation falls due (`next_action_at`), recomputed by
 * every write from the row itself, and the scheduler claims rows whose
 * instant has come on THEIR clock.
 */
import type { SubscriptionRow } from '../../db/billingEngine/subscriptionRepository';
import { subscriptionIsTerminal } from './stateMachines';

const DAY_MS = 86_400_000;
/** `customer.subscription.trial_will_end`: three days before (Stripe's). */
export const TRIAL_WILL_END_LEAD_MS = 3 * DAY_MS;
/** `invoice.upcoming`: three days before a renewal. */
export const UPCOMING_LEAD_MS = 3 * DAY_MS;
/** A first invoice nobody paid expires the subscription after 23 hours (Stripe's). */
export const INCOMPLETE_EXPIRY_MS = 23 * 3600_000;

type Schedulable = Pick<
  SubscriptionRow,
  | 'status'
  | 'collectionMethod'
  | 'currentPeriodStart'
  | 'currentPeriodEnd'
  | 'trialEnd'
  | 'trialWillEndSentAt'
  | 'upcomingNoticeSentAt'
  | 'cancelAt'
  | 'cancelAtPeriodEnd'
  | 'pauseResumesAt'
  | 'createdAt'
  | 'providerHandoffPending'
>;

export function nextActionAt(
  row: Schedulable,
  options: { readonly incompleteExpiresAt?: Date | null } = {},
): Date | null {
  if (subscriptionIsTerminal(row.status)) return null;
  // An adopted subscription the previous provider still renews is inert: the
  // release recomputes this from the row, so nothing is lost while it waits.
  if (row.providerHandoffPending) return null;
  const candidates: Date[] = [];
  if (row.cancelAt) candidates.push(row.cancelAt);
  if (row.pauseResumesAt) candidates.push(row.pauseResumesAt);
  if (row.status === 'incomplete') {
    const expiry =
      options.incompleteExpiresAt ?? new Date(row.createdAt.getTime() + INCOMPLETE_EXPIRY_MS);
    candidates.push(expiry);
  } else if (row.status === 'trialing' && row.trialEnd) {
    const reminder = new Date(row.trialEnd.getTime() - TRIAL_WILL_END_LEAD_MS);
    if (row.trialWillEndSentAt === null && reminder.getTime() > row.currentPeriodStart.getTime()) {
      candidates.push(reminder);
    }
    candidates.push(row.trialEnd);
  } else if (row.status !== 'paused') {
    const notice = new Date(row.currentPeriodEnd.getTime() - UPCOMING_LEAD_MS);
    const noticed =
      row.upcomingNoticeSentAt !== null &&
      row.upcomingNoticeSentAt.getTime() >= row.currentPeriodStart.getTime();
    if (!row.cancelAtPeriodEnd && !noticed && notice.getTime() > row.currentPeriodStart.getTime()) {
      candidates.push(notice);
    }
    candidates.push(row.currentPeriodEnd);
  }
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates.map((at) => at.getTime())));
}
