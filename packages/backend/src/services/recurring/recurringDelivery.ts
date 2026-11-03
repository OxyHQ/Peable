import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/postgres';
import { recurringMirrors, recurringObservationOutbox } from '../../db/schema';
import { recordEvent } from '../events';
import { toUnix } from '../../lib/time';
import type { BillingCohort } from '../billing/billingService';
import { recurringSnapshotSchema } from './contracts';
/** Disabled returns before schema access. Requires pre migration.
 * The relay marker and the public event commit together; the private promise
 * already committed with the observation. Wake-up only, never paid/grant
 * authority. The event is recorded whether or not the merchant has an
 * endpoint that wants it — `/v1/events` is the record (ADR 0014 D4). */
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
        })
        .from(recurringObservationOutbox)
        .innerJoin(recurringMirrors, eq(recurringObservationOutbox.mirrorId, recurringMirrors.id))
        .where(
          and(
            isNull(recurringObservationOutbox.relayedAt),
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
      for (const { observation, mirror } of rows) {
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
        const event = await recordEvent(tx, {
          merchantId: mirror.merchantId,
          type: 'billing.observation.updated',
          object: {
            object: 'billing_observation',
            livemode: cohort.livemode,
            resource_kind: mirror.kind as 'subscription' | 'invoice',
            resource_id: mirror.objectRef,
            subscription_id:
              snapshot.kind === 'subscription' ? snapshot.objectRef : snapshot.subscriptionRef,
            revision: observation.revision,
            observed_at: toUnix(observation.observedAt),
          },
        });
        await tx
          .update(recurringObservationOutbox)
          .set({ relayedAt: event.createdAt, eventId: event.id })
          .where(eq(recurringObservationOutbox.id, observation.id));
        count++;
      }
      return count;
    });
  }
  return { kind: 'relayed' as const, enqueued };
}
