import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
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
  type TaxTransactionList,
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
import { newId } from '../../lib/ids';
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

const STATUS: Record<TaxErrorCode, number> = {
  not_found: 404,
  invalid_tax_request: 422,
  invalid_tax_code: 422,
  invalid_registration: 422,
  registration_immutable: 409,
  tax_settings_not_active: 409,
  approval_incomplete: 422,
  approval_requires_provider: 409,
  customer_location_insufficient: 422,
  customer_location_conflicting: 422,
  customer_location_invalid: 422,
  customer_location_expired: 409,
  tax_calculation_unavailable: 503,
  tax_provider_registration_mismatch: 503,
};

export class TaxError extends Error {
  readonly status: number;
  constructor(
    readonly code: TaxErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
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
    legalName: z.string().trim().min(1).max(200).nullable().optional(),
    headOffice: taxAddressSchema.nullable().optional(),
    defaultTaxCode: z.string().optional(),
    defaultTaxBehavior: z.enum(['inclusive', 'exclusive']).optional(),
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
    registrationNumber: z.string().trim().min(1).max(64).nullish(),
    activeFrom: z.string().datetime().optional(),
    expiresAt: z.string().datetime().nullish(),
  })
  .strict();
const registrationUpdateSchema = z.object({ expiresAt: z.string().datetime() }).strict();
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
        taxCode: z.string().optional(),
        taxBehavior: z.enum(['inclusive', 'exclusive']).optional(),
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
    customerLocationEvidenceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    lineItems: lineItemsSchema,
  })
  .strict();
export const listTaxTransactionsSchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    limit: z.coerce.number().int().positive().max(1000).optional(),
    startingAfter: z.string().optional(),
  })
  .strict();

