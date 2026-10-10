import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BillingError, billingReference } from './contracts';
import {
  assertFaircoinRenewalActor,
  faircoinRenewalExecutionSchema,
  faircoinRenewalInstructionSchema,
  faircoinRenewalNamespace,
  type FaircoinRenewalActor,
  type FaircoinRenewalInstruction,
  type FaircoinRenewalExecution,
  type FaircoinRenewalRecord,
  type FaircoinRenewalRepository,
} from './faircoin-renewal';

export type FaircoinExecutionRecovery =
  | { kind: 'not_found' }
  | { kind: 'indeterminate' }
  | { kind: 'accepted'; operationRef: string };
export interface FaircoinDispatchPermit {
  executorDomain: string;
  permitRef: string;
  authorizedAt: string;
}
interface ExecutorInput {
  actor: FaircoinRenewalActor;
  instruction: FaircoinRenewalInstruction;
  idempotencyKey: string;
}
export interface FaircoinRenewalExecutor {
  /** Immutable authority domain for the provider/deployment/account and durable
   * idempotency store. Replacing that authority requires a different domain. */
  readonly domain: string;
  /** Read-only lookup. not_found conclusively excludes prior/in-flight effects.
   * Network uncertainty is never not_found. */
  recover(input: ExecutorInput): Promise<FaircoinExecutionRecovery>;
  /** Independently verify the confirmed permit in the durable authority store
   * binds this domain, actor, instruction and key; never trust an arbitrary ref.
   * Domain identifies the same verified shared idempotency store. MUST atomically deduplicate
   * the stable key, including simultaneous attempts, and settle the submission
   * attempt before resolving/rejecting. No fire-and-forget dispatch afterwards.
   * Revocation after permit commit cannot undo already-authorized effects. */
  execute(
    input: ExecutorInput & { permit: FaircoinDispatchPermit },
  ): Promise<Exclude<FaircoinExecutionRecovery, { kind: 'not_found' }>>;
}
const outcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_found') }).strict(),
  z.object({ kind: z.literal('indeterminate') }).strict(),
  z.object({ kind: z.literal('accepted'), operationRef: billingReference }).strict(),
]);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Domain binding precedes all remote calls. Recovery holds no stale DB lock;
 * fresh authority is committed before dispatch. No effect follows an uncertain
 * commit. The permit commit, rather than wallet settlement, is the revocation
 * linearization point. No live executor is installed by default. */
