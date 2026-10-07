import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BillingFaircoinRenewalConsent, BillingFaircoinRenewalRevocation } from '@peable.to/shared-types';
import { billingIdempotencyKey, billingReference, BillingError } from './contracts';

const timestamp = z.string().datetime();
const positiveBaseUnits = z.string().regex(/^[1-9][0-9]*$/).max(80);
export const faircoinRenewalConsentSchema = z.object({
  authorizationId: billingReference, payerAccountId: billingReference, merchantId: billingReference,
  appId: billingReference, subscriptionId: billingReference, planId: billingReference,
  mode: z.enum(['test', 'live']), environment: z.enum(['development', 'staging', 'production']),
  explicitConsent: z.literal(true), consentEvidenceId: billingReference,
  maximumAmountBaseUnits: positiveBaseUnits, interval: z.literal('month'), intervalCount: z.literal(1),
  startsAt: timestamp, expiresAt: timestamp, acceptedAt: timestamp,
}).strict().refine((value) => Date.parse(value.expiresAt) > Date.parse(value.startsAt)
  && Date.parse(value.acceptedAt) <= Date.parse(value.startsAt)
  && (value.mode === 'live') === (value.environment === 'production'), 'Invalid consent period or environment');
export interface FaircoinRenewalActor {
  payerAccountId: string; merchantId: string; appId: string;
  mode: 'test' | 'live'; environment: 'development' | 'staging' | 'production';
}
export interface FaircoinRenewalInstruction {
  authorizationId: string; subscriptionId: string; planId: string;
  periodStart: string; periodEnd: string; amountBaseUnits: string; idempotencyKey: string;
}
export interface FaircoinRenewalRecord {
  consent: BillingFaircoinRenewalConsent;
  revocation: BillingFaircoinRenewalRevocation | null;
  instructions: FaircoinRenewalInstruction[];
  executions: FaircoinRenewalExecution[];
}
export const faircoinRenewalExecutionSchema = z.object({
  instructionIdempotencyKey: billingIdempotencyKey, remoteIdempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  executorDomain: billingReference,
  status: z.enum(['accepted', 'indeterminate', 'cancelled', 'authorized']), attemptedAt: timestamp,
  permitRef: z.string().regex(/^[a-f0-9]{64}$/).optional(), authorizedAt: timestamp.optional(),
  operationRef: billingReference.optional(),
}).strict().refine(value => !!value.permitRef === !!value.authorizedAt && (value.status !== 'authorized' || !!value.permitRef) && (value.status !== 'cancelled' || !value.permitRef), 'Invalid dispatch permit').refine((value) => value.status === 'accepted' ? !!value.operationRef : !value.operationRef, 'Accepted execution requires remote identity');
export type FaircoinRenewalExecution = z.infer<typeof faircoinRenewalExecutionSchema>;

/** An implementation MUST persist each callback atomically under a row lock or
 * serializable transaction. Process-local locks are insufficient in production.
 * No default verifier or executor is installed; deployment composition is explicit. */
export interface FaircoinRenewalRepository {
  transaction<T>(namespace: string, authorizationId: string, action: (record: FaircoinRenewalRecord | null) => Promise<{ record: FaircoinRenewalRecord; result: T }>): Promise<T>;
}
export function faircoinRenewalNamespace(actor: FaircoinRenewalActor): string {
  return createHash('sha256').update(JSON.stringify([actor.merchantId, actor.appId, actor.mode, actor.environment, actor.payerAccountId])).digest('hex');
}
export function assertFaircoinRenewalActor(consent: BillingFaircoinRenewalConsent, actor: FaircoinRenewalActor): void {
  if (consent.payerAccountId !== actor.payerAccountId || consent.merchantId !== actor.merchantId || consent.appId !== actor.appId
    || consent.mode !== actor.mode || consent.environment !== actor.environment) throw new BillingError('not_found', 404);
}
export function assertFaircoinRenewalActive(consent: BillingFaircoinRenewalConsent, revocation: BillingFaircoinRenewalRevocation | null, now: Date): void {
  if (revocation || Date.parse(consent.startsAt) > now.getTime() || Date.parse(consent.expiresAt) <= now.getTime()) throw new BillingError('identity_conflict');
}
export const faircoinRenewalInstructionSchema = z.object({ authorizationId: billingReference, subscriptionId: billingReference, planId: billingReference,
  periodStart: timestamp, periodEnd: timestamp, amountBaseUnits: positiveBaseUnits, idempotencyKey: billingIdempotencyKey }).strict();

/** Scheduling authority only. Never takes keys, broadcasts, creates a live mandate,
 * or substitutes a money transfer for a renewal instruction. */
