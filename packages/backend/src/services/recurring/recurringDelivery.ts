import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/postgres';
import { merchants, recurringMirrors, recurringObservationOutbox } from '../../db/schema';
import { enqueueWebhook } from '../../db/webhooks/webhookOutboxRepository';
import { buildEvent } from '../webhookDispatcher';
import { toUnix } from '../../lib/time';
import type { BillingCohort } from '../billing/billingService';
import { recurringSnapshotSchema } from './contracts';
/** Disabled returns before schema access. Requires pre migration.
 * Relay pointer + public delivery commit together; the private promise already
 * committed with the observation. Wake-up only, never paid/grant authority. */
export async function relayRecurringObservations(options: {
  enabled?: boolean;
  db: Database;
  cohorts: readonly BillingCohort[];
  limit?: number;
}) {
  if (options.enabled !== true) return { kind: 'disabled' as const, enqueued: 0 };
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid recurring relay limit');
  let enqueued = 0;
  for (const cohort of options.cohorts) {
    if (!cohort.evidenceRef || (cohort.environment === 'production') !== cohort.livemode)
      throw new Error('Invalid recurring relay cohort');
    enqueued += await options.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          observation: recurringObservationOutbox,
          mirror: recurringMirrors,
          merchant: merchants,
        })
        .from(recurringObservationOutbox)
        .innerJoin(recurringMirrors, eq(recurringObservationOutbox.mirrorId, recurringMirrors.id))
        .innerJoin(merchants, eq(recurringMirrors.merchantId, merchants.id))
        .where(
          and(
            isNull(recurringObservationOutbox.deliveryId),
            eq(recurringMirrors.merchantId, cohort.merchantId),
            eq(recurringMirrors.oxyAppId, cohort.oxyAppId),
            eq(recurringMirrors.environment, cohort.environment),
            eq(recurringMirrors.provider, cohort.provider),
            eq(recurringMirrors.platformAccountId, cohort.platformAccountId),
            eq(recurringMirrors.livemode, cohort.livemode),
          ),
        )
        .orderBy(recurringObservationOutbox.observedAt)
        .limit(limit)
        .for('update', { of: recurringObservationOutbox, skipLocked: true });
      let count = 0;
      for (const { observation, mirror, merchant } of rows) {
        if (!merchant.webhookUrl || !merchant.webhookSecret) continue;
        // Use this immutable observation revision, not the mirror's later snapshot.
        const snapshot = recurringSnapshotSchema.parse(observation.snapshot);
        if (
          snapshot.kind !== mirror.kind ||
          snapshot.objectRef !== mirror.objectRef ||
          snapshot.provider !== cohort.provider ||
          snapshot.platformAccountId !== cohort.platformAccountId ||
          snapshot.livemode !== cohort.livemode ||
          snapshot.providerAccountId !== mirror.providerAccountId
        )
          throw new Error('Recurring delivery snapshot identity differs');
        const event = buildEvent('billing.observation.updated', {
          object: 'billing_observation',
          livemode: cohort.livemode,
          resource_kind: mirror.kind as 'subscription' | 'invoice',
          resource_id: mirror.objectRef,
          subscription_id:
            snapshot.kind === 'subscription' ? snapshot.objectRef : snapshot.subscriptionRef,
          revision: observation.revision,
          observed_at: toUnix(observation.observedAt),
        });
        const deliveryId = await enqueueWebhook(tx, {
          merchantId: merchant.id,
          url: merchant.webhookUrl,
          event,
        });
        await tx
          .update(recurringObservationOutbox)
          .set({ deliveryId })
          .where(eq(recurringObservationOutbox.id, observation.id));
        count++;
      }
      return count;
    });
  }
  return { kind: 'relayed' as const, enqueued };
}
