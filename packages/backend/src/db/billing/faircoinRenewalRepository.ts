import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { z } from 'zod';
import type { Database } from '../postgres';
import { faircoinRenewalAuthorizations } from '../schema';
import { findMerchantByAppEnvironment } from '../merchants/merchantRepository';
import { billingReference, BillingError } from '../../services/billing/contracts';
import { faircoinRenewalConsentSchema, faircoinRenewalInstructionSchema, faircoinRenewalNamespace,
  type FaircoinRenewalRepository, type FaircoinRenewalRecord } from '../../services/billing/faircoin-renewal';

const recordSchema = z.object({ consent: faircoinRenewalConsentSchema,
  revocation: z.object({ authorizationId: billingReference, revokedAt: z.string().datetime(), revocationEvidenceId: billingReference }).strict().nullable(),
  instructions: z.array(faircoinRenewalInstructionSchema),
}).strict();

/** Durable atomic scheduling state. An xact advisory lock also protects the first
 * insert; row locks alone cannot serialize two callers when no row exists yet.
 * Hash collisions serialize unrelated operations, never mix their identities. */
export function createPostgresFaircoinRenewalRepository(db: Database): FaircoinRenewalRepository {
  return {
    async transaction<T>(namespace: string, authorizationId: string, action: (record: FaircoinRenewalRecord | null) => Promise<{ record: FaircoinRenewalRecord; result: T }>): Promise<T> {
      const parsedNamespace = z.string().regex(/^[a-f0-9]{64}$/).parse(namespace);
      const parsedId = billingReference.parse(authorizationId);
      return db.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${parsedNamespace}:${parsedId}`}, 0))`);
        const identity = and(eq(faircoinRenewalAuthorizations.namespaceDigest, parsedNamespace), eq(faircoinRenewalAuthorizations.authorizationRef, parsedId));
        const [row] = await transaction.select().from(faircoinRenewalAuthorizations).where(identity).for('update');
        const previous = row ? recordSchema.parse({ consent: row.consent, revocation: row.revocation, instructions: row.instructions }) : null;
        // Copy so a callback cannot mutate the comparison snapshot in place.
        const outcome = await action(previous ? structuredClone(previous) : null);
        const record = recordSchema.parse(outcome.record);
        if (record.consent.authorizationId !== parsedId || faircoinRenewalNamespace(record.consent) !== parsedNamespace
          || record.revocation && record.revocation.authorizationId !== parsedId
          || record.instructions.some((instruction) => instruction.authorizationId !== parsedId
            || instruction.subscriptionId !== record.consent.subscriptionId || instruction.planId !== record.consent.planId)) throw new BillingError('identity_conflict');
        if (previous && (JSON.stringify(previous.consent) !== JSON.stringify(record.consent)
          || previous.revocation && JSON.stringify(previous.revocation) !== JSON.stringify(record.revocation)
          || previous.instructions.some((instruction) => !record.instructions.some((candidate) => JSON.stringify(instruction) === JSON.stringify(candidate))))) throw new BillingError('identity_conflict');
        const merchant = await findMerchantByAppEnvironment(transaction, record.consent.appId, record.consent.environment);
        if (!merchant || merchant.publicId !== record.consent.merchantId) throw new BillingError('not_found', 404);
        if (row) {
          if (row.merchantId !== merchant.id || row.oxyAppId !== merchant.oxyAppId || row.environment !== merchant.environment) throw new BillingError('identity_conflict');
          await transaction.update(faircoinRenewalAuthorizations).set({ consent: record.consent, revocation: record.revocation, instructions: record.instructions }).where(identity);
        } else {
          await transaction.insert(faircoinRenewalAuthorizations).values({ id: uuidv7(), merchantId: merchant.id, oxyAppId: merchant.oxyAppId,
            environment: merchant.environment, namespaceDigest: parsedNamespace, authorizationRef: parsedId, ...record });
        }
        return outcome.result;
      });
    },
  };
}
