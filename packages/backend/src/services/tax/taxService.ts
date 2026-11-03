import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  TAX_REGISTRATION_SCHEMES,
  type TaxAddress,
  type TaxBehavior,
  type TaxCalculation,
  type TaxCalculationLineItem,
  type TaxLocationEvidence,
  type TaxProductCode,
  type TaxRegistration,
  type TaxReport,
  type TaxReportRow,
  type TaxSettings,
  type TaxTransaction,
  type TaxTransactionReversal,
} from '@peable.to/shared-types';
import type { Database, DatabaseOrTransaction } from '../../db/postgres';
import {
  taxCalculations,
  taxLocationEvidence,
  taxProductCodes,
  taxRegistrations,
  taxSettings,
  taxTransactions,
} from '../../db/schema/tax';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { keyset, type KeysetPage } from '../../db/keyset';
import { newId } from '../../lib/ids';
import { paramFromPath } from '../../lib/http';
import { fromUnix, toUnix, toUnixOrNull } from '../../lib/time';
import { unixSeconds } from '../billing/contracts';
import { isKnownTaxCode, NONTAXABLE_TAX_CODE } from './codes';
import { createTaxLocationEvidenceSchema, evaluateEvidence, taxAddressSchema } from './evidence';
import {
  registrationCovers,
  stripeRegistrationOptions,
  validateRegistration,
} from './jurisdictions';
import { TaxProviderUnavailableError, type TaxProvider } from './provider';
import { TaxCustomerLocationInvalidError } from './stripeTaxProvider';

/** What a merchant must know about why a tax request was refused. */
export type TaxErrorCode =
  | 'not_found'
  | 'invalid_tax_request'
  | 'invalid_tax_code'
  | 'invalid_registration'
  | 'registration_immutable'
  | 'tax_settings_not_active'
  | 'approval_incomplete'
  | 'approval_requires_provider'
  | 'customer_location_insufficient'
  | 'customer_location_conflicting'
  | 'customer_location_invalid'
  | 'customer_location_expired'
  | 'tax_calculation_unavailable'
  | 'tax_provider_registration_mismatch';

/** 422 is never used (ADR 0014 D1): a well-formed request Peable refuses is a 400. */
const STATUS: Record<TaxErrorCode, number> = {
  not_found: 404,
  invalid_tax_request: 400,
  invalid_tax_code: 400,
  invalid_registration: 400,
  registration_immutable: 409,
  tax_settings_not_active: 409,
  approval_incomplete: 400,
  approval_requires_provider: 409,
  customer_location_insufficient: 400,
  customer_location_conflicting: 400,
  customer_location_invalid: 400,
  customer_location_expired: 409,
  tax_calculation_unavailable: 503,
  tax_provider_registration_mismatch: 503,
};

/** What each refusal means, for the error's human `message`; the machine
 * reason is the `code` beside it. */
const MESSAGE: Record<TaxErrorCode, string> = {
  not_found: 'No such tax object.',
  invalid_tax_request: 'The tax request is invalid.',
  invalid_tax_code: 'Unknown tax code.',
  invalid_registration: 'The tax registration is invalid.',
  registration_immutable: 'An approved or ended registration cannot be changed this way.',
  tax_settings_not_active: 'Tax settings have not been approved by the owner.',
  approval_incomplete: 'Tax settings are not complete enough to approve.',
  approval_requires_provider: 'Registered sales need a tax provider; this application has none.',
  customer_location_insufficient: 'The customer location evidence is insufficient.',
  customer_location_conflicting: 'The customer location evidence is conflicting.',
  customer_location_invalid: 'The tax provider could not use the customer location.',
  customer_location_expired: 'The customer location evidence has expired.',
  tax_calculation_unavailable: 'Tax could not be calculated right now.',
  tax_provider_registration_mismatch:
    'The tax provider does not collect where Peable is registered; nothing was quoted.',
};

export class TaxError extends Error {
  readonly status: number;
  constructor(
    readonly code: TaxErrorCode,
    readonly detail?: string,
    /** The offending request field, in bracket notation, when there is one. */
    readonly param?: string,
  ) {
    super(detail ? `${MESSAGE[code]} ${detail}` : MESSAGE[code]);
    this.name = 'TaxError';
    this.status = STATUS[code];
  }
}

/** Evidence stays usable for a day: long enough for one checkout, short
 * enough that a renewal brings its own. */
const EVIDENCE_LIFETIME_MS = 24 * 3600_000;
const MAX_CALCULATION_LIFETIME_MS = 24 * 3600_000;

const settingsUpdateSchema = z
  .object({
    legal_name: z.string().trim().min(1).max(200).nullable().optional(),
    head_office: taxAddressSchema.nullable().optional(),
    default_tax_code: z.string().optional(),
    default_tax_behavior: z.enum(['inclusive', 'exclusive']).optional(),
  })
  .strict();
const registrationCreateSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    state: z
      .string()
      .regex(/^[A-Z0-9]{1,3}$/)
      .nullish(),
    scheme: z.enum(TAX_REGISTRATION_SCHEMES),
    registration_number: z.string().trim().min(1).max(64).nullish(),
    active_from: unixSeconds.optional(),
    expires_at: unixSeconds.nullish(),
  })
  .strict();