export function createFaircoinRenewalConsumer(options: {
  repository: FaircoinRenewalRepository;
  executor?: FaircoinRenewalExecutor;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const executor = options.executor;
  const domain = executor ? billingReference.parse(executor.domain) : undefined;
  return {
    async consume(actor: FaircoinRenewalActor, raw: unknown): Promise<FaircoinRenewalExecution> {
      if (!executor || !domain) throw new BillingError('provider_unavailable', 503);
      const instruction = faircoinRenewalInstructionSchema.parse(raw);
      const namespace = faircoinRenewalNamespace(actor);
      const remoteKey = hash([domain, namespace, instruction]);
      const input = { actor, instruction, idempotencyKey: remoteKey };
      function requireRecord(record: FaircoinRenewalRecord | null) {
        if (!record) throw new BillingError('not_found', 404);
        assertFaircoinRenewalActor(record.consent, actor);
        if (
          !record.instructions.some(
            (value) =>
              JSON.stringify(faircoinRenewalInstructionSchema.parse(value)) ===
              JSON.stringify(instruction),
          )
        )
          throw new BillingError('identity_conflict');
        const previous = record.executions.find(
          (value) => value.instructionIdempotencyKey === instruction.idempotencyKey,
        );
        if (
          previous &&
          (previous.executorDomain !== domain || previous.remoteIdempotencyKey !== remoteKey)
        )
          throw new BillingError('idempotency_conflict');
        return { record, previous };
      }
      const put = (record: FaircoinRenewalRecord, execution: FaircoinRenewalExecution) => ({
        ...record,
        executions: [
          ...record.executions.filter(
            (value) => value.instructionIdempotencyKey !== instruction.idempotencyKey,
          ),
          execution,
        ],
      });
      // The confirmed binding survives remote acceptance plus local outcome loss.
      const bound = await options.repository.transaction(
        namespace,
        instruction.authorizationId,
        async (rawRecord) => {
          const { record, previous } = requireRecord(rawRecord);
          const execution =
            previous ??
            faircoinRenewalExecutionSchema.parse({
              executorDomain: domain,
              instructionIdempotencyKey: instruction.idempotencyKey,
              remoteIdempotencyKey: remoteKey,
              attemptedAt: now().toISOString(),
              status: 'indeterminate',
            });
          return { record: put(record, execution), result: execution };
        },
      );
      if (bound.status === 'accepted' || bound.status === 'cancelled') return bound;
      let outcome: FaircoinExecutionRecovery;
      try {
        outcome = outcomeSchema.parse(await executor.recover(structuredClone(input)));
      } catch {
        outcome = { kind: 'indeterminate' };
      }
      // Reopen a fresh transaction after recovery: a prior DB session/lock may
      // have disappeared and revocation may now be committed on another session.
      const authorized = await options.repository.transaction(
        namespace,
        instruction.authorizationId,
        async (rawRecord) => {
          const { record, previous } = requireRecord(rawRecord);
          if (!previous) throw new BillingError('identity_conflict');
          if (previous.status === 'accepted' || previous.status === 'cancelled')
            return { record, result: previous };
          const time = now().getTime();
          const active =
            !record.revocation &&
            Date.parse(record.consent.startsAt) <= time &&
            Date.parse(record.consent.expiresAt) > time &&
            Date.parse(instruction.periodStart) <= time &&
            Date.parse(instruction.periodEnd) > time &&
            BigInt(instruction.amountBaseUnits) <= BigInt(record.consent.maximumAmountBaseUnits);
          const execution = faircoinRenewalExecutionSchema.parse({
            ...previous,
            attemptedAt: now().toISOString(),
            status:
              outcome.kind === 'accepted'
                ? 'accepted'
                : outcome.kind === 'not_found'
                  ? active
                    ? 'authorized'
                    : previous.permitRef
                      ? 'indeterminate'
                      : 'cancelled'
                  : 'indeterminate',
            ...(outcome.kind === 'accepted' ? { operationRef: outcome.operationRef } : {}),
            ...(outcome.kind === 'not_found' && active
              ? {
                  permitRef: previous.permitRef ?? hash(['dispatch-permit-v1', domain, remoteKey]),
                  authorizedAt: previous.authorizedAt ?? now().toISOString(),
                }
              : {}),
          });
          return { record: put(record, execution), result: execution };
        },
      );
      if (authorized.status !== 'authorized') return authorized;
      // This line is reachable only after the fresh permit commit resolves.
      if (!authorized.permitRef || !authorized.authorizedAt)
        throw new BillingError('identity_conflict');
      try {
        outcome = outcomeSchema.parse(
          await executor.execute(
            structuredClone({
              ...input,
              permit: {
                executorDomain: domain,
                permitRef: authorized.permitRef,
                authorizedAt: authorized.authorizedAt,
              },
            }),
          ),
        );
        if (outcome.kind === 'not_found') throw new Error('Execution cannot return not_found');
      } catch {
        outcome = { kind: 'indeterminate' };
      }
      return options.repository.transaction(
        namespace,
        instruction.authorizationId,
        async (rawRecord) => {
          const { record, previous } = requireRecord(rawRecord);
          if (!previous || previous.permitRef !== authorized.permitRef)
            throw new BillingError('identity_conflict');
          if (previous.status === 'accepted' || previous.status === 'cancelled')
            return { record, result: previous };
          const execution = faircoinRenewalExecutionSchema.parse({
            ...previous,
            attemptedAt: now().toISOString(),
            status: outcome.kind === 'accepted' ? 'accepted' : 'indeterminate',
            ...(outcome.kind === 'accepted' ? { operationRef: outcome.operationRef } : {}),
          });
          return { record: put(record, execution), result: execution };
        },
      );
    },
  };
}
