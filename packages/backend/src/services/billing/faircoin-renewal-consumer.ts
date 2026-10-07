import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BillingError, billingReference } from './contracts';
import { assertFaircoinRenewalActor, faircoinRenewalExecutionSchema, faircoinRenewalInstructionSchema, faircoinRenewalNamespace,
  type FaircoinRenewalActor, type FaircoinRenewalInstruction, type FaircoinRenewalExecution, type FaircoinRenewalRepository } from './faircoin-renewal';

export type FaircoinExecutionRecovery = { kind: 'not_found' } | { kind: 'indeterminate' } | { kind: 'accepted'; operationRef: string };
export interface FaircoinRenewalExecutor {
  /** Authoritative lookup for the stable key. not_found must conclusively exclude
   * a prior/in-flight submission; a network error is never not_found. */
  recover(input: { actor: FaircoinRenewalActor; instruction: FaircoinRenewalInstruction; idempotencyKey: string }): Promise<FaircoinExecutionRecovery>;
  /** MUST deduplicate this key, submit within the call, and settle the submission
   * attempt before resolving or rejecting. No delayed/fire-and-forget dispatch after settlement.
   * Accepted operations may settle later; revocation cannot undo earlier dispatch. */
  execute(input: { actor: FaircoinRenewalActor; instruction: FaircoinRenewalInstruction; idempotencyKey: string }): Promise<Exclude<FaircoinExecutionRecovery, { kind: 'not_found' }>>;
}
const outcomeSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('not_found') }).strict(),
  z.object({ kind: z.literal('indeterminate') }).strict(), z.object({ kind: z.literal('accepted'), operationRef: billingReference }).strict()]);

/** No default executor or boot worker. The existing durable authorization lock
 * orders dispatch and revocation. No Promise.race releases it while execution
 * continues. A process crash retries recover first with exactly the same key. */
export function createFaircoinRenewalConsumer(options: { repository: FaircoinRenewalRepository; executor?: FaircoinRenewalExecutor; now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  return {
    async consume(actor: FaircoinRenewalActor, raw: unknown): Promise<FaircoinRenewalExecution> {
      if (!options.executor) throw new BillingError('provider_unavailable', 503);
      const executor = options.executor;
      const instruction = faircoinRenewalInstructionSchema.parse(raw);
      const namespace = faircoinRenewalNamespace(actor);
      const remoteKey = createHash('sha256').update(JSON.stringify([namespace, instruction])).digest('hex');
      return options.repository.transaction(namespace, instruction.authorizationId, async (record) => {
        if (!record) throw new BillingError('not_found', 404);
        assertFaircoinRenewalActor(record.consent, actor);
        if (!record.instructions.some((value) => JSON.stringify(faircoinRenewalInstructionSchema.parse(value)) === JSON.stringify(instruction))) throw new BillingError('identity_conflict');
        const previous = record.executions.find((value) => value.instructionIdempotencyKey === instruction.idempotencyKey);
        if (previous && previous.remoteIdempotencyKey !== remoteKey) throw new BillingError('idempotency_conflict');
        if (previous?.status === 'accepted' || previous?.status === 'cancelled') return { record, result: previous };
        const active = () => !record.revocation && Date.parse(record.consent.startsAt) <= now().getTime()
          && Date.parse(record.consent.expiresAt) > now().getTime() && Date.parse(instruction.periodStart) <= now().getTime()
          && Date.parse(instruction.periodEnd) > now().getTime() && BigInt(instruction.amountBaseUnits) <= BigInt(record.consent.maximumAmountBaseUnits);
        let outcome: FaircoinExecutionRecovery = { kind: 'indeterminate' };
        // Recovery is mandatory even after revocation: a remote acceptance can
        // survive a crash/rollback before any local execution row is committed.
        try { outcome = outcomeSchema.parse(await executor.recover(structuredClone({ actor, instruction, idempotencyKey: remoteKey }))); }
        catch { outcome = { kind: 'indeterminate' }; }
        if (outcome.kind === 'not_found' && active()) {
          try {
            outcome = outcomeSchema.parse(await executor.execute(structuredClone({ actor, instruction, idempotencyKey: remoteKey })));
            if (outcome.kind === 'not_found') throw new Error('Execution cannot return not_found');
          } catch { outcome = { kind: 'indeterminate' }; }
        }
        const execution = faircoinRenewalExecutionSchema.parse({ instructionIdempotencyKey: instruction.idempotencyKey,
          remoteIdempotencyKey: remoteKey, attemptedAt: now().toISOString(),
          status: outcome.kind === 'accepted' ? 'accepted' : outcome.kind === 'not_found' ? 'cancelled' : 'indeterminate',
          ...(outcome.kind === 'accepted' ? { operationRef: outcome.operationRef } : {}),
        });
        return { record: { ...record, executions: [...record.executions.filter((value) => value.instructionIdempotencyKey !== instruction.idempotencyKey), execution] }, result: execution };
      });
    },
  };
}