type SettingsRow = typeof taxSettings.$inferSelect;
type RegistrationRow = typeof taxRegistrations.$inferSelect;
type EvidenceRow = typeof taxLocationEvidence.$inferSelect;
type CalculationRow = typeof taxCalculations.$inferSelect;

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

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
      merchantId: merchant.publicId,
      status: row?.status ?? 'draft',
      legalName: row?.legalName ?? null,
      headOffice: row?.headOffice ?? null,
      defaultTaxCode: row?.defaultTaxCode ?? 'txcd_10000000',
      defaultTaxBehavior: row?.defaultTaxBehavior ?? 'exclusive',
      calculationAccount: row?.calculationAccount ?? 'none',
      provider: providerFor(merchant, row)?.id ?? null,
      approvedAt: iso(row?.approvedAt),
      approvedBy: row?.approvedBy ?? null,
      updatedAt: iso(row?.updatedAt),
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
      registrationNumber: row.registrationNumber,
      activeFrom: (row.activeFrom ?? row.createdAt).toISOString(),
      expiresAt: iso(row.expiresAt),
      status,
      approvedAt: iso(row.approvedAt),
      providerRegistrationRef: row.providerRef,
      createdAt: row.createdAt.toISOString(),
    };
  }
  function evidenceDto(merchant: MerchantRow, row: EvidenceRow): TaxLocationEvidence {
    return {
      object: 'tax.location_evidence',
      id: row.publicId,
      customerRef: row.customerRef,
      status: row.status,
      rule: row.rule,
      country: row.country,
      state: row.state,
      items: row.items.map((item) => ({
        type: item.type as TaxLocationEvidence['items'][number]['type'],
        country: item.country,
        state: item.state,
      })),
      observedAt: row.observedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      livemode: merchant.livemode,
    };
  }
  function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
    const result = schema.safeParse(raw);
    if (!result.success)
      throw new TaxError('invalid_tax_request', result.error.issues[0]?.message ?? 'invalid');
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
      if (input.defaultTaxCode !== undefined && !isKnownTaxCode(input.defaultTaxCode))
        throw new TaxError('invalid_tax_code', input.defaultTaxCode);
      const values = {
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        ...(input.headOffice !== undefined
          ? { headOffice: input.headOffice as TaxAddress | null }
          : {}),
        ...(input.defaultTaxCode !== undefined ? { defaultTaxCode: input.defaultTaxCode } : {}),
        ...(input.defaultTaxBehavior !== undefined
          ? { defaultTaxBehavior: input.defaultTaxBehavior }
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
      const activeFrom = input.activeFrom ? new Date(input.activeFrom) : null;
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (expiresAt && +expiresAt <= +(activeFrom ?? now()))
        throw new TaxError('invalid_registration', 'expiresAt must follow activeFrom');
      const [row] = await db
        .insert(taxRegistrations)
        .values({
          publicId: newId('taxreg'),
          merchantId: merchant.id,
          country: input.country,
          state,
          scheme: input.scheme,
          registrationNumber: input.registrationNumber ?? null,
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
      const expiresAt = new Date(input.expiresAt);
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
        throw new TaxError('invalid_registration', 'expiresAt cannot be in the past');
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
      return rows.map((row) => ({
        object: 'tax.product',
        productRef: row.productRef,
        taxCode: row.taxCode,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
    async setProductCode(
      merchant: MerchantRow,
      ref: string,
      raw: unknown,
    ): Promise<TaxProductCode> {
      const reference = parse(productRef, ref);
      const { taxCode } = parse(z.object({ taxCode: z.string() }).strict(), raw);
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
      return {
        object: 'tax.product',
        productRef: row.productRef,
        taxCode: row.taxCode,
        updatedAt: row.updatedAt.toISOString(),
      };
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
        throw new TaxError(
          'approval_requires_provider',
          'registered sales need a tax provider; this application has none',
        );
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
          customerRef: input.customerRef,
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
            eq(taxLocationEvidence.publicId, input.customerLocationEvidenceId),
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
              input.lineItems.map((line) => line.reference),
            ),
          ),
        );
      const lines = input.lineItems.map((line) => {
        const taxCode =
          line.taxCode ??
          products.find((product) => product.productRef === line.reference)?.taxCode ??
          settings?.defaultTaxCode ??
          'txcd_10000000';
        if (!isKnownTaxCode(taxCode)) throw new TaxError('invalid_tax_code', taxCode);
        return {
          reference: line.reference,
          amount: line.amount,
          quantity: line.quantity ?? 1,
          taxCode,
          taxBehavior: (line.taxBehavior ??
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
      const untaxed = (line: (typeof lines)[number], reason: string): TaxCalculationLineItem => ({
        ...line,
        amountTax: 0,
        amountNet: line.amount,
        breakdown: [
          {
            country,
            state: evidence.state,
            level: null,
            displayName: null,
            taxType: null,
            ratePercentage: null,
            taxableAmount: 0,
            amount: 0,
            inclusive: line.taxBehavior === 'inclusive',
            taxabilityReason: reason,
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
              postalCode: billing?.postalCode ?? null,
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
            ...line,
            amountTax: got.amountTax,
            amountNet: line.taxBehavior === 'inclusive' ? line.amount - got.amountTax : line.amount,
            breakdown: got.breakdown,
          };
        });
        const reasons = computed
          .filter((line) => line.taxCode !== NONTAXABLE_TAX_CODE)
          .flatMap((line) => line.breakdown.map((entry) => entry.taxabilityReason));
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
        .filter((line) => line.taxBehavior === 'exclusive')
        .reduce((sum, line) => sum + line.amountTax, 0);
      const taxAmountInclusive = computed
        .filter((line) => line.taxBehavior === 'inclusive')
        .reduce((sum, line) => sum + line.amountTax, 0);
      const amountNet = computed.reduce((sum, line) => sum + line.amountNet, 0);
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
        registrationId: registration?.publicId ?? null,
        provider: providerId,
        providerCalculationRef: providerRef,
        customerLocationEvidenceId: evidence.publicId,
        country,
        state: evidence.state,
        amountTotal,
        amountNet,
        taxAmountExclusive,
        taxAmountInclusive,
        lineItems: computed,
        taxDate: at.toISOString(),
        createdAt: at.toISOString(),
        expiresAt: expiresAt.toISOString(),
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
    async listTransactions(merchant: MerchantRow, raw: unknown): Promise<TaxTransactionList> {
      const input = parse(listTaxTransactionsSchema, raw);
      const limit = input.limit ?? 100;
      const rows = await transactionsBetween(db, merchant.id, input, limit + 1);
      return {
        object: 'list',
        data: rows.slice(0, limit).map(transactionDto),
        hasMore: rows.length > limit,
      };
    },
    /** Totals per jurisdiction, registration, tax type and rate — the lines a
     * return (an OSS return, a state filing) is prepared from. */
    async report(merchant: MerchantRow, raw: unknown): Promise<TaxReport> {
      const input = parse(
        listTaxTransactionsSchema.omit({ limit: true, startingAfter: true }),
        raw,
      );
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
          { ...input, startingAfter: cursor },
          1000,
        );
        for (const row of page) {
          const calculation = row.calculation.result;
          for (const line of calculation.lineItems)
            for (const entry of line.breakdown) {
              const key = JSON.stringify([
                entry.country,
                entry.state,
                calculation.registrationId,
                calculation.collection,
                entry.taxType,
                entry.ratePercentage,
                calculation.currency,
              ]);
              const existing = rows.get(key) ?? {
                country: entry.country,
                state: entry.state,
                registrationId: calculation.registrationId,
                scheme: calculation.registrationId
                  ? (schemes.get(calculation.registrationId) ?? null)
                  : null,
                collection: calculation.collection,
                taxType: entry.taxType,
                ratePercentage: entry.ratePercentage,
                currency: calculation.currency,
                transactions: 0,
                taxableAmount: 0,
                taxAmount: 0,
              };
              existing.taxableAmount += entry.taxableAmount;
              existing.taxAmount += entry.amount;
              rows.set(key, existing);
            }
          // Count each transaction once per row it contributes to.
          const keys = new Set(
            calculation.lineItems.flatMap((line) =>
              line.breakdown.map((entry) =>
                JSON.stringify([
                  entry.country,
                  entry.state,
                  calculation.registrationId,
                  calculation.collection,
                  entry.taxType,
                  entry.ratePercentage,
                  calculation.currency,
                ]),
              ),
            ),
          );
          for (const key of keys) {
            const existing = rows.get(key);
            if (existing) existing.transactions += 1;
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
            (a.ratePercentage ?? '').localeCompare(b.ratePercentage ?? ''),
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
  input: { from: string; to: string; startingAfter?: string },
  limit: number,
) {
  let after: Date | undefined;
  let afterId: string | undefined;
  if (input.startingAfter) {
    const [anchor] = await db
      .select({ committedAt: taxTransactions.committedAt, id: taxTransactions.id })
      .from(taxTransactions)
      .where(
        and(
          eq(taxTransactions.merchantId, merchantId),
          eq(taxTransactions.publicId, input.startingAfter),
        ),
      );
    if (!anchor) throw new TaxError('not_found');
    after = anchor.committedAt;
    afterId = anchor.id;
  }
  return db
    .select({ transaction: taxTransactions, calculation: taxCalculations })
    .from(taxTransactions)
    .innerJoin(taxCalculations, eq(taxCalculations.id, taxTransactions.calculationId))
    .where(
      and(
        eq(taxTransactions.merchantId, merchantId),
        gte(taxTransactions.committedAt, new Date(input.from)),
        lt(taxTransactions.committedAt, new Date(input.to)),
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

function transactionDto(row: {
  transaction: typeof taxTransactions.$inferSelect;
  calculation: CalculationRow;
}): TaxTransaction {
  return {
    object: 'tax.transaction',
    id: row.transaction.publicId,
    calculationId: row.calculation.publicId,
    reference: row.transaction.reference,
    rail: row.transaction.rail,
    committedAt: row.transaction.committedAt.toISOString(),
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
  input: { calculationPublicId: string; reference: string; rail: string; committedAt: Date },
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
    })
    .onConflictDoNothing();
}
