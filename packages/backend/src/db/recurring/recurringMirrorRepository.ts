import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { z } from 'zod';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { recurringMirrors, recurringObservationOutbox } from '../schema';
import { findMerchantById } from '../merchants/merchantRepository';
import { deploymentIdentitySchema, recurringReferenceSchema, type DeploymentIdentity, type RecurringKind, type RecurringSnapshot } from '../../services/recurring/contracts';

export type RecurringMirror = typeof recurringMirrors.$inferSelect;
const bindingSchema = z.object({
  merchantId: z.string().min(1),
  providerAccountId: recurringReferenceSchema.nullable(),
  kind: z.enum(['subscription', 'invoice']),
  objectRef: recurringReferenceSchema,
  bindingEvidenceRef: recurringReferenceSchema,
}).strict();
export type BindingInput = z.infer<typeof bindingSchema>;

/**
 * INTERNAL only: a future approved importer supplies deployment identity and
 * evidence; tests supply synthetic evidence. No public route or event metadata
 * calls this. App/environment come from the existing merchant, never the event.
 * Identity is immutable through this repository, not through a database trigger.
 */
export async function bindRecurringObject(db: DatabaseOrTransaction, deploymentInput: DeploymentIdentity, input: BindingInput): Promise<RecurringMirror> {
  const deployment = deploymentIdentitySchema.parse(deploymentInput);
  const binding = bindingSchema.parse(input);
  const merchant = await findMerchantById(db, binding.merchantId);
  if (!merchant || merchant.environment !== deployment.environment) throw new Error('Recurring binding merchant/environment mismatch');
  const [inserted] = await db.insert(recurringMirrors).values({
    id: uuidv7(), ...binding, oxyAppId: merchant.oxyAppId, environment: merchant.environment,
    provider: deployment.provider, platformAccountId: deployment.platformAccountId, livemode: deployment.livemode,
  }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const existing = await findRecurringMirror(db, deployment, binding.kind, binding.objectRef, binding.providerAccountId);
  if (!existing || existing.merchantId !== merchant.id || existing.oxyAppId !== merchant.oxyAppId
    || existing.environment !== merchant.environment || existing.bindingEvidenceRef !== binding.bindingEvidenceRef) {
    throw new Error('Recurring binding identity conflict');
  }
  return existing;
}

export function mirrorIdentity(deployment: DeploymentIdentity, kind: RecurringKind, objectRef: string, account: string | null) {
  return and(eq(recurringMirrors.provider, deployment.provider), eq(recurringMirrors.platformAccountId, deployment.platformAccountId),
    eq(recurringMirrors.livemode, deployment.livemode), eq(recurringMirrors.kind, kind), eq(recurringMirrors.objectRef, objectRef),
    account === null ? isNull(recurringMirrors.providerAccountId) : eq(recurringMirrors.providerAccountId, account));
}
export async function findRecurringMirror(db: DatabaseOrTransaction, deployment: DeploymentIdentity, kind: RecurringKind, objectRef: string, account: string | null): Promise<RecurringMirror | null> {
  const [row] = await db.select().from(recurringMirrors).where(mirrorIdentity(deployment, kind, objectRef, account));
  return row ?? null;
}

/** The only update API: explicitly whitelists observation columns. Caller holds row lock. */
export async function persistRecurringObservation(tx: Transaction, mirror: RecurringMirror, snapshot: RecurringSnapshot, sourceEventId: string, observedAt: Date): Promise<number> {
  const revision = mirror.revision + 1;
  await tx.update(recurringMirrors).set({ snapshot, revision, observedAt }).where(eq(recurringMirrors.id, mirror.id));
  await tx.insert(recurringObservationOutbox).values({
    id: uuidv7(), mirrorId: mirror.id, revision, sourceEventId, snapshot, observedAt,
  });
  return revision;
}
