import { eq, sql } from 'drizzle-orm';
import type { BrandingBorderStyle, BrandingFont } from '@peable.to/shared-types';
import { merchantBranding, merchantEmailSettings } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * Reads and writes for a merchant's branding and customer-email settings
 * (Orbit Phase 3). Both are one row per merchant, created on first write; a
 * merchant with no row has Peable's defaults.
 */

export interface MerchantBrandingRow {
  readonly merchantId: string;
  readonly useAvatarAsIcon: boolean;
  readonly primaryColor: string | null;
  readonly accentColor: string | null;
  readonly font: BrandingFont | null;
  readonly borderStyle: BrandingBorderStyle | null;
  readonly termsOfServiceUrl: string | null;
  readonly updatedAt: Date | null;
}

const BRANDING_COLUMNS = {
  merchantId: merchantBranding.merchantId,
  useAvatarAsIcon: merchantBranding.useAvatarAsIcon,
  primaryColor: merchantBranding.primaryColor,
  accentColor: merchantBranding.accentColor,
  font: merchantBranding.font,
  borderStyle: merchantBranding.borderStyle,
  termsOfServiceUrl: merchantBranding.termsOfServiceUrl,
  updatedAt: merchantBranding.updatedAt,
} as const;

export function defaultBrandingRow(merchantId: string): MerchantBrandingRow {
  return {
    merchantId,
    useAvatarAsIcon: true,
    primaryColor: null,
    accentColor: null,
    font: null,
    borderStyle: null,
    termsOfServiceUrl: null,
    updatedAt: null,
  };
}

export async function findBranding(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<MerchantBrandingRow> {
  const [row] = await db
    .select(BRANDING_COLUMNS)
    .from(merchantBranding)
    .where(eq(merchantBranding.merchantId, merchantId));
  return row ? (row as MerchantBrandingRow) : defaultBrandingRow(merchantId);
}

export interface BrandingPatch {
  readonly useAvatarAsIcon?: boolean | undefined;
  readonly primaryColor?: string | null | undefined;
  readonly accentColor?: string | null | undefined;
  readonly font?: BrandingFont | null | undefined;
  readonly borderStyle?: BrandingBorderStyle | null | undefined;
  readonly termsOfServiceUrl?: string | null | undefined;
}

/** Upsert the branding (one row per merchant, created on first write). */
export async function upsertBranding(
  db: DatabaseOrTransaction,
  merchantId: string,
  patch: BrandingPatch,
): Promise<MerchantBrandingRow> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) values[key] = value;
  const [row] = await db
    .insert(merchantBranding)
    .values({ merchantId, ...values })
    .onConflictDoUpdate({
      target: merchantBranding.merchantId,
      set: { ...values, updatedAt: sql`date_trunc('milliseconds', now())` },
    })
    .returning(BRANDING_COLUMNS);
  if (!row) throw new Error('branding upsert returned no row');
  return row as MerchantBrandingRow;
}

// ---- Email settings ----------------------------------------------------------------

export interface MerchantEmailSettingsRow {
  readonly merchantId: string;
  readonly paymentReceipts: boolean;
  readonly refundNotices: boolean;
  readonly checkoutConfirmations: boolean;
  readonly supportEmail: string | null;
  readonly updatedAt: Date | null;
}

const EMAIL_COLUMNS = {
  merchantId: merchantEmailSettings.merchantId,
  paymentReceipts: merchantEmailSettings.paymentReceipts,
  refundNotices: merchantEmailSettings.refundNotices,
  checkoutConfirmations: merchantEmailSettings.checkoutConfirmations,
  supportEmail: merchantEmailSettings.supportEmail,
  updatedAt: merchantEmailSettings.updatedAt,
} as const;

export async function findEmailSettings(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<MerchantEmailSettingsRow> {
  const [row] = await db
    .select(EMAIL_COLUMNS)
    .from(merchantEmailSettings)
    .where(eq(merchantEmailSettings.merchantId, merchantId));
  return (
    row ?? {
      merchantId,
      paymentReceipts: true,
      refundNotices: true,
      checkoutConfirmations: false,
      supportEmail: null,
      updatedAt: null,
    }
  );
}

export interface EmailSettingsPatch {
  readonly paymentReceipts?: boolean | undefined;
  readonly refundNotices?: boolean | undefined;
  readonly checkoutConfirmations?: boolean | undefined;
  readonly supportEmail?: string | null | undefined;
}

export async function upsertEmailSettings(
  db: DatabaseOrTransaction,
  merchantId: string,
  patch: EmailSettingsPatch,
): Promise<MerchantEmailSettingsRow> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) values[key] = value;
  const [row] = await db
    .insert(merchantEmailSettings)
    .values({ merchantId, ...values })
    .onConflictDoUpdate({
      target: merchantEmailSettings.merchantId,
      set: { ...values, updatedAt: sql`date_trunc('milliseconds', now())` },
    })
    .returning(EMAIL_COLUMNS);
  if (!row) throw new Error('email settings upsert returned no row');
  return row;
}

/**
 * Claim the merchant's next receipt number — ONE statement, the derivation
 * index's pattern: the upsert takes the row lock and `RETURNING n - 1` is the
 * number this call owns, so two receipts never share one.
 */
export async function claimReceiptNumber(
  tx: DatabaseOrTransaction,
  merchantId: string,
): Promise<number> {
  const [row] = await tx
    .insert(merchantEmailSettings)
    .values({ merchantId, nextReceiptNumber: 2 })
    .onConflictDoUpdate({
      target: merchantEmailSettings.merchantId,
      set: { nextReceiptNumber: sql`${merchantEmailSettings.nextReceiptNumber} + 1` },
    })
    .returning({ claimed: sql<number>`${merchantEmailSettings.nextReceiptNumber} - 1` });
  if (!row) throw new Error('receipt number claim returned no row');
  return row.claimed;
}