const registrationUpdateSchema = z.object({ expires_at: unixSeconds }).strict();
const productRef = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const lineItemsSchema = z
  .array(
    z
      .object({
        reference: z.string().min(1).max(200),
        amount: z.number().int().nonnegative().safe(),
        quantity: z.number().int().positive().max(1_000_000).optional(),
        tax_code: z.string().optional(),
        tax_behavior: z.enum(['inclusive', 'exclusive']).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .refine(
    (lines) => new Set(lines.map((line) => line.reference)).size === lines.length,
    'Line references must be unique',
  );
export const createTaxCalculationSchema = z
  .object({
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    customer_location_evidence_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    line_items: lineItemsSchema,
  })
  .strict();
/** The filing window of a report: `from` inclusive, `to` exclusive, Unix seconds. */
export const taxReportQuerySchema = z
  .object({
    from: z.coerce.number().pipe(unixSeconds),
    to: z.coerce.number().pipe(unixSeconds),
  })
  .strict();

const createReversalSchema = z
  .object({
    reference: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    amount: z.number().int().positive().safe().optional(),
  })
  .strict();

type SettingsRow = typeof taxSettings.$inferSelect;
type RegistrationRow = typeof taxRegistrations.$inferSelect;
type EvidenceRow = typeof taxLocationEvidence.$inferSelect;
type CalculationRow = typeof taxCalculations.$inferSelect;

export interface TaxServiceOptions {
  db: Database;
  /** The platform's provider account; absent when no provider is configured. */
  provider?: TaxProvider;
  ipHashSalt?: string;
  now?: () => Date;
}

/**
 * Peable Tax. One instance per process; every method is scoped to the merchant
 * passed in, which the route resolved from its credential or dashboard access.
 */
export function createTaxService(options: TaxServiceOptions) {
  const { db, provider } = options;
  const now = options.now ?? (() => new Date());

  async function settingsRow(merchant: MerchantRow, tx: DatabaseOrTransaction = db) {
    const [row] = await tx
      .select()
      .from(taxSettings)
      .where(eq(taxSettings.merchantId, merchant.id));
    return row;
  }
  /** The provider this merchant's registered sales are calculated by, if any. */
  function providerFor(merchant: MerchantRow, row: SettingsRow | undefined) {
    if (!provider || row?.calculationAccount !== 'platform') return undefined;
    // One key, one mode: a test merchant never reaches a live provider account.
    if (provider.livemode !== (merchant.environment === 'production')) return undefined;
    return provider;
  }
  function settingsDto(merchant: MerchantRow, row: SettingsRow | undefined): TaxSettings {
    return {
      object: 'tax.settings',
      merchant_id: merchant.publicId,
      status: row?.status ?? 'draft',
      legal_name: row?.legalName ?? null,
      head_office: row?.headOffice ?? null,
      default_tax_code: row?.defaultTaxCode ?? 'txcd_10000000',
      default_tax_behavior: row?.defaultTaxBehavior ?? 'exclusive',
      calculation_account: row?.calculationAccount ?? 'none',
      provider: providerFor(merchant, row)?.id ?? null,
      approved_at: toUnixOrNull(row?.approvedAt),
      approved_by: row?.approvedBy ?? null,
      updated_at: toUnixOrNull(row?.updatedAt),
    };
  }
  function registrationDto(row: RegistrationRow, at = now()): TaxRegistration {
    const status: TaxRegistration['status'] = !row.approvedAt
      ? 'pending_approval'
      : row.expiresAt && +row.expiresAt <= +at
        ? 'expired'
        : row.activeFrom && +row.activeFrom > +at
          ? 'scheduled'
          : 'active';
    return {
      object: 'tax.registration',
      id: row.publicId,
      country: row.country,
      state: row.state,
      scheme: row.scheme,
      registration_number: row.registrationNumber,
      active_from: toUnix(row.activeFrom ?? row.createdAt),
      expires_at: toUnixOrNull(row.expiresAt),
      status,
      approved_at: toUnixOrNull(row.approvedAt),
      provider_registration_ref: row.providerRef,
      created: toUnix(row.createdAt),
    };
  }
  function evidenceDto(merchant: MerchantRow, row: EvidenceRow): TaxLocationEvidence {
    return {
      object: 'tax.location_evidence',
      id: row.publicId,
      customer_ref: row.customerRef,
      status: row.status,
      rule: row.rule,
      country: row.country,
      state: row.state,
      items: row.items.map((item) => ({
        type: item.type as TaxLocationEvidence['items'][number]['type'],
        country: item.country,
        state: item.state,
      })),
      observed_at: toUnix(row.observedAt),
      expires_at: toUnix(row.expiresAt),
      livemode: merchant.livemode,
    };
  }
  function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
    const result = schema.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new TaxError(
        'invalid_tax_request',
        issue?.message,
        issue ? paramFromPath(issue.path) : undefined,
      );
    }
    return result.data;
  }
  /** Approved registrations in force at `at` that cover the location. */
  async function coveringRegistrations(
    merchant: MerchantRow,
    country: string,
    state: string | null,
    at: Date,
  ) {
    const rows = await db
      .select()
      .from(taxRegistrations)
      .where(
        and(
          eq(taxRegistrations.merchantId, merchant.id),
          isNotNull(taxRegistrations.approvedAt),
          or(isNull(taxRegistrations.expiresAt), gt(taxRegistrations.expiresAt, at)),
        ),
      );
    return (
      rows
        .filter((row) => !row.activeFrom || +row.activeFrom <= +at)
        .filter((row) => registrationCovers(row, country, state))
        // The most specific registration (a state's) is the one cited.
        .sort((a, b) => Number(b.state !== null) - Number(a.state !== null))
    );
  }

  const service = {
    async getSettings(merchant: MerchantRow): Promise<TaxSettings> {
      return settingsDto(merchant, await settingsRow(merchant));
    },
    /** Any change returns the settings to draft: an approval covers what was approved. */
    async updateSettings(merchant: MerchantRow, raw: unknown): Promise<TaxSettings> {
      const input = parse(settingsUpdateSchema, raw);
      if (input.default_tax_code !== undefined && !isKnownTaxCode(input.default_tax_code))
        throw new TaxError('invalid_tax_code', input.default_tax_code);
      const values = {
        ...(input.legal_name !== undefined ? { legalName: input.legal_name } : {}),
        ...(input.head_office !== undefined
          ? { headOffice: input.head_office as TaxAddress | null }
          : {}),
        ...(input.default_tax_code !== undefined ? { defaultTaxCode: input.default_tax_code } : {}),
        ...(input.default_tax_behavior !== undefined
          ? { defaultTaxBehavior: input.default_tax_behavior }
          : {}),
      };
      const [row] = await db
        .insert(taxSettings)
        .values({ merchantId: merchant.id, ...values })
        .onConflictDoUpdate({
          target: taxSettings.merchantId,
          set: { ...values, status: 'draft', updatedAt: now() },
        })
        .returning();
      return settingsDto(merchant, row);
    },
    async listRegistrations(merchant: MerchantRow): Promise<TaxRegistration[]> {
      const rows = await db
        .select()
        .from(taxRegistrations)
        .where(eq(taxRegistrations.merchantId, merchant.id))
        .orderBy(asc(taxRegistrations.createdAt));
      return rows.map((row) => registrationDto(row));
    },
    async createRegistration(merchant: MerchantRow, raw: unknown): Promise<TaxRegistration> {
      const input = parse(registrationCreateSchema, raw);
      const state = input.state ?? null;
      const problem = validateRegistration(input.country, state, input.scheme);
      if (problem) throw new TaxError('invalid_registration', problem);
      const activeFrom = input.active_from !== undefined ? fromUnix(input.active_from) : null;
      const expiresAt =
        input.expires_at !== undefined && input.expires_at !== null
          ? fromUnix(input.expires_at)
          : null;
      if (expiresAt && +expiresAt <= +(activeFrom ?? now()))
        throw new TaxError('invalid_registration', 'expires_at must follow active_from');
      const [row] = await db
        .insert(taxRegistrations)
        .values({
          publicId: newId('taxreg'),
          merchantId: merchant.id,
          country: input.country,
          state,
          scheme: input.scheme,
          registrationNumber: input.registration_number ?? null,
          activeFrom,
          expiresAt,
        })
        .returning();
      if (!row) throw new Error('registration insert returned nothing');
      return registrationDto(row);
    },
    /** A pending registration is deleted; an approved one can only be ended. */
    async deleteRegistration(merchant: MerchantRow, publicId: string): Promise<void> {
      const deleted = await db
        .delete(taxRegistrations)
        .where(
          and(
            eq(taxRegistrations.merchantId, merchant.id),
            eq(taxRegistrations.publicId, publicId),
            isNull(taxRegistrations.approvedAt),
          ),
        )
        .returning({ id: taxRegistrations.id });
      if (!deleted.length) {
        const [exists] = await db
          .select({ id: taxRegistrations.id })
          .from(taxRegistrations)
          .where(
            and(
              eq(taxRegistrations.merchantId, merchant.id),
              eq(taxRegistrations.publicId, publicId),
            ),
          );
        throw new TaxError(exists ? 'registration_immutable' : 'not_found');
      }
    },
    /** End a registration at `expiresAt`. The provider mirror is ended too,
     * unless another merchant on the same provider account still relies on it. */
    async endRegistration(
      merchant: MerchantRow,
      publicId: string,
      raw: unknown,
    ): Promise<TaxRegistration> {
      const input = parse(registrationUpdateSchema, raw);
      const expiresAt = fromUnix(input.expires_at);
      const [row] = await db
        .select()
        .from(taxRegistrations)
        .where(
          and(
            eq(taxRegistrations.merchantId, merchant.id),
            eq(taxRegistrations.publicId, publicId),
          ),
        );
      if (!row) throw new TaxError('not_found');
      if (row.expiresAt && +row.expiresAt <= +now()) throw new TaxError('registration_immutable');
      if (+expiresAt < +now() - 60_000 || (row.activeFrom && +expiresAt <= +row.activeFrom))
        throw new TaxError('invalid_registration', 'expires_at cannot be in the past');
      const settings = await settingsRow(merchant);
      const calculating = providerFor(merchant, settings);
      if (row.providerRef && calculating?.endRegistration) {
        const [shared] = await db
          .select({ id: taxRegistrations.id })
          .from(taxRegistrations)
          .where(
            and(
              eq(taxRegistrations.providerRef, row.providerRef),
              ne(taxRegistrations.id, row.id),
              isNotNull(taxRegistrations.approvedAt),
              or(isNull(taxRegistrations.expiresAt), gt(taxRegistrations.expiresAt, expiresAt)),
            ),
          )
          .limit(1);
        if (!shared) {
          try {
            await calculating.endRegistration(row.providerRef, expiresAt);
          } catch (error) {
            throw new TaxError(
              'tax_calculation_unavailable',
              error instanceof TaxProviderUnavailableError ? error.reason : 'provider_failed',
            );
          }
        }
      }
      const [updated] = await db
        .update(taxRegistrations)
        .set({ expiresAt, updatedAt: now() })
        .where(eq(taxRegistrations.id, row.id))
        .returning();
      if (!updated) throw new TaxError('not_found');
      return registrationDto(updated);
    },
    async listProductCodes(merchant: MerchantRow): Promise<TaxProductCode[]> {
      const rows = await db
        .select()
        .from(taxProductCodes)
        .where(eq(taxProductCodes.merchantId, merchant.id))
        .orderBy(asc(taxProductCodes.productRef));
      return rows.map(productCodeDto);
    },
    async setProductCode(
      merchant: MerchantRow,
      ref: string,
      raw: unknown,
    ): Promise<TaxProductCode> {
      const reference = parse(productRef, ref);
      const { tax_code: taxCode } = parse(z.object({ tax_code: z.string() }).strict(), raw);
      if (!isKnownTaxCode(taxCode)) throw new TaxError('invalid_tax_code', taxCode);
      const [row] = await db
        .insert(taxProductCodes)
        .values({ merchantId: merchant.id, productRef: reference, taxCode })
        .onConflictDoUpdate({
          target: [taxProductCodes.merchantId, taxProductCodes.productRef],
          set: { taxCode, updatedAt: now() },
        })
        .returning();
      if (!row) throw new Error('product code upsert returned nothing');
      return productCodeDto(row);
    },
    /**
     * The owner's approval: activates the settings and every pending
     * registration, in one act. For an official Oxy application the platform's
     * provider account calculates; its head office and each registration are
     * mirrored there first, so approval either takes effect everywhere or
     * nowhere.
     */
    async approve(
      merchant: MerchantRow,
      approval: { userId: string; officialApplication: boolean },
    ): Promise<{ settings: TaxSettings; registrations: TaxRegistration[] }> {
      const current = await settingsRow(merchant);
      if (!current?.legalName || !current.headOffice)
        throw new TaxError('approval_incomplete', 'legal name and head office are required');
      const pending = await db
        .select()
        .from(taxRegistrations)
        .where(
          and(eq(taxRegistrations.merchantId, merchant.id), isNull(taxRegistrations.approvedAt)),
        );
      const live = await db
        .select({ id: taxRegistrations.id })
        .from(taxRegistrations)
        .where(
          and(
            eq(taxRegistrations.merchantId, merchant.id),
            isNotNull(taxRegistrations.approvedAt),
            or(isNull(taxRegistrations.expiresAt), gt(taxRegistrations.expiresAt, now())),
          ),
        );
      const account = approval.officialApplication && provider ? 'platform' : 'none';
      const calculating = providerFor(merchant, { ...current, calculationAccount: account });
      if ((pending.length || live.length) && !calculating)
        throw new TaxError('approval_requires_provider');
      const mirrored = new Map<string, string>();
      if (calculating) {
        for (const row of pending)
          if (!stripeRegistrationOptions(row))
            throw new TaxError(
              'invalid_registration',
              `${row.country} ${row.scheme} is not supported`,
            );
        try {
          await calculating.ensureHeadOffice?.(current.headOffice);
          for (const row of pending) {
            if (!calculating.syncRegistration) break;
            const { providerRef } = await calculating.syncRegistration({
              country: row.country,
              state: row.state,
              scheme: row.scheme,
              activeFrom: row.activeFrom ?? now(),
              expiresAt: row.expiresAt,
            });
            mirrored.set(row.id, providerRef);
          }
        } catch (error) {
          throw new TaxError(
            'tax_calculation_unavailable',
            error instanceof TaxProviderUnavailableError ? error.reason : 'provider_failed',
          );
        }
      }
      const at = now();
      await db.transaction(async (tx) => {
        await tx
          .update(taxSettings)
          .set({
            status: 'active',
            approvedAt: at,
            approvedBy: approval.userId,
            calculationAccount: account,
            updatedAt: at,
          })
          .where(
            and(
              eq(taxSettings.merchantId, merchant.id),
              eq(taxSettings.updatedAt, current.updatedAt),
            ),
          );
        const [check] = await tx
          .select()
          .from(taxSettings)
          .where(eq(taxSettings.merchantId, merchant.id));
        // Settings edited while this approval ran: approve what is there, again.
        if (check?.approvedAt?.getTime() !== at.getTime())
          throw new TaxError('approval_incomplete', 'settings changed during approval');
        for (const row of pending)
          await tx
            .update(taxRegistrations)
            .set({
              approvedAt: at,
              approvedBy: approval.userId,
              activeFrom: row.activeFrom ?? at,
              providerRef: mirrored.get(row.id) ?? null,
              updatedAt: at,
            })
            .where(and(eq(taxRegistrations.id, row.id), isNull(taxRegistrations.approvedAt)));
      });
      return {
        settings: await service.getSettings(merchant),
        registrations: await service.listRegistrations(merchant),
      };
    },
    async recordEvidence(merchant: MerchantRow, raw: unknown): Promise<TaxLocationEvidence> {
      const input = parse(createTaxLocationEvidenceSchema, raw);
      const judged = evaluateEvidence(input.evidence, options.ipHashSalt);
      const observedAt = now();
      const [row] = await db
        .insert(taxLocationEvidence)
        .values({
          publicId: newId('taxloc'),
          merchantId: merchant.id,
          customerRef: input.customer_ref,
          status: judged.status,
          rule: judged.rule,
          country: judged.country,
          state: judged.state,
          items: judged.items,
          observedAt,
          expiresAt: new Date(+observedAt + EVIDENCE_LIFETIME_MS),
        })
        .returning();
      if (!row) throw new Error('evidence insert returned nothing');
      return evidenceDto(merchant, row);
    },
    async retrieveEvidence(merchant: MerchantRow, publicId: string): Promise<TaxLocationEvidence> {
      const [row] = await db
        .select()
        .from(taxLocationEvidence)
        .where(
          and(
            eq(taxLocationEvidence.merchantId, merchant.id),
            eq(taxLocationEvidence.publicId, publicId),
          ),
        );
      if (!row) throw new TaxError('not_found');
      return evidenceDto(merchant, row);
    },
    /**
     * Calculate and freeze. `requireActive` is the checkout gate: a merchant
     * whose owner has not approved its tax settings cannot price a sale. The
     * dashboard's preview passes false.
     */
    async calculate(
      merchant: MerchantRow,
      raw: unknown,
      opts: { requireActive: boolean },
    ): Promise<TaxCalculation> {
      const input = parse(createTaxCalculationSchema, raw);
      const currency = input.currency.toUpperCase();
      const settings = await settingsRow(merchant);
      if (opts.requireActive && settings?.status !== 'active')
        throw new TaxError('tax_settings_not_active');
      const [evidence] = await db
        .select()
        .from(taxLocationEvidence)
        .where(
          and(
            eq(taxLocationEvidence.merchantId, merchant.id),
            eq(taxLocationEvidence.publicId, input.customer_location_evidence_id),
          ),
        );
      if (!evidence) throw new TaxError('not_found');
      if (evidence.status === 'insufficient') throw new TaxError('customer_location_insufficient');
      if (evidence.status === 'conflicting') throw new TaxError('customer_location_conflicting');
      const at = now();
      if (+evidence.expiresAt <= +at || !evidence.country)
        throw new TaxError('customer_location_expired');
      const country = evidence.country;
      const products = await db
        .select()
        .from(taxProductCodes)
        .where(
          and(
            eq(taxProductCodes.merchantId, merchant.id),
            inArray(
              taxProductCodes.productRef,
              input.line_items.map((line) => line.reference),
            ),
          ),
        );
      const lines = input.line_items.map((line) => {
        const taxCode =
          line.tax_code ??
          products.find((product) => product.productRef === line.reference)?.taxCode ??
          settings?.defaultTaxCode ??
          'txcd_10000000';
        if (!isKnownTaxCode(taxCode)) throw new TaxError('invalid_tax_code', taxCode);
        return {
          reference: line.reference,
          amount: line.amount,
          quantity: line.quantity ?? 1,
          taxCode,
          taxBehavior: (line.tax_behavior ??
            settings?.defaultTaxBehavior ??
            'exclusive') as TaxBehavior,
        };
      });
      const publicId = newId('taxcalc');
      const taxable = lines.filter((line) => line.taxCode !== NONTAXABLE_TAX_CODE);
      const [registration] = taxable.length
        ? await coveringRegistrations(merchant, country, evidence.state, at)
        : [];
      let collection: TaxCalculation['collection'];
      let providerId: string | null = null;
      let providerRef: string | null = null;
      let providerExpiry: Date | null = null;
      let computed: TaxCalculationLineItem[];
      /** The wire line for an internal one, before its tax is known. */
      const wireLine = (line: (typeof lines)[number]) => ({
        reference: line.reference,
        quantity: line.quantity,
        tax_code: line.taxCode,
        tax_behavior: line.taxBehavior,
        amount: line.amount,
      });
      const untaxed = (line: (typeof lines)[number], reason: string): TaxCalculationLineItem => ({
        ...wireLine(line),
        amount_tax: 0,
        amount_net: line.amount,
        breakdown: [
          {
            country,
            state: evidence.state,
            level: null,
            display_name: null,
            tax_type: null,
            rate_percentage: null,
            taxable_amount: 0,
            amount: 0,
            inclusive: line.taxBehavior === 'inclusive',
            taxability_reason: reason,
          },
        ],
      });
      if (!taxable.length) {
        collection = 'nontaxable';
        computed = lines.map((line) => untaxed(line, 'product_nontaxable'));
      } else if (!registration) {
        // Deterministic: not registered where the customer is, so no tax is
        // collected — and the calculation records exactly that.
        collection = 'not_registered';
        computed = lines.map((line) =>
          untaxed(
            line,
            line.taxCode === NONTAXABLE_TAX_CODE ? 'product_nontaxable' : 'not_registered',
          ),
        );
      } else {
        collection = 'collect';
        const calculating = providerFor(merchant, settings);
        if (!calculating) throw new TaxError('tax_calculation_unavailable', 'no_provider');
        const billing = evidence.items.find(
          (item) => item.type === 'billing_address' && item.country === country,
        );
        let answer: Awaited<ReturnType<TaxProvider['calculate']>>;
        try {
          answer = await calculating.calculate({
            currency,
            customer: {
              country,
              state: evidence.state,
              postal_code: billing?.postalCode ?? null,
              city: billing?.city ?? null,
              line1: billing?.line1 ?? null,
              line2: billing?.line2 ?? null,
            },
            shipFrom: null,
            lineItems: lines,
            idempotencyKey: `peable-tax:${publicId}`,
          });
        } catch (error) {
          if (error instanceof TaxCustomerLocationInvalidError)
            throw new TaxError('customer_location_invalid');
          throw new TaxError(
            'tax_calculation_unavailable',
            error instanceof TaxProviderUnavailableError ? error.reason : 'provider_failed',
          );
        }
        if (answer.livemode !== calculating.livemode)
          throw new TaxError('tax_calculation_unavailable', 'mode_mismatch');
        computed = lines.map((line) => {
          const got = answer.lineItems.find((candidate) => candidate.reference === line.reference);
          if (
            !got ||
            got.amount !== line.amount ||
            got.taxBehavior !== line.taxBehavior ||
            !Number.isSafeInteger(got.amountTax) ||
            got.amountTax < 0 ||
            (line.taxBehavior === 'inclusive' && got.amountTax > line.amount)
          )
            throw new TaxError('tax_calculation_unavailable', 'inconsistent_answer');
          return {
            ...wireLine(line),
            amount_tax: got.amountTax,
            amount_net:
              line.taxBehavior === 'inclusive' ? line.amount - got.amountTax : line.amount,
            breakdown: got.breakdown,
          };
        });
        const reasons = computed
          .filter((line) => line.tax_code !== NONTAXABLE_TAX_CODE)
          .flatMap((line) => line.breakdown.map((entry) => entry.taxability_reason));
        // Registered here per Peable, unregistered per the provider: collecting
        // nothing would under-collect silently, so nothing is quoted.
        if (!reasons.length || reasons.every((reason) => reason === 'not_collecting'))
          throw new TaxError('tax_provider_registration_mismatch', registration.publicId);
        if (reasons.includes('not_supported'))
          throw new TaxError('tax_calculation_unavailable', 'jurisdiction_not_supported');
        providerId = calculating.id;
        providerRef = answer.providerRef;
        providerExpiry = answer.expiresAt;
      }
      const taxAmountExclusive = computed
        .filter((line) => line.tax_behavior === 'exclusive')
        .reduce((sum, line) => sum + line.amount_tax, 0);
      const taxAmountInclusive = computed
        .filter((line) => line.tax_behavior === 'inclusive')
        .reduce((sum, line) => sum + line.amount_tax, 0);
      const amountNet = computed.reduce((sum, line) => sum + line.amount_net, 0);
      const amountTotal = computed.reduce((sum, line) => sum + line.amount, 0) + taxAmountExclusive;
      if (![amountNet, amountTotal].every(Number.isSafeInteger))
        throw new TaxError('invalid_tax_request', 'amount overflow');
      const expiresAt = new Date(
        Math.min(
          +evidence.expiresAt,
          +at + MAX_CALCULATION_LIFETIME_MS,
          providerExpiry ? +providerExpiry : Number.POSITIVE_INFINITY,
        ),
      );
      const result: TaxCalculation = {
        object: 'tax.calculation',
        id: publicId,
        currency,
        collection,
        registration_id: registration?.publicId ?? null,
        provider: providerId,
        provider_calculation_ref: providerRef,
        customer_location_evidence_id: evidence.publicId,
        country,
        state: evidence.state,
        amount_total: amountTotal,
        amount_net: amountNet,
        tax_amount_exclusive: taxAmountExclusive,
        tax_amount_inclusive: taxAmountInclusive,
        line_items: computed,
        tax_date: toUnix(at),
        created: toUnix(at),
        expires_at: toUnix(expiresAt),
        livemode: merchant.livemode,
      };
      await db.insert(taxCalculations).values({
        publicId,
        merchantId: merchant.id,
        evidenceId: evidence.id,
        registrationId: collection === 'collect' ? (registration?.id ?? null) : null,
        collection,
        currency,
        country,
        state: evidence.state,
        provider: providerId,
        providerRef,
        result,
        expiresAt,
      });
      return result;
    },
    async retrieveCalculation(merchant: MerchantRow, publicId: string): Promise<TaxCalculation> {
      const [row] = await db
        .select()
        .from(taxCalculations)
        .where(
          and(eq(taxCalculations.merchantId, merchant.id), eq(taxCalculations.publicId, publicId)),
        );
      if (!row) throw new TaxError('not_found');
      return row.result;
    },
    /** A `taxtxn_…` cursor's primary key, inside the merchant's scope; `null` when it names nothing there. */
    async findTransactionKey(merchant: MerchantRow, publicId: string): Promise<string | null> {
      const [row] = await db
        .select({ id: taxTransactions.id })
        .from(taxTransactions)
        .where(
          and(eq(taxTransactions.merchantId, merchant.id), eq(taxTransactions.publicId, publicId)),
        );
      return row?.id ?? null;
    },
    /**
     * One page of `GET /v1/tax/transactions`, newest first like every list
     * (`db/keyset.ts`). `created[...]` filters `committed_at` — the tax date a
     * filing period is judged by, which is what a caller narrowing by date
     * means here.
     */
    async listTransactions(
      merchant: MerchantRow,
      page: KeysetPage,
    ): Promise<{ data: TaxTransaction[]; hasMore: boolean }> {
      const walk = keyset(taxTransactions.id, taxTransactions.committedAt, page);
      const original = alias(taxTransactions, 'original');
      const rows = await db
        .select({
          transaction: taxTransactions,
          calculation: taxCalculations,
          originalPublicId: original.publicId,
        })
        .from(taxTransactions)
        .innerJoin(taxCalculations, eq(taxCalculations.id, taxTransactions.calculationId))
        .leftJoin(original, eq(original.id, taxTransactions.reversalOfId))
        .where(and(eq(taxTransactions.merchantId, merchant.id), walk.where))
        .orderBy(walk.orderBy)
        .limit(walk.limit);
      return walk.finish(rows.map(transactionDto));
    },
    /**
     * Record a refund the rail cannot report itself: a FairCoin payment is
     * refunded from the seller's own wallet, so the merchant says so here.
     * `amount` is the gross refunded; omitted, whatever is not yet reversed.
     * A repeated `reference` answers the reversal it already made. Card
     * refunds and credit notes are observed from the provider and never
     * entered by hand, so the two cannot double-count one refund.
     */
    async createReversal(
      merchant: MerchantRow,
      originalPublicId: string,
      raw: unknown,
    ): Promise<TaxTransaction> {
      const input = parse(createReversalSchema, raw);
      const [original] = await db
        .select()
        .from(taxTransactions)
        .where(
          and(
            eq(taxTransactions.merchantId, merchant.id),
            eq(taxTransactions.publicId, originalPublicId),
            isNull(taxTransactions.reversalOfId),
          ),
        );
      if (!original) throw new TaxError('not_found');
      if (original.rail === 'stripe')
        throw new TaxError(
          'invalid_tax_request',
          'card refunds and credit notes are reversed from the provider',
        );
      const row = await reverseTaxTransaction(db, {
        originalId: original.id,
        reference: input.reference,
        reversedAt: now(),
        target: (reversed, total) => (input.amount === undefined ? total : reversed + input.amount),
      });
      if (!row) throw new TaxError('invalid_tax_request', 'nothing left to reverse');
      return row;
    },
    /** Totals per jurisdiction, registration, tax type and rate — the lines a
     * return (an OSS return, a state filing) is prepared from. */
    async report(merchant: MerchantRow, raw: unknown): Promise<TaxReport> {
      const input = parse(taxReportQuerySchema, raw);
      const schemes = new Map(
        (
          await db
            .select({ publicId: taxRegistrations.publicId, scheme: taxRegistrations.scheme })
            .from(taxRegistrations)
            .where(eq(taxRegistrations.merchantId, merchant.id))
        ).map((row) => [row.publicId, row.scheme]),
      );
      const rows = new Map<string, TaxReportRow>();
      let cursor: string | undefined;
      for (;;) {
        const page = await transactionsBetween(
          db,
          merchant.id,
          { ...input, starting_after: cursor },
          1000,
        );
        for (const row of page) {
          const calculation = row.calculation.result;
          // A reversal nets into its original's rows with its own signed lines.
          const reversal = row.transaction.reversal;
          const lineItems = reversal ? reversal.line_items : calculation.line_items;
          for (const line of lineItems)
            for (const entry of line.breakdown) {
              const key = JSON.stringify([
                entry.country,
                entry.state,
                calculation.registration_id,
                calculation.collection,
                entry.tax_type,
                entry.rate_percentage,
                calculation.currency,
              ]);
              const existing = rows.get(key) ?? {
                country: entry.country,
                state: entry.state,
                registration_id: calculation.registration_id,
                scheme: calculation.registration_id
                  ? (schemes.get(calculation.registration_id) ?? null)
                  : null,
                collection: calculation.collection,
                tax_type: entry.tax_type,
                rate_percentage: entry.rate_percentage,
                currency: calculation.currency,
                transactions: 0,
                reversals: 0,
                taxable_amount: 0,
                tax_amount: 0,
              };
              existing.taxable_amount += entry.taxable_amount;
              existing.tax_amount += entry.amount;
              rows.set(key, existing);
            }
          // Count each transaction once per row it contributes to.
          const keys = new Set(
            lineItems.flatMap((line) =>
              line.breakdown.map((entry) =>
                JSON.stringify([
                  entry.country,
                  entry.state,
                  calculation.registration_id,
                  calculation.collection,
                  entry.tax_type,
                  entry.rate_percentage,
                  calculation.currency,
                ]),
              ),
            ),
          );
          for (const key of keys) {
            const existing = rows.get(key);
            if (existing && reversal) existing.reversals += 1;
            else if (existing) existing.transactions += 1;
          }
        }
        if (page.length < 1000) break;
        cursor = page.at(-1)?.transaction.publicId;
      }
      return {
        object: 'tax.report',
        from: input.from,
        to: input.to,
        rows: [...rows.values()].sort(
          (a, b) =>
            a.country.localeCompare(b.country) ||
            (a.state ?? '').localeCompare(b.state ?? '') ||
            (a.rate_percentage ?? '').localeCompare(b.rate_percentage ?? ''),
        ),
      };
    },
  };
  return service;
}
export type TaxService = ReturnType<typeof createTaxService>;

async function transactionsBetween(
  db: Database,
  merchantId: string,
  input: { from: number; to: number; starting_after?: string },
  limit: number,
) {
  let after: Date | undefined;
  let afterId: string | undefined;
  if (input.starting_after) {
    const [anchor] = await db
      .select({ committedAt: taxTransactions.committedAt, id: taxTransactions.id })
      .from(taxTransactions)
      .where(
        and(
          eq(taxTransactions.merchantId, merchantId),
          eq(taxTransactions.publicId, input.starting_after),
        ),
      );
    if (!anchor) throw new TaxError('not_found');
    after = anchor.committedAt;
    afterId = anchor.id;
  }
  const original = alias(taxTransactions, 'original');
  return db
    .select({
      transaction: taxTransactions,
      calculation: taxCalculations,
      originalPublicId: original.publicId,
    })
    .from(taxTransactions)
    .innerJoin(taxCalculations, eq(taxCalculations.id, taxTransactions.calculationId))
    .leftJoin(original, eq(original.id, taxTransactions.reversalOfId))
    .where(
      and(
        eq(taxTransactions.merchantId, merchantId),
        gte(taxTransactions.committedAt, fromUnix(input.from)),
        lt(taxTransactions.committedAt, fromUnix(input.to)),
        after && afterId
          ? or(
              gt(taxTransactions.committedAt, after),
              and(eq(taxTransactions.committedAt, after), gt(taxTransactions.id, afterId)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(taxTransactions.committedAt), asc(taxTransactions.id))
    .limit(limit);
}

function productCodeDto(row: typeof taxProductCodes.$inferSelect): TaxProductCode {
  return {
    object: 'tax.product',
    product_ref: row.productRef,
    tax_code: row.taxCode,
    updated_at: toUnix(row.updatedAt),
  };
}

function transactionDto(row: {
  transaction: typeof taxTransactions.$inferSelect;
  calculation: CalculationRow;
  originalPublicId?: string | null;
}): TaxTransaction {
  return {
    object: 'tax.transaction',
    id: row.transaction.publicId,
    type: row.transaction.reversal ? 'reversal' : 'transaction',
    calculation_id: row.calculation.publicId,
    reference: row.transaction.reference,
    rail: row.transaction.rail,
    committed_at: toUnix(row.transaction.committedAt),
    reversal_of: row.originalPublicId ?? null,
    reversal: row.transaction.reversal ?? null,
    calculation: row.calculation.result,
  };
}

/**
 * Record that a calculation priced an accepted payment — on the caller's
 * transaction, so the payment's acceptance and its tax record commit
 * together. Idempotent: a calculation or a rail reference commits once.
 */
export async function commitTaxTransaction(
  tx: DatabaseOrTransaction,
  input: {
    calculationPublicId: string;
    reference: string;
    rail: string;
    committedAt: Date;
    /** The rail's payment object (a card `pi_…`), so a refund finds the sale. */
    providerPaymentRef?: string;
  },
): Promise<void> {
  const [calculation] = await tx
    .select({ id: taxCalculations.id, merchantId: taxCalculations.merchantId })
    .from(taxCalculations)
    .where(eq(taxCalculations.publicId, input.calculationPublicId));
  // A quote that predates Peable Tax names no calculation: nothing to commit.
  if (!calculation) return;
  await tx
    .insert(taxTransactions)
    .values({
      publicId: newId('taxtxn'),
      merchantId: calculation.merchantId,
      calculationId: calculation.id,
      reference: input.reference,
      rail: input.rail,
      committedAt: input.committedAt,
      providerPaymentRef: input.providerPaymentRef ?? null,
    })
    .onConflictDoNothing();
}

/** Round `value × numerator / denominator` half up, for non-negative integers. */
function scaled(value: number, numerator: number, denominator: number): number {
  const sign = value < 0 ? -1n : 1n;
  const magnitude = BigInt(Math.abs(value)) * BigInt(numerator);
  const d = BigInt(denominator);
  return Number(sign * ((2n * magnitude + d) / (2n * d)));
}

/** What a cumulative reversal of `reversed` out of `total` gives back, line by
 * line. Always cumulative, so the parts of several partial reversals add up to
 * exactly the original once everything is reversed. */
function cumulativeLines(calculation: TaxCalculation, reversed: number) {
  const total = calculation.amount_total;
  return calculation.line_items.map((line) => {
    const breakdown = line.breakdown.map((entry) => ({
      ...entry,
      taxable_amount: scaled(entry.taxable_amount, reversed, total),
      amount: scaled(entry.amount, reversed, total),
    }));
    const amountTax = breakdown.reduce((sum, entry) => sum + entry.amount, 0);
    const gross = scaled(
      line.amount + (line.tax_behavior === 'exclusive' ? line.amount_tax : 0),
      reversed,
      total,
    );
    return { line, breakdown, amountTax, gross };
  });
}

/**
 * Reverse (part of) a committed transaction. `target` names the CUMULATIVE
 * gross that should stand reversed once this call is done, given what is
 * reversed already and the original's total; the row written is the
 * difference, so an observer that re-reads the provider's cumulative refunds
 * converges no matter how often it runs, and a target below what is reversed
 * reinstates the difference (a refund that failed after it succeeded).
 *
 * Serialized on the original row. Answers the reversal made under `reference`
 * if there already is one, and null when there is nothing to write.
 */
export async function reverseTaxTransaction(
  db: Database,
  input: {
    originalId: string;
    /** The reversal's own reference, or one minted from its sequence number. */
    reference: string | ((sequence: number) => string);
    reversedAt: Date;
    target: (reversed: number, total: number) => number;
  },
): Promise<TaxTransaction | null> {
  return db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(taxTransactions)
      .where(and(eq(taxTransactions.id, input.originalId), isNull(taxTransactions.reversalOfId)))
      .for('update');
    if (!original) throw new TaxError('not_found');
    const [calculation] = await tx
      .select()
      .from(taxCalculations)
      .where(eq(taxCalculations.id, original.calculationId));
    if (!calculation) throw new TaxError('not_found');
    const existing = await tx
      .select()
      .from(taxTransactions)
      .where(eq(taxTransactions.reversalOfId, original.id));
    const reference =
      typeof input.reference === 'string' ? input.reference : input.reference(existing.length + 1);
    const same = existing.find((row) => row.reference === reference);
    if (same)
      return transactionDto({
        transaction: same,
        calculation,
        originalPublicId: original.publicId,
      });
    const total = calculation.result.amount_total;
    const reversed = -existing.reduce((sum, row) => sum + (row.reversal?.amount_total ?? 0), 0);
    const target = input.target(reversed, total);
    if (!Number.isSafeInteger(target) || target < 0 || target > total)
      throw new TaxError('invalid_tax_request', 'a reversal cannot exceed the original');
    if (target === reversed || total === 0) return null;
    const before = cumulativeLines(calculation.result, reversed);
    const after = cumulativeLines(calculation.result, target);
    // Negative: what this reversal gives back (positive when it reinstates).
    const lineItems: TaxCalculationLineItem[] = after.map((now, index) => {
      const was = before[index];
      if (!was) throw new Error('reversal lines diverged');
      const amountTax = was.amountTax - now.amountTax;
      const gross = was.gross - now.gross;
      return {
        ...now.line,
        amount: gross - (now.line.tax_behavior === 'exclusive' ? amountTax : 0),
        amount_tax: amountTax,
        amount_net: gross - amountTax,
        breakdown: now.breakdown.map((entry, at) => {
          const prior = was.breakdown[at];
          if (!prior) throw new Error('reversal breakdown diverged');
          return {
            ...entry,
            taxable_amount: prior.taxable_amount - entry.taxable_amount,
            amount: prior.amount - entry.amount,
          };
        }),
      };
    });
    const taxAmount = lineItems.reduce((sum, line) => sum + line.amount_tax, 0);
    const amountNet = lineItems.reduce((sum, line) => sum + line.amount_net, 0);
    const reversal: TaxTransactionReversal = {
      amount_total: amountNet + taxAmount,
      amount_net: amountNet,
      tax_amount: taxAmount,
      line_items: lineItems,
    };
    const [row] = await tx
      .insert(taxTransactions)
      .values({
        publicId: newId('taxtxn'),
        merchantId: original.merchantId,
        calculationId: original.calculationId,
        reference,
        rail: original.rail,
        committedAt: input.reversedAt,
        reversalOfId: original.id,
        reversal,
      })
      .returning();
    if (!row) throw new Error('reversal insert returned nothing');
    return transactionDto({ transaction: row, calculation, originalPublicId: original.publicId });
  });
}