export function createFaircoinRenewalAuthorization(options: {
  repository: FaircoinRenewalRepository;
  verifyConsent: (consent: BillingFaircoinRenewalConsent) => Promise<boolean>;
  verifyRevocation: (revocation: BillingFaircoinRenewalRevocation, actor: FaircoinRenewalActor) => Promise<boolean>;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  async function revokeWithDispatchAcknowledgement(actor: FaircoinRenewalActor, raw: unknown) {
      const revocation = z.object({ authorizationId: billingReference, revokedAt: timestamp, revocationEvidenceId: billingReference }).strict().parse(raw);
      if (Date.parse(revocation.revokedAt) > now().getTime() || !await options.verifyRevocation(revocation, actor)) throw new BillingError('identity_conflict');
      return options.repository.transaction(faircoinRenewalNamespace(actor), revocation.authorizationId, async (record) => {
        if (!record) throw new BillingError('not_found', 404);
        assertFaircoinRenewalActor(record.consent, actor);
        const finalRevocation = record.revocation ?? revocation;
        const alreadyAuthorized = record.executions.filter(value => value.permitRef).map(value => ({ instructionIdempotencyKey: value.instructionIdempotencyKey, executorDomain: value.executorDomain, permitRef: value.permitRef, status: value.status }));
        return { record: { ...record, revocation: finalRevocation }, result: { revocation: finalRevocation, alreadyAuthorized } };
      });
  }
  return {
    async accept(actor: FaircoinRenewalActor, raw: unknown) {
      const consent = faircoinRenewalConsentSchema.parse(raw);
      assertFaircoinRenewalActor(consent, actor);
      if (Date.parse(consent.acceptedAt) > now().getTime() || Date.parse(consent.expiresAt) <= now().getTime()
        || !await options.verifyConsent(consent)) throw new BillingError('identity_conflict');
      return options.repository.transaction(faircoinRenewalNamespace(actor), consent.authorizationId, async (record) => {
        if (record) {
          if (record.revocation || JSON.stringify(faircoinRenewalConsentSchema.parse(record.consent)) !== JSON.stringify(consent)) throw new BillingError('idempotency_conflict');
          return { record, result: record.consent };
        }
        return { record: { consent, revocation: null, instructions: [], executions: [] }, result: consent };
      });
    },
    async revoke(actor: FaircoinRenewalActor, raw: unknown) { return (await revokeWithDispatchAcknowledgement(actor, raw)).revocation; },
    revokeWithDispatchAcknowledgement,
    async prepareAutomaticRenewal(actor: FaircoinRenewalActor, raw: unknown) {
      const instruction = faircoinRenewalInstructionSchema.parse(raw);
      return options.repository.transaction(faircoinRenewalNamespace(actor), instruction.authorizationId, async (record) => {
        if (!record) throw new BillingError('not_found', 404);
        assertFaircoinRenewalActor(record.consent, actor); assertFaircoinRenewalActive(record.consent, record.revocation, now());
        const start = new Date(instruction.periodStart), end = new Date(instruction.periodEnd);
        const nextMonth = new Date(start);
        nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
        const daysInMonth = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0)).getUTCDate();
        nextMonth.setUTCDate(Math.min(start.getUTCDate(), daysInMonth));
        if (instruction.subscriptionId !== record.consent.subscriptionId || instruction.planId !== record.consent.planId
          || BigInt(instruction.amountBaseUnits) > BigInt(record.consent.maximumAmountBaseUnits)
          || start.getTime() < Date.parse(record.consent.startsAt) || start.getTime() > now().getTime() || end.getTime() <= now().getTime()
          || end.getTime() > Date.parse(record.consent.expiresAt) || end.getTime() !== nextMonth.getTime()) throw new BillingError('identity_conflict');
        const replay = record.instructions.find((value) => value.idempotencyKey === instruction.idempotencyKey);
        if (replay) {
          if (JSON.stringify(faircoinRenewalInstructionSchema.parse(replay)) !== JSON.stringify(instruction)) throw new BillingError('idempotency_conflict');
          return { record, result: replay };
        }
        // Reject overlapping periods, not just matching starts: an altered start
        // cannot obtain a second instruction within the same monthly allowance.
        if (record.instructions.some((value) => Date.parse(value.periodStart) < end.getTime() && Date.parse(value.periodEnd) > start.getTime())) throw new BillingError('idempotency_conflict');
        return { record: { ...record, instructions: [...record.instructions, instruction] }, result: instruction };
      });
    },
    async assertExecutionAuthorized(actor: FaircoinRenewalActor, raw: unknown) {
      const instruction = faircoinRenewalInstructionSchema.parse(raw);
      return options.repository.transaction(faircoinRenewalNamespace(actor), instruction.authorizationId, async (record) => {
        if (!record) throw new BillingError('not_found', 404);
        assertFaircoinRenewalActor(record.consent, actor); assertFaircoinRenewalActive(record.consent, record.revocation, now());
        if (Date.parse(instruction.periodStart) > now().getTime() || Date.parse(instruction.periodEnd) <= now().getTime()) throw new BillingError('identity_conflict');
        if (!record.instructions.some((value) => JSON.stringify(faircoinRenewalInstructionSchema.parse(value)) === JSON.stringify(instruction))) throw new BillingError('identity_conflict');
        return { record, result: instruction };
      });
    },
    manualMonthlyRenewal() { return { status: 'payer_confirmation_required' as const, automaticallyAuthorized: false as const }; },
  };
}
