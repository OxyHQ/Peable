import { eq, sql } from 'drizzle-orm';
import type { DunningFinalAction, DunningInvoiceAction } from '@peable.to/shared-types';
import { billingSettings, merchants } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { nowMs } from './columns';

/**
 * `billing_settings` (ADR 0018 §6): a merchant's numbering and dunning. The
 * row is created on first need with every default, so a merchant that never
 * opens the settings screen bills with the documented defaults.
 */

export interface BillingSettingsRow {
  readonly merchantId: string;
  readonly invoicePrefix: string;
  readonly nextInvoiceNumber: number;
  readonly defaultDaysUntilDue: number;
  readonly retryScheduleDays: number[];
  readonly finalAction: DunningFinalAction;
  readonly invoiceAction: DunningInvoiceAction;
  readonly emailInvoiceFinalized: boolean;
  readonly emailPaymentFailed: boolean;
  readonly updatedAt: Date;
}

const COLUMNS = {
  merchantId: billingSettings.merchantId,
  invoicePrefix: billingSettings.invoicePrefix,
  nextInvoiceNumber: billingSettings.nextInvoiceNumber,
  defaultDaysUntilDue: billingSettings.defaultDaysUntilDue,
  retryScheduleDays: billingSettings.retryScheduleDays,
  finalAction: billingSettings.finalAction,
  invoiceAction: billingSettings.invoiceAction,
  emailInvoiceFinalized: billingSettings.emailInvoiceFinalized,
  emailPaymentFailed: billingSettings.emailPaymentFailed,
  updatedAt: billingSettings.updatedAt,
} as const;

const toRow = (row: { finalAction: string; invoiceAction: string; [key: string]: unknown }) =>
  row as unknown as BillingSettingsRow;

/**
 * The default invoice prefix: eight characters of the merchant's own public
 * id, upper-cased — stable, distinct per merchant, and never chosen by the
 * caller, so two merchants' numbers do not look alike by default.
 */
export function defaultInvoicePrefix(merchantPublicId: string): string {
  const hex = merchantPublicId.replace(/^merch_/, '').replace(/[^0-9a-f]/gi, '');
  return (hex.slice(0, 8) || 'INV').toUpperCase().padEnd(3, '0');
}

/** The settings, created with every default the first time they are needed. */
export async function ensureBillingSettings(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<BillingSettingsRow> {
  const [existing] = await db
    .select(COLUMNS)
    .from(billingSettings)
    .where(eq(billingSettings.merchantId, merchantId));
  if (existing) return toRow(existing);
  const [merchant] = await db
    .select({ publicId: merchants.publicId })
    .from(merchants)
    .where(eq(merchants.id, merchantId));
  if (!merchant) throw new Error(`no merchant ${merchantId}`);
  await db
    .insert(billingSettings)
    .values({ merchantId, invoicePrefix: defaultInvoicePrefix(merchant.publicId) })
    .onConflictDoNothing();
  const [row] = await db
    .select(COLUMNS)
    .from(billingSettings)
    .where(eq(billingSettings.merchantId, merchantId));
  if (!row) throw new Error('billing settings vanished');
  return toRow(row);
}

export interface BillingSettingsPatch {
  readonly invoicePrefix?: string | undefined;
  readonly defaultDaysUntilDue?: number | undefined;
  readonly retryScheduleDays?: readonly number[] | undefined;
  readonly finalAction?: DunningFinalAction | undefined;
  readonly invoiceAction?: DunningInvoiceAction | undefined;
  readonly emailInvoiceFinalized?: boolean | undefined;
  readonly emailPaymentFailed?: boolean | undefined;
}

export async function updateBillingSettings(
  db: DatabaseOrTransaction,
  merchantId: string,
  patch: BillingSettingsPatch,
): Promise<BillingSettingsRow> {
  await ensureBillingSettings(db, merchantId);
  const [row] = await db
    .update(billingSettings)
    .set({
      ...(patch.invoicePrefix !== undefined ? { invoicePrefix: patch.invoicePrefix } : {}),
      ...(patch.defaultDaysUntilDue !== undefined
        ? { defaultDaysUntilDue: patch.defaultDaysUntilDue }
        : {}),
      ...(patch.retryScheduleDays !== undefined
        ? { retryScheduleDays: [...patch.retryScheduleDays] }
        : {}),
      ...(patch.finalAction !== undefined ? { finalAction: patch.finalAction } : {}),
      ...(patch.invoiceAction !== undefined ? { invoiceAction: patch.invoiceAction } : {}),
      ...(patch.emailInvoiceFinalized !== undefined
        ? { emailInvoiceFinalized: patch.emailInvoiceFinalized }
        : {}),
      ...(patch.emailPaymentFailed !== undefined
        ? { emailPaymentFailed: patch.emailPaymentFailed }
        : {}),
      updatedAt: nowMs,
    })
    .where(eq(billingSettings.merchantId, merchantId))
    .returning(COLUMNS);
  if (!row) throw new Error('billing settings vanished');
  return toRow(row);
}

/**
 * Take the merchant's next invoice number — ONE statement, the derivation
 * index's pattern (`CONVENTIONS.md` §Counters): the upsert row-locks the
 * settings row and returns the PRE-increment value, so two finalizes each get
 * a distinct number with no read-modify-write race. It MUST run inside the
 * finalize's own transaction: a rollback then returns the number with
 * everything else, which is what makes the sequence gapless.
 *
 * `integer` for the counter's reason in that section: the value comes back a
 * JS number, never a string that `+ 1` would concatenate.
 */
export async function takeInvoiceNumber(
  tx: Transaction,
  merchantId: string,
): Promise<{ number: number; prefix: string }> {
  await ensureBillingSettings(tx, merchantId);
  const [row] = await tx
    .update(billingSettings)
    .set({ nextInvoiceNumber: sql`${billingSettings.nextInvoiceNumber} + 1` })
    .where(eq(billingSettings.merchantId, merchantId))
    .returning({
      number: sql<number>`${billingSettings.nextInvoiceNumber} - 1`,
      prefix: billingSettings.invoicePrefix,
    });
  if (!row) throw new Error('billing settings vanished under a finalize');
  return row;
}

/** `PREFIX-0001`: at least four digits, more when the sequence needs them. */
export function formatInvoiceNumber(prefix: string, number: number): string {
  return `${prefix}-${String(number).padStart(4, '0')}`;
}
