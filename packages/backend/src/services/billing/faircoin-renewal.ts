import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  BillingFaircoinRenewalConsent,
  BillingFaircoinRenewalRevocation,
} from '@peable.to/shared-types';
import { billingIdempotencyKey, billingReference, BillingError, unixSeconds } from './contracts';
import { toUnix } from '../../lib/time';

const timestamp = z.string().datetime();
const positiveBaseUnits = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(80);
/** The wire consent (`BillingFaircoinRenewalConsent`): snake_case, Unix seconds. */
export const faircoinRenewalConsentSchema = z
  .object({
    authorization_id: billingReference,
    payer_account_id: billingReference,
    merchant_id: billingReference,
    app_id: billingReference,
    subscription_id: billingReference,
    plan_id: billingReference,
    mode: z.enum(['test', 'live']),
    environment: z.enum(['development', 'staging', 'production']),
    explicit_consent: z.literal(true),
    consent_evidence_id: billingReference,
    maximum_amount_base_units: positiveBaseUnits,
    interval: z.literal('month'),
    interval_count: z.literal(1),
    starts_at: unixSeconds,
    expires_at: unixSeconds,
    accepted_at: unixSeconds,
  })
  .strict()
  .refine(
    (value) =>
      value.expires_at > value.starts_at &&
      value.accepted_at <= value.starts_at &&
      (value.mode === 'live') === (value.environment === 'production'),
    'Invalid consent period or environment',
  );
/** The wire revocation (`BillingFaircoinRenewalRevocation`). */
export const faircoinRenewalRevocationSchema = z
  .object({
    authorization_id: billingReference,
    revoked_at: unixSeconds,
    revocation_evidence_id: billingReference,
  })
  .strict();
export interface FaircoinRenewalActor {
  payerAccountId: string;
  merchantId: string;
  appId: string;
  mode: 'test' | 'live';
  environment: 'development' | 'staging' | 'production';
}
export interface FaircoinRenewalInstruction {
  authorizationId: string;
  subscriptionId: string;
  planId: string;
  periodStart: string;
  periodEnd: string;
  amountBaseUnits: string;
  idempotencyKey: string;
}
export interface FaircoinRenewalRecord {
  consent: BillingFaircoinRenewalConsent;
  revocation: BillingFaircoinRenewalRevocation | null;
  instructions: FaircoinRenewalInstruction[];
  executions: FaircoinRenewalExecution[];
}
export const faircoinRenewalExecutionSchema = z
  .object({
    instructionIdempotencyKey: billingIdempotencyKey,
    remoteIdempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
    executorDomain: billingReference,
    status: z.enum(['accepted', 'indeterminate', 'cancelled', 'authorized']),
    attemptedAt: timestamp,
    permitRef: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    authorizedAt: timestamp.optional(),
    operationRef: billingReference.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !!value.permitRef === !!value.authorizedAt &&
      (value.status !== 'authorized' || !!value.permitRef) &&
      (value.status !== 'cancelled' || !value.permitRef),
    'Invalid dispatch permit',
  )
  .refine(
    (value) => (value.status === 'accepted' ? !!value.operationRef : !value.operationRef),
    'Accepted execution requires remote identity',
  );
export type FaircoinRenewalExecution = z.infer<typeof faircoinRenewalExecutionSchema>;

/** An implementation MUST persist each callback atomically under a row lock or
 * serializable transaction. Process-local locks are insufficient in production.
 * No default verifier or executor is installed; deployment composition is explicit. */
export interface FaircoinRenewalRepository {
  transaction<T>(
    namespace: string,
    authorizationId: string,
    action: (
      record: FaircoinRenewalRecord | null,
    ) => Promise<{ record: FaircoinRenewalRecord; result: T }>,
  ): Promise<T>;
}
/** The actor a consent was given by, for namespacing and ownership checks. */
export function faircoinRenewalActorOf(
  consent: BillingFaircoinRenewalConsent,
): FaircoinRenewalActor {
  return {
    payerAccountId: consent.payer_account_id,
    merchantId: consent.merchant_id,
    appId: consent.app_id,
    mode: consent.mode,
    environment: consent.environment,
  };
}
export function faircoinRenewalNamespace(actor: FaircoinRenewalActor): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        actor.merchantId,
        actor.appId,
        actor.mode,
        actor.environment,
        actor.payerAccountId,
      ]),
    )
    .digest('hex');
}
export function assertFaircoinRenewalActor(
  consent: BillingFaircoinRenewalConsent,
  actor: FaircoinRenewalActor,
): void {
  if (
    consent.payer_account_id !== actor.payerAccountId ||
    consent.merchant_id !== actor.merchantId ||
    consent.app_id !== actor.appId ||
    consent.mode !== actor.mode ||
    consent.environment !== actor.environment
  )
    throw new BillingError('not_found', 404);
}
export function assertFaircoinRenewalActive(
  consent: BillingFaircoinRenewalConsent,
  revocation: BillingFaircoinRenewalRevocation | null,
  now: Date,
): void {
  if (revocation || consent.starts_at > toUnix(now) || consent.expires_at <= toUnix(now))
    throw new BillingError('identity_conflict');
}
export const faircoinRenewalInstructionSchema = z
  .object({
    authorizationId: billingReference,
    subscriptionId: billingReference,
    planId: billingReference,
    periodStart: timestamp,
    periodEnd: timestamp,
    amountBaseUnits: positiveBaseUnits,
    idempotencyKey: billingIdempotencyKey,
  })
  .strict();

/** Scheduling authority only. Never takes keys, broadcasts, creates a live mandate,
 * or substitutes a money transfer for a renewal instruction. */
