import { z } from 'zod';
import { MERCHANT_ENVIRONMENTS } from '@peable.to/shared-types';
import { environmentMatchesMode } from '../providers/environmentGuard';

export const recurringReferenceSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const reference = recurringReferenceSchema;
const period = z.object({
  itemRef: reference,
  start: z.string().datetime(),
  end: z.string().datetime(),
}).strict().refine((value) => Date.parse(value.end) > Date.parse(value.start), 'Invalid period');
const identity = {
  schemaVersion: z.literal(1),
  provider: z.literal('stripe'),
  platformAccountId: reference,
  providerAccountId: reference.nullable(),
  livemode: z.boolean(),
  objectRef: reference,
  apiVersion: reference,
};
const periods = z.array(period).max(1000).refine(
  (values) => new Set(values.map((value) => value.itemRef)).size === values.length,
  'Duplicate period item',
);
const amount = z.string().regex(/^(0|[1-9][0-9]*)$/).max(80);

/** Whitelisted observations, not provider payloads or commercial entitlement decisions. */
export const recurringSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({
    ...identity,
    kind: z.literal('subscription'),
    status: z.enum(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']),
    cancelAtPeriodEnd: z.boolean(),
    periods,
    // The trusted reader must exhaust pagination before returning. This checks
    // its declared contract; it cannot prove remote completeness cryptographically.
    hasMorePeriods: z.literal(false),
  }).strict(),
  z.object({
    ...identity,
    kind: z.literal('invoice'),
    subscriptionRef: reference,
    status: z.enum(['draft', 'open', 'paid', 'void', 'uncollectible']),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountDue: amount,
    amountPaid: amount,
    amountRemaining: amount,
    periods,
    hasMorePeriods: z.literal(false),
  }).strict(),
]);
export type RecurringSnapshot = z.infer<typeof recurringSnapshotSchema>;
export type RecurringKind = RecurringSnapshot['kind'];

/** Supplied only by trusted internal composition, never an event or public API. */
export const deploymentIdentitySchema = z.object({
  provider: z.literal('stripe'),
  platformAccountId: reference,
  livemode: z.boolean(),
  environment: z.enum(MERCHANT_ENVIRONMENTS),
  apiVersion: reference,
}).strict().refine((value) => environmentMatchesMode(value.environment, value.livemode),
  'Deployment mode/environment mismatch');
export type DeploymentIdentity = z.infer<typeof deploymentIdentitySchema>;

export interface RecurringReadRequest {
  readonly deployment: DeploymentIdentity;
  readonly providerAccountId: string | null;
  readonly kind: RecurringKind;
  readonly objectRef: string;
  readonly signal: AbortSignal;
}
/** A read-only seam. No production adapter or credentials are introduced here. */
export interface RecurringReader {
  readSnapshot(request: RecurringReadRequest): Promise<unknown>;
}
export interface RecurringObservationOptions {
  readonly deployment: DeploymentIdentity;
  readonly reader: RecurringReader;
  readonly timeoutMs?: number;
}
