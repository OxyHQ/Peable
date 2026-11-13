import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres';
import { taxProductCodes, taxRegistrations, taxSettings } from '../schema/tax';

/** Called inside the invoice's consistent snapshot; preparatory evidence and
 * calculated quotes are outputs and deliberately never enter this read set. */
export async function readInvoiceTaxPolicy(
  db: DatabaseOrTransaction,
  merchantId: string,
  references: readonly string[],
) {
  const [settings] = await db
    .select()
    .from(taxSettings)
    .where(eq(taxSettings.merchantId, merchantId));
  const registrations = await db
    .select()
    .from(taxRegistrations)
    .where(eq(taxRegistrations.merchantId, merchantId))
    .orderBy(asc(taxRegistrations.id));
  const products = references.length
    ? await db
        .select()
        .from(taxProductCodes)
        .where(
          and(
            eq(taxProductCodes.merchantId, merchantId),
            inArray(taxProductCodes.productRef, [...references]),
          ),
        )
        .orderBy(asc(taxProductCodes.productRef))
    : [];
  return { settings: settings ?? null, registrations, products };
}