export function createFaircoinRenewalAuthorization(options: {
  repository: FaircoinRenewalRepository;
  verifyConsent: (consent: BillingFaircoinRenewalConsent) => Promise<boolean>;
  verifyRevocation: (
    revocation: BillingFaircoinRenewalRevocation,
    actor: FaircoinRenewalActor,
  ) => Promise<boolean>;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  async function revokeWithDispatchAcknowledgement(actor: FaircoinRenewalActor, raw: unknown) {
    const revocation = faircoinRenewalRevocationSchema.parse(raw);
    if (
      revocation.revoked_at > toUnix(now()) ||
      !(await options.verifyRevocation(revocation, actor))
    )
      throw new BillingError('identity_conflict');
    return options.repository.transaction(
      faircoinRenewalNamespace(actor),
      revocation.authorization_id,
      async (record) => {
        if (!record) throw new BillingError('not_found', 404);
        assertFaircoinRenewalActor(record.consent, actor);
        const finalRevocation = record.revocation ?? revocation;
        const alreadyAuthorized = record.executions
          .filter((value) => value.permitRef)
          .map((value) => ({
            instructionIdempotencyKey: value.instructionIdempotencyKey,
            executorDomain: value.executorDomain,
            permitRef: value.permitRef,
            status: value.status,
          }));
        return {
          record: { ...record, revocation: finalRevocation },
          result: { revocation: finalRevocation, alreadyAuthorized },
        };
      },
    );
  }
  return {
    async accept(actor: FaircoinRenewalActor, raw: unknown) {
      const consent = faircoinRenewalConsentSchema.parse(raw);
      assertFaircoinRenewalActor(consent, actor);
      if (
        consent.accepted_at > toUnix(now()) ||
        consent.expires_at <= toUnix(now()) ||
        !(await options.verifyConsent(consent))
      )
        throw new BillingError('identity_conflict');
      return options.repository.transaction(
        faircoinRenewalNamespace(actor),
        consent.authorization_id,
        async (record) => {
          if (record) {
            if (
              record.revocation ||
              JSON.stringify(faircoinRenewalConsentSchema.parse(record.consent)) !==
                JSON.stringify(consent)
            )
              throw new BillingError('idempotency_conflict');
            return { record, result: record.consent };
          }
          return {
            record: { consent, revocation: null, instructions: [], executions: [] },
            result: consent,
          };
        },
      );
    },
    async revoke(actor: FaircoinRenewalActor, raw: unknown) {
      return (await revokeWithDispatchAcknowledgement(actor, raw)).revocation;
    },
    revokeWithDispatchAcknowledgement,
    async prepareAutomaticRenewal(actor: FaircoinRenewalActor, raw: unknown) {
      const instruction = faircoinRenewalInstructionSchema.parse(raw);
      return options.repository.transaction(
        faircoinRenewalNamespace(actor),
        instruction.authorizationId,
        async (record) => {
          if (!record) throw new BillingError('not_found', 404);
          assertFaircoinRenewalActor(record.consent, actor);
          assertFaircoinRenewalActive(record.consent, record.revocation, now());
          const start = new Date(instruction.periodStart),
            end = new Date(instruction.periodEnd);
          const nextMonth = new Date(start);
          nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
          const daysInMonth = new Date(
            Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0),
          ).getUTCDate();
          nextMonth.setUTCDate(Math.min(start.getUTCDate(), daysInMonth));
          if (
            instruction.subscriptionId !== record.consent.subscription_id ||
            instruction.planId !== record.consent.plan_id ||
            BigInt(instruction.amountBaseUnits) >
              BigInt(record.consent.maximum_amount_base_units) ||
            start.getTime() < record.consent.starts_at * 1000 ||
            start.getTime() > now().getTime() ||
            end.getTime() <= now().getTime() ||
            end.getTime() > record.consent.expires_at * 1000 ||
            end.getTime() !== nextMonth.getTime()
          )
            throw new BillingError('identity_conflict');
          const replay = record.instructions.find(
            (value) => value.idempotencyKey === instruction.idempotencyKey,
          );
          if (replay) {
            if (
              JSON.stringify(faircoinRenewalInstructionSchema.parse(replay)) !==
              JSON.stringify(instruction)
            )
              throw new BillingError('idempotency_conflict');
            return { record, result: replay };
          }
          // Reject overlapping periods, not just matching starts: an altered start
          // cannot obtain a second instruction within the same monthly allowance.
          if (
            record.instructions.some(
              (value) =>
                Date.parse(value.periodStart) < end.getTime() &&
                Date.parse(value.periodEnd) > start.getTime(),
            )
          )
            throw new BillingError('idempotency_conflict');
          return {
            record: { ...record, instructions: [...record.instructions, instruction] },
            result: instruction,
          };
        },
      );
    },
    async assertExecutionAuthorized(actor: FaircoinRenewalActor, raw: unknown) {
      const instruction = faircoinRenewalInstructionSchema.parse(raw);
      return options.repository.transaction(
        faircoinRenewalNamespace(actor),
        instruction.authorizationId,
        async (record) => {
          if (!record) throw new BillingError('not_found', 404);
          assertFaircoinRenewalActor(record.consent, actor);
          assertFaircoinRenewalActive(record.consent, record.revocation, now());
          if (
            Date.parse(instruction.periodStart) > now().getTime() ||
            Date.parse(instruction.periodEnd) <= now().getTime()
          )
            throw new BillingError('identity_conflict');
          if (
            !record.instructions.some(
              (value) =>
                JSON.stringify(faircoinRenewalInstructionSchema.parse(value)) ===
                JSON.stringify(instruction),
            )
          )
            throw new BillingError('identity_conflict');
          return { record, result: instruction };
        },
      );
    },
    manualMonthlyRenewal() {
      return {
        status: 'payer_confirmation_required' as const,
        automaticallyAuthorized: false as const,
      };
    },
  };
}
