import { z } from 'zod';
import { STRIPE_API_VERSION } from '../providers/stripe/client';
import {
  deploymentIdentitySchema,
  recurringReferenceSchema as ref,
  recurringSnapshotSchema,
  type DeploymentIdentity,
  type RecurringReader,
  type RecurringReadRequest,
} from './contracts';

/** Private, read-only seam; no SDK construction, credentials or production wiring. */
export interface RecurringStripeReadOptions {
  readonly apiVersion: typeof STRIPE_API_VERSION;
  readonly stripeAccount?: string;
  readonly signal: AbortSignal;
}
export interface RecurringStripeReadClient {
  retrieveSubscription(id: string, options: RecurringStripeReadOptions): Promise<unknown>;
  listSubscriptionItems(
    params: { subscription: string; limit: 100; starting_after?: string },
    options: RecurringStripeReadOptions,
  ): Promise<unknown>;
  retrieveInvoice(id: string, options: RecurringStripeReadOptions): Promise<unknown>;
  listInvoiceLines(
    id: string,
    params: { limit: 100; starting_after?: string },
    options: RecurringStripeReadOptions,
  ): Promise<unknown>;
}
const seconds = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .refine((n) => Number.isFinite(new Date(n * 1000).getTime()));
const units = z.number().int().safe().nonnegative().transform(String);
const rootIdentity = { id: ref, livemode: z.boolean() };
const subscription = z.object({
  ...rootIdentity,
  object: z.literal('subscription'),
  status: z.string(),
  cancel_at_period_end: z.boolean(),
});
// Expanded references are deliberately unsupported; the client must request unexpanded IDs.
const invoice = z.object({
  ...rootIdentity,
  object: z.literal('invoice'),
  status: z.string(),
  currency: z.string().regex(/^[a-z]{3}$/),
  amount_due: units,
  amount_paid: units,
  amount_remaining: units,
  parent: z.object({
    type: z.literal('subscription_details'),
    subscription_details: z.object({ subscription: ref }),
  }),
});
const item = z.object({
  id: ref,
  object: z.literal('subscription_item'),
  subscription: ref,
  current_period_start: seconds,
  current_period_end: seconds,
});
const line = z.object({
  id: ref,
  object: z.literal('line_item'),
  invoice: ref,
  livemode: z.boolean(),
  subscription: ref,
  parent: z.object({
    type: z.literal('subscription_item_details'),
    subscription_item_details: z.object({
      subscription: ref,
      subscription_item: ref,
      proration: z.literal(false),
    }),
  }),
  period: z.object({ start: seconds, end: seconds }),
});
const page = z.object({
  object: z.literal('list'),
  data: z.array(z.unknown()).max(100),
  has_more: z.boolean(),
});
const iso = (value: number) => new Date(value * 1000).toISOString();
const fail = (): never => {
  throw new Error('Recurring read rejected');
};

/** Observe abort even when the injected client ignores it; never begin a later page. */
function read<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Recurring read aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Recurring read aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) return fail();
        return call();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Identity is trusted configuration for an already-bound object, not provider attestation. */
export function createPrivateStripeRecurringReader(
  client: RecurringStripeReadClient,
  configuration: { deployment: DeploymentIdentity; providerAccountId: string | null },
): RecurringReader {
  const configured = deploymentIdentitySchema.parse(configuration.deployment);
  const account = ref.nullable().parse(configuration.providerAccountId);
  if (configured.apiVersion !== STRIPE_API_VERSION) fail();
  return {
    async readSnapshot(request: RecurringReadRequest) {
      const deployment = deploymentIdentitySchema.parse(request.deployment);
      if (
        Object.keys(configured).some(
          (key) =>
            configured[key as keyof DeploymentIdentity] !==
            deployment[key as keyof DeploymentIdentity],
        ) ||
        request.providerAccountId !== account
      )
        fail();
      ref.parse(request.objectRef);
      if (request.kind !== 'subscription' && request.kind !== 'invoice') fail();
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      // One budget for root, all pages and recheck, additionally bounded by observer's signal.
      const timer = setTimeout(abort, 2000);
      const options: RecurringStripeReadOptions = {
        apiVersion: STRIPE_API_VERSION,
        ...(account === null ? {} : { stripeAccount: account }),
        signal: controller.signal,
      };
      try {
        const getRoot = async () => {
          const raw = await read(controller.signal, () =>
            request.kind === 'subscription'
              ? client.retrieveSubscription(request.objectRef, options)
              : client.retrieveInvoice(request.objectRef, options),
          );
          const root =
            request.kind === 'subscription' ? subscription.parse(raw) : invoice.parse(raw);
          if (root.id !== request.objectRef || root.livemode !== deployment.livemode) fail();
          return root;
        };
        const root = await getRoot();
        const periods: Array<{ itemRef: string; start: string; end: string }> = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let index = 0; ; index++) {
          if (index === 20) fail();
          const params = {
            limit: 100 as const,
            ...(cursor === undefined ? {} : { starting_after: cursor }),
          };
          const result = page.parse(
            await read(controller.signal, () =>
              request.kind === 'subscription'
                ? client.listSubscriptionItems(
                    { ...params, subscription: request.objectRef },
                    options,
                  )
                : client.listInvoiceLines(request.objectRef, params, options),
            ),
          );
          if (result.has_more && result.data.length === 0) fail();
          for (const raw of result.data) {
            let normalized: { itemRef: string; start: string; end: string };
            if (root.object === 'subscription') {
              const value = item.parse(raw);
              if (value.subscription !== root.id) fail();
              normalized = {
                itemRef: value.id,
                start: iso(value.current_period_start),
                end: iso(value.current_period_end),
              };
            } else {
              const value = line.parse(raw);
              const subscriptionRef = root.parent.subscription_details.subscription;
              if (
                value.invoice !== root.id ||
                value.livemode !== root.livemode ||
                value.subscription !== subscriptionRef ||
                value.parent.subscription_item_details.subscription !== subscriptionRef
              )
                fail();
              normalized = {
                itemRef: value.id,
                start: iso(value.period.start),
                end: iso(value.period.end),
              };
            }
            if (seen.has(normalized.itemRef) || periods.length === 1000) fail();
            seen.add(normalized.itemRef);
            periods.push(normalized);
          }
          if (!result.has_more) break;
          const next = periods.at(-1)?.itemRef;
          if (!next || next === cursor || periods.length === 1000) fail();
          cursor = next;
        }
        // Detect changes to observed root fields only. This is NOT an atomic remote snapshot.
        if (JSON.stringify(root) !== JSON.stringify(await getRoot())) fail();
        periods.sort((a, b) => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0));
        const identity = {
          schemaVersion: 1,
          provider: 'stripe',
          platformAccountId: deployment.platformAccountId,
          providerAccountId: account,
          livemode: root.livemode,
          objectRef: root.id,
          apiVersion: STRIPE_API_VERSION,
          periods,
          hasMorePeriods: false,
        };
        return recurringSnapshotSchema.parse(
          root.object === 'subscription'
            ? {
                ...identity,
                kind: 'subscription',
                status: root.status,
                cancelAtPeriodEnd: root.cancel_at_period_end,
              }
            : {
                ...identity,
                kind: 'invoice',
                subscriptionRef: root.parent.subscription_details.subscription,
                status: root.status,
                currency: root.currency.toUpperCase(),
                amountDue: root.amount_due,
                amountPaid: root.amount_paid,
                amountRemaining: root.amount_remaining,
              },
        );
      } catch {
        // Raw provider payloads/errors can contain PII; do not propagate them.
        throw new Error('Recurring read rejected');
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', abort);
      }
    },
  };
}
