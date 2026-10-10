import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { providerEvents, recurringMirrors } from '../../db/schema';
import { markProviderEventProcessed } from '../../db/providers/providerEventRepository';
import {
  findRecurringMirror,
  mirrorIdentity,
  persistRecurringObservation,
} from '../../db/recurring/recurringMirrorRepository';
import {
  deploymentIdentitySchema,
  recurringSnapshotSchema,
  type RecurringKind,
  type RecurringObservationOptions,
  type RecurringReadRequest,
} from './contracts';

export type ObservationOutcome =
  | { readonly kind: 'observed'; readonly mirrorId: string; readonly revision: number }
  | { readonly kind: 'unchanged'; readonly mirrorId: string }
  | { readonly kind: 'already_processed' }
  | { readonly kind: 'unmatched' }
  | { readonly kind: 'failed'; readonly error: string };

// JSONB does not preserve key order. Ordinal key ordering is deterministic
// across machines/locales; array order is normalized explicitly below.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function recurringEventKind(type: string): RecurringKind | undefined {
  if (type.startsWith('customer.subscription.')) return 'subscription';
  if (type.startsWith('invoice.') || type === 'charge.refunded' || type.startsWith('refund.'))
    return 'invoice';
  return undefined;
}

async function readBounded(
  options: RecurringObservationOptions,
  request: Omit<RecurringReadRequest, 'signal'>,
  read?: (signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new Error('Invalid observation timeout');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read
        ? read(controller.signal)
        : options.reader.readSnapshot({ ...request, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Observation timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opt-in internal projection only. Read the STORED event, never caller-supplied
 * claims/payload. No public creator, timer, production reader, or dispatcher.
 * An unmatched result stays pending for an explicit retry after approved binding;
 * this module schedules no retry and does not prevent processing other objects.
 */
export async function observeRecurringEvent(
  eventId: string,
  options: RecurringObservationOptions,
): Promise<ObservationOutcome> {
  try {
    const deployment = deploymentIdentitySchema.parse(options.deployment);
    return await getDb().transaction(async (tx): Promise<ObservationOutcome> => {
      const [event] = await tx
        .select()
        .from(providerEvents)
        .where(eq(providerEvents.id, eventId))
        .for('update');
      if (!event) return { kind: 'unmatched' };
      if (event.processedAt) return { kind: 'already_processed' };
      const kind = recurringEventKind(event.type);
      if (!kind) return { kind: 'unmatched' };
      const refundEvent = event.type === 'charge.refunded' || event.type.startsWith('refund.');
      if (
        event.provider !== deployment.provider ||
        event.livemode !== deployment.livemode ||
        (!refundEvent && event.apiVersion !== deployment.apiVersion)
      )
        throw new Error('Observation event identity mismatch');
      let objectRef = event.objectIds[kind];
      if (refundEvent) {
        // Refund wake-ups may name only a charge/PI. Adopt nothing: use only an
        // already owned, previously proven cash invoice's stored payment lineage.
        const charge = event.objectIds.charge;
        const intent = event.objectIds.payment_intent;
        if (!charge && !intent) return { kind: 'unmatched' };
        const matches = await tx
          .select()
          .from(recurringMirrors)
          .where(
            and(
              eq(recurringMirrors.provider, deployment.provider),
              eq(recurringMirrors.platformAccountId, deployment.platformAccountId),
              eq(recurringMirrors.livemode, deployment.livemode),
              eq(recurringMirrors.environment, deployment.environment),
              eq(recurringMirrors.kind, 'invoice'),
              sql`${recurringMirrors.providerAccountId} is not distinct from ${event.providerAccountId}`,
              charge ? sql`${recurringMirrors.snapshot}->>'chargeRef' = ${charge}` : undefined,
              intent
                ? sql`${recurringMirrors.snapshot}->>'paymentIntentRef' = ${intent}`
                : undefined,
            ),
          )
          .limit(2);
        if (matches.length !== 1) return { kind: 'unmatched' };
        objectRef = matches[0]!.objectRef;
        // Only an exact owned recurring lineage selects this version contract.
        // Unowned refunds retain the existing one-off processor's compatibility.
        if (event.apiVersion !== deployment.apiVersion)
          throw new Error('Observation event identity mismatch');
      }
      if (!objectRef) return { kind: 'unmatched' };
      let [mirror] = await tx
        .select()
        .from(recurringMirrors)
        .where(
          and(
            mirrorIdentity(deployment, kind, objectRef, event.providerAccountId),
            eq(recurringMirrors.environment, deployment.environment),
          ),
        )
        .for('update');
      if (!mirror && kind === 'invoice' && !refundEvent && options.bindOwnedInvoice) {
        await readBounded(
          options,
          { deployment, providerAccountId: event.providerAccountId, kind, objectRef },
          (signal) =>
            options.bindOwnedInvoice!({
              deployment,
              providerAccountId: event.providerAccountId,
              kind,
              objectRef: objectRef!,
              signal,
            }),
        );
        [mirror] = await tx
          .select()
          .from(recurringMirrors)
          .where(
            and(
              mirrorIdentity(deployment, kind, objectRef, event.providerAccountId),
              eq(recurringMirrors.environment, deployment.environment),
            ),
          )
          .for('update');
      }
      if (!mirror) return { kind: 'unmatched' };

      // Serialize reads too: a later event cannot overwrite a newer read with
      // an earlier request's delayed response. Provider consistency itself is
      // the reader's contract, not guaranteed by webhook timestamps or ids.
      const value = await readBounded(options, {
        deployment,
        providerAccountId: event.providerAccountId,
        kind,
        objectRef,
      });
      const snapshot = recurringSnapshotSchema.parse(value);
      const observedAt = new Date(); // observation time, AFTER the read; not event.created
      if (
        snapshot.provider !== deployment.provider ||
        snapshot.platformAccountId !== deployment.platformAccountId ||
        snapshot.providerAccountId !== event.providerAccountId ||
        snapshot.livemode !== deployment.livemode ||
        snapshot.kind !== kind ||
        snapshot.objectRef !== objectRef ||
        snapshot.apiVersion !== deployment.apiVersion
      ) {
        throw new Error('Observation snapshot identity mismatch');
      }
      if (snapshot.kind === 'invoice') {
        if (
          refundEvent &&
          ((event.objectIds.charge && snapshot.chargeRef !== event.objectIds.charge) ||
            (event.objectIds.payment_intent &&
              snapshot.paymentIntentRef !== event.objectIds.payment_intent))
        )
          throw new Error('Refund payment lineage differs');
        const parent = await findRecurringMirror(
          tx,
          deployment,
          'subscription',
          snapshot.subscriptionRef,
          event.providerAccountId,
        );
        if (
          !parent ||
          parent.merchantId !== mirror.merchantId ||
          parent.oxyAppId !== mirror.oxyAppId ||
          parent.environment !== mirror.environment
        )
          throw new Error('Observation subscription ownership mismatch');
        if (
          mirror.snapshot?.kind === 'invoice' &&
          mirror.snapshot.subscriptionRef !== snapshot.subscriptionRef
        ) {
          throw new Error('Observation invoice relationship changed');
        }
      }
      // Normalize collection order only; never use lexicographic event ids to order STATE.
      snapshot.periods.sort((a, b) => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0));
      if (
        canonicalJson(snapshot) ===
        canonicalJson(
          mirror.snapshot === null ? null : recurringSnapshotSchema.parse(mirror.snapshot),
        )
      ) {
        await markProviderEventProcessed(tx, event.id);
        return { kind: 'unchanged', mirrorId: mirror.id };
      }
      const revision = await persistRecurringObservation(
        tx,
        mirror,
        snapshot,
        event.id,
        observedAt,
      );
      await markProviderEventProcessed(tx, event.id);
      return { kind: 'observed', mirrorId: mirror.id, revision };
    });
  } catch {
    // No reader/provider text, raw payload or PII goes into operator state.
    // A failure rolls back event completion, snapshot and outbox together.
    return { kind: 'failed', error: 'recurring_observation_failed' };
  }
}
