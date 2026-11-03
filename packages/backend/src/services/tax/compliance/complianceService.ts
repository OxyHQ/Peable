/**
 * Peable Tax business compliance (ADR 0020): onboarding facts, the versioned
 * assessment, the review queue, the document checklist, deadlines and the
 * action history.
 *
 * What it can never do is the point of it. It writes no `tax_settings` and no
 * `tax_registrations`, calls no tax provider and no authority, and nothing it
 * stores is read by the calculator — so no answer here, from an owner, a
 * service credential or an assistant, can make Peable collect tax. Collection
 * stays the owner's registration plus approval (ADR 0011).
 *
 * Every change writes its action-history row (and, for assessments and review
 * items, its event) in the change's own transaction.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  createTaxAssessmentParams,
  createTaxDocumentParams,
  createTaxOperatingLocationParams,
  createTaxRegistrationDeclarationParams,
  createTaxSalesDestinationParams,
  resolveTaxReviewItemParams,
  type TaxAssessment,
  type TaxAssessmentReplay,
  type TaxAssessmentResult,
  type TaxBusinessProfile,
  type TaxComplianceAction,
  type TaxComplianceCapabilities,
  type TaxDeadline,
  type TaxDeadlineUnavailable,
  type TaxDocument,
  type TaxDocumentChecklist,
  type TaxDocumentChecklistItem,
  type TaxOperatingLocation,
  type TaxRegistrationDeclaration,
  type TaxReviewItem,
  type TaxRuleSet,
  type TaxSalesDestination,
  updateTaxBusinessProfileParams,
  updateTaxOperatingLocationParams,
  updateTaxRegistrationDeclarationParams,
  updateTaxSalesDestinationParams,
} from '@peable.to/contracts';
import type { Database, DatabaseOrTransaction } from '../../../db/postgres';
import type { KeysetPage } from '../../../db/keyset';
import type { MerchantRow } from '../../../db/merchants/merchantRepository';
import { type FileRow, findFileByPublicId, fileStatusOf } from '../../../db/files/fileRepository';
import {
  allDeclarations,
  allDocuments,
  allOperatingLocations,
  allSalesDestinations,
  approvedCollectionRegistrations,
  type AssessmentRow,
  type BusinessProfileRow,
  type DeclarationRow,
  decideReviewItem,
  type DocumentRow,
  cursorId,
  findAssessment,
  findBusinessProfile,
  findCollectionRegistration,
  findDeclaration,
  findDocument,
  findDocumentByFile,
  findLegalName,
  findOperatingLocation,
  findReviewItem,
  findSalesDestination,
  insertAction,
  insertAssessment,
  insertDeclaration,
  insertDocument,
  insertOperatingLocation,
  insertSalesDestination,
  latestAssessment,
  listActions,
  listAssessments,
  listDeclarations,
  listDocuments,
  listOperatingLocations,
  listReviewItems,
  listSalesDestinations,
  monthlySales,
  setAssessmentResults,
  type OperatingLocationRow,
  type ReviewItemRow,
  type SalesDestinationRow,
  updateDeclaration,
  updateOperatingLocation,
  updateSalesDestination,
  upsertBusinessProfile,
  upsertOpenReviewItem,
} from '../../../db/taxCompliance/taxComplianceRepository';
import { newId } from '../../../lib/ids';
import { paramFromPath } from '../../../lib/http';
import { fromUnix, toUnix, toUnixOrNull } from '../../../lib/time';
import {
  taxComplianceActions,
  taxComplianceAssessments,
  taxComplianceDocuments,
  taxOperatingLocations,
  taxRegistrationDeclarations,
  taxReviewItems,
  taxSalesDestinations,
} from '../../../db/schema/taxCompliance';
import { recordEvent } from '../../events';
import { validateRegistration } from '../jurisdictions';
import {
  type AssessmentInputs,
  evaluate,
  monthIndex,
  monthStart,
  salesWindowStart,
  summarize,
} from './evaluate';
import {
  CURRENT_RULE_SET_VERSION,
  currentRuleSet,
  EU_VAT_RULE,
  ruleFor,
  ruleSetByVersion,
  ruleSetDto,
  SOURCES,
  US_TX_RULE,
} from './ruleSet';

// ── Errors ───────────────────────────────────────────────────────────────────

export type TaxComplianceErrorCode =
  | 'not_found'
  | 'invalid_tax_request'
  | 'invalid_tax_document'
  | 'invalid_registration_declaration'
  | 'review_item_not_open'
  | 'rule_set_version_unavailable';

const STATUS: Record<TaxComplianceErrorCode, number> = {
  not_found: 404,
  invalid_tax_request: 400,
  invalid_tax_document: 400,
  invalid_registration_declaration: 400,
  review_item_not_open: 409,
  rule_set_version_unavailable: 409,
};

export class TaxComplianceError extends Error {
  readonly status: number;
  constructor(
    readonly code: TaxComplianceErrorCode,
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = 'TaxComplianceError';
    this.status = STATUS[code];
  }
}

const notFound = (what: string) => new TaxComplianceError('not_found', `No such ${what}`);

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const keys = issue && 'keys' in issue ? (issue.keys as string[]) : undefined;
    throw new TaxComplianceError(
      'invalid_tax_request',
      issue?.message ?? 'invalid request',
      issue ? paramFromPath(keys?.[0] ? [...issue.path, keys[0]] : issue.path) : undefined,
    );
  }
  return result.data;
}

// ── Actors and history ───────────────────────────────────────────────────────

/** Who acts: the signed-in owner on the dashboard, or a service credential. */
export interface TaxComplianceActor {
  readonly type: 'user' | 'service';
  readonly id: string | null;
}

async function record(
  tx: DatabaseOrTransaction,
  merchant: MerchantRow,
  actor: TaxComplianceActor,
  action: string,
  objectType: string,
  objectId: string | null,
  details: Record<string, string | number | boolean | null> = {},
) {
  await insertAction(tx, {
    publicId: newId('taxact'),
    merchantId: merchant.id,
    action,
    actorType: actor.type,
    actorId: actor.id,
    objectType,
    objectId,
    details,
  });
}

/** The fields an update named — the history records THAT they changed, not to what. */
function changedFields(input: Record<string, unknown>): Record<string, boolean> {
  return Object.fromEntries(
    Object.keys(input)
      .filter((key) => input[key] !== undefined)
      .map((key) => [`changed_${key}`, true]),
  );
}

const date = (value: number | null | undefined) =>
  value === undefined ? undefined : value === null ? null : fromUnix(value);

// ── DTOs ─────────────────────────────────────────────────────────────────────

function locationDto(merchant: MerchantRow, row: OperatingLocationRow): TaxOperatingLocation {
  return {
    object: 'tax.operating_location',
    id: row.publicId,
    livemode: merchant.livemode,
    kind: row.kind,
    country: row.country,
    state: row.state,
    description: row.description,
    started: toUnixOrNull(row.startedAt),
    ended: toUnixOrNull(row.endedAt),
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

function destinationDto(merchant: MerchantRow, row: SalesDestinationRow): TaxSalesDestination {
  return {
    object: 'tax.sales_destination',
    id: row.publicId,
    livemode: merchant.livemode,
    country: row.country,
    state: row.state,
    customer_types: row.customerTypes,
    started: toUnixOrNull(row.startedAt),
    ended: toUnixOrNull(row.endedAt),
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

function declarationDto(merchant: MerchantRow, row: DeclarationRow): TaxRegistrationDeclaration {
  return {
    object: 'tax.registration_declaration',
    id: row.publicId,
    livemode: merchant.livemode,
    country: row.country,
    state: row.state,
    scheme: row.scheme,
    status: row.status,
    effective_from: toUnixOrNull(row.effectiveFrom),
    effective_to: toUnixOrNull(row.effectiveTo),
    filing_frequency: row.filingFrequency,
    collection_registration: row.collectionRegistrationPublicId,
    verification: { status: 'unverified', reason: 'no_authority_integration' },
    note: row.note,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
    updated: toUnix(row.updatedAt),
  };
}

function documentDto(merchant: MerchantRow, row: DocumentRow): TaxDocument {
  return {
    object: 'tax.document',
    id: row.publicId,
    livemode: merchant.livemode,
    file: row.filePublicId,
    file_status: fileStatusOf({
      withheld: row.fileWithheld as FileRow['withheld'],
      removedAt: row.fileRemovedAt,
    }),
    filename: row.filename,
    kind: row.kind,
    country: row.country,
    state: row.state,
    registration_declaration: row.declarationPublicId,
    description: row.description,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

function assessmentDto(merchant: MerchantRow, row: AssessmentRow): TaxAssessment {
  return {
    object: 'tax.assessment',
    id: row.publicId,
    livemode: merchant.livemode,
    rule_set_version: row.ruleSetVersion,
    as_of: toUnix(row.asOf),
    inputs_digest: row.inputsDigest,
    results: row.results,
    summary: row.summary,
    created_by: { type: row.actorType === 'user' ? 'user' : 'service', id: row.actorId },
    created: toUnix(row.createdAt),
  };
}

function reviewItemDto(merchant: MerchantRow, row: ReviewItemRow): TaxReviewItem {
  return {
    object: 'tax.review_item',
    id: row.publicId,
    livemode: merchant.livemode,
    code: row.code,
    severity: row.severity,
    status: row.status,
    rule: row.rule,
    country: row.country,
    state: row.state,
    message: row.message,
    first_assessment: row.firstAssessmentPublicId,
    latest_assessment: row.latestAssessmentPublicId,
    decision:
      row.decision && row.decidedBy && row.decidedAt
        ? {
            decision: row.decision,
            note: row.decisionNote,
            decided_by: row.decidedBy,
            decided_at: toUnix(row.decidedAt),
          }
        : null,
    created: toUnix(row.createdAt),
    updated: toUnix(row.updatedAt),
  };
}

function actionDto(
  merchant: MerchantRow,
  row: Awaited<ReturnType<typeof listActions>>['data'][number],
): TaxComplianceAction {
  return {
    object: 'tax.compliance_action',
    id: row.publicId,
    livemode: merchant.livemode,
    action: row.action,
    actor: { type: row.actorType, id: row.actorId },
    object_type: row.objectType,
    object_id: row.objectId,
    details: row.details,
    created: toUnix(row.createdAt),
  };
}

/** Canonical JSON: keys sorted at every depth, so equal inputs digest equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

const digest = (inputs: AssessmentInputs) =>
  createHash('sha256').update(canonicalJson(inputs)).digest('hex');

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** A result as compared on replay: the review items a replay never opens are left out. */
const comparable = (results: readonly TaxAssessmentResult[]) =>
  canonicalJson(results.map(({ review_items: _ignored, ...rest }) => rest));

const DUE_SOON_SECONDS = 14 * 86_400;

export interface TaxComplianceServiceOptions {
  readonly db: Database;
  readonly now?: () => Date;
}

export function createTaxComplianceService(options: TaxComplianceServiceOptions) {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  async function profileDto(
    merchant: MerchantRow,
    row: BusinessProfileRow | null,
  ): Promise<TaxBusinessProfile> {
    const [name, locations, destinations] = await Promise.all([
      findLegalName(db, merchant.id),
      allOperatingLocations(db, merchant.id),
      allSalesDestinations(db, merchant.id),
    ]);
    const at = now();
    const current = <T extends { startedAt: Date | null; endedAt: Date | null }>(list: T[]) =>
      list.filter(
        (each) =>
          (!each.startedAt || +each.startedAt <= +at) && (!each.endedAt || +each.endedAt > +at),
      );
    const missing: string[] = [];
    if (!name) missing.push('legal_name');
    if (!row || row.entityType === 'unknown') missing.push('entity_type');
    if (!row || row.customerTypes === 'unknown') missing.push('customer_types');
    if (
      !current(locations).some(
        (each) => each.kind === 'head_office' || each.kind === 'fixed_establishment',
      )
    )
      missing.push('establishment');
    if (!current(destinations).length) missing.push('sales_destinations');
    return {
      object: 'tax.business_profile',
      livemode: merchant.livemode,
      legal_name: name,
      entity_type: row?.entityType ?? 'unknown',
      incorporation_country: row?.incorporationCountry ?? null,
      incorporation_state: row?.incorporationState ?? null,
      fiscal_year_end_month: row?.fiscalYearEndMonth ?? null,
      customer_types: row?.customerTypes ?? 'unknown',
      supply_types: row?.supplyTypes ?? [],
      missing,
      metadata: row?.metadata ?? {},
      updated_by: row?.updatedBy ?? null,
      updated: toUnixOrNull(row?.updatedAt),
    };
  }

  function assertPeriod(started: Date | null, ended: Date | null, param: string) {
    if (started && ended && +ended <= +started)
      throw new TaxComplianceError('invalid_tax_request', `${param} must follow its start`, param);
  }

  /** The rules a declaration must satisfy, judged on its merged state. */
  function checkDeclaration(merged: {
    country: string;
    state: string | null;
    scheme: DeclarationRow['scheme'];
    status: DeclarationRow['status'];
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
  }) {
    const fail = (message: string, param: string) => {
      throw new TaxComplianceError('invalid_registration_declaration', message, param);
    };
    if (merged.scheme) {
      const problem = validateRegistration(merged.country, merged.state, merged.scheme);
      if (problem) fail(problem, 'scheme');
    }
    if ((merged.status === 'registered' || merged.status === 'ended') && !merged.effectiveFrom)
      fail(`a ${merged.status} registration needs effective_from`, 'effective_from');
    if (merged.status === 'ended' && !merged.effectiveTo)
      fail('an ended registration needs effective_to', 'effective_to');
    if (merged.effectiveFrom && merged.effectiveTo && +merged.effectiveTo <= +merged.effectiveFrom)
      fail('effective_to must follow effective_from', 'effective_to');
  }

  async function collectionRegistrationId(
    merchant: MerchantRow,
    publicId: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (publicId === undefined) return undefined;
    if (publicId === null) return null;
    const row = await findCollectionRegistration(db, merchant.id, publicId);
    if (!row)
      throw new TaxComplianceError(
        'invalid_registration_declaration',
        'collection_registration must name one of your Peable Tax registrations',
        'collection_registration',
      );
    return row.id;
  }

  async function gatherInputs(merchant: MerchantRow, asOf: Date): Promise<AssessmentInputs> {
    const [locations, destinations, declarations, registrations, sales] = await Promise.all([
      allOperatingLocations(db, merchant.id),
      allSalesDestinations(db, merchant.id),
      allDeclarations(db, merchant.id),
      approvedCollectionRegistrations(db, merchant.id),
      monthlySales(db, merchant.id, salesWindowStart(asOf), asOf),
    ]);
    return {
      rule_set_version: CURRENT_RULE_SET_VERSION,
      as_of: asOf.toISOString(),
      locations: locations.map((row) => ({
        id: row.publicId,
        kind: row.kind,
        country: row.country,
        state: row.state,
        started: iso(row.startedAt),
        ended: iso(row.endedAt),
      })),
      destinations: destinations.map((row) => ({
        id: row.publicId,
        country: row.country,
        state: row.state,
        started: iso(row.startedAt),
        ended: iso(row.endedAt),
      })),
      declarations: declarations.map((row) => ({
        id: row.publicId,
        country: row.country,
        state: row.state,
        scheme: row.scheme,
        status: row.status,
        effective_from: iso(row.effectiveFrom),
        effective_to: iso(row.effectiveTo),
      })),
      collection_registrations: registrations.map((row) => ({
        id: row.publicId,
        country: row.country,
        state: row.state,
        scheme: row.scheme,
        active_from: (row.activeFrom ?? row.createdAt).toISOString(),
        expires_at: iso(row.expiresAt),
      })),
      sales: sales.map((row) => ({
        country: row.country,
        state: row.state,
        currency: row.currency,
        month: row.month,
        net_minor: BigInt(row.net.split('.')[0] ?? '0').toString(),
        transactions: row.transactions,
      })),
    };
  }

  const service = {
    // ── Onboarding ───────────────────────────────────────────────────────────
    async getProfile(merchant: MerchantRow): Promise<TaxBusinessProfile> {
      return profileDto(merchant, await findBusinessProfile(db, merchant.id));
    },
    async updateProfile(
      merchant: MerchantRow,
      raw: unknown,
      actor: TaxComplianceActor,
    ): Promise<TaxBusinessProfile> {
      const input = parse(updateTaxBusinessProfileParams, raw);
      const row = await db.transaction(async (tx) => {
        const updated = await upsertBusinessProfile(
          tx,
          merchant.id,
          {
            ...(input.entity_type !== undefined ? { entityType: input.entity_type } : {}),
            ...(input.incorporation_country !== undefined
              ? { incorporationCountry: input.incorporation_country }
              : {}),
            ...(input.incorporation_state !== undefined
              ? { incorporationState: input.incorporation_state }
              : {}),
            ...(input.fiscal_year_end_month !== undefined
              ? { fiscalYearEndMonth: input.fiscal_year_end_month }
              : {}),
            ...(input.customer_types !== undefined ? { customerTypes: input.customer_types } : {}),
            ...(input.supply_types !== undefined ? { supplyTypes: input.supply_types } : {}),
            updatedBy: actor.type === 'user' ? actor.id : null,
          },
          input.metadata,
        );
        if (!updated)
          throw new TaxComplianceError(
            'invalid_tax_request',
            'metadata holds at most 50 keys',
            'metadata',
          );
        await record(
          tx,
          merchant,
          actor,
          'business_profile.updated',
          'tax.business_profile',
          null,
          {
            ...changedFields(input),
            ...(input.entity_type ? { entity_type: input.entity_type } : {}),
          },
        );
        return updated;
      });
      return profileDto(merchant, row);
    },

    async createLocation(merchant: MerchantRow, raw: unknown, actor: TaxComplianceActor) {
      const input = parse(createTaxOperatingLocationParams, raw);
      const startedAt = date(input.started) ?? null;
      const endedAt = date(input.ended) ?? null;
      assertPeriod(startedAt, endedAt, 'ended');
      const row = await db.transaction(async (tx) => {
        const created = await insertOperatingLocation(tx, {
          publicId: newId('taxol'),
          merchantId: merchant.id,
          kind: input.kind,
          country: input.country,
          state: input.state ?? null,
          description: input.description ?? null,
          startedAt,
          endedAt,
          metadata: input.metadata ?? {},
        });
        await record(
          tx,
          merchant,
          actor,
          'operating_location.created',
          'tax.operating_location',
          created.publicId,
          {
            kind: created.kind,
            country: created.country,
            state: created.state,
          },
        );
        return created;
      });
      return locationDto(merchant, row);
    },
    async retrieveLocation(merchant: MerchantRow, id: string) {
      const row = await findOperatingLocation(db, merchant.id, id);
      if (!row) throw notFound('operating location');
      return locationDto(merchant, row);
    },
    async updateLocation(
      merchant: MerchantRow,
      id: string,
      raw: unknown,
      actor: TaxComplianceActor,
    ) {
      const input = parse(updateTaxOperatingLocationParams, raw);
      const current = await findOperatingLocation(db, merchant.id, id);
      if (!current) throw notFound('operating location');
      const startedAt =
        input.started === undefined ? current.startedAt : (date(input.started) ?? null);
      const endedAt = input.ended === undefined ? current.endedAt : (date(input.ended) ?? null);
      assertPeriod(startedAt, endedAt, 'ended');
      const row = await db.transaction(async (tx) => {
        const updated = await updateOperatingLocation(
          tx,
          merchant.id,
          id,
          {
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.started !== undefined ? { startedAt } : {}),
            ...(input.ended !== undefined ? { endedAt } : {}),
          },
          input.metadata,
        );
        if (!updated)
          throw new TaxComplianceError(
            'invalid_tax_request',
            'metadata holds at most 50 keys',
            'metadata',
          );
        await record(
          tx,
          merchant,
          actor,
          'operating_location.updated',
          'tax.operating_location',
          id,
          changedFields(input),
        );
        return updated;
      });
      return locationDto(merchant, row);
    },
    async listLocations(merchant: MerchantRow, page: KeysetPage) {
      const result = await listOperatingLocations(db, merchant.id, page);
      return { ...result, data: result.data.map((row) => locationDto(merchant, row)) };
    },

    async createDestination(merchant: MerchantRow, raw: unknown, actor: TaxComplianceActor) {
      const input = parse(createTaxSalesDestinationParams, raw);
      const startedAt = date(input.started) ?? null;
      const endedAt = date(input.ended) ?? null;
      assertPeriod(startedAt, endedAt, 'ended');
      const row = await db.transaction(async (tx) => {
        const created = await insertSalesDestination(tx, {
          publicId: newId('taxdest'),
          merchantId: merchant.id,
          country: input.country,
          state: input.state ?? null,
          customerTypes: input.customer_types ?? 'unknown',
          startedAt,
          endedAt,
          metadata: input.metadata ?? {},
        });
        await record(
          tx,
          merchant,
          actor,
          'sales_destination.created',
          'tax.sales_destination',
          created.publicId,
          {
            country: created.country,
            state: created.state,
          },
        );
        return created;
      });
      return destinationDto(merchant, row);
    },
    async retrieveDestination(merchant: MerchantRow, id: string) {
      const row = await findSalesDestination(db, merchant.id, id);
      if (!row) throw notFound('sales destination');
      return destinationDto(merchant, row);
    },
    async updateDestination(
      merchant: MerchantRow,
      id: string,
      raw: unknown,
      actor: TaxComplianceActor,
    ) {
      const input = parse(updateTaxSalesDestinationParams, raw);
      const current = await findSalesDestination(db, merchant.id, id);
      if (!current) throw notFound('sales destination');
      const startedAt =
        input.started === undefined ? current.startedAt : (date(input.started) ?? null);
      const endedAt = input.ended === undefined ? current.endedAt : (date(input.ended) ?? null);
      assertPeriod(startedAt, endedAt, 'ended');
      const row = await db.transaction(async (tx) => {
        const updated = await updateSalesDestination(
          tx,
          merchant.id,
          id,
          {
            ...(input.customer_types !== undefined ? { customerTypes: input.customer_types } : {}),
            ...(input.started !== undefined ? { startedAt } : {}),
            ...(input.ended !== undefined ? { endedAt } : {}),
          },
          input.metadata,
        );
        if (!updated)
          throw new TaxComplianceError(
            'invalid_tax_request',
            'metadata holds at most 50 keys',
            'metadata',
          );
        await record(
          tx,
          merchant,
          actor,
          'sales_destination.updated',
          'tax.sales_destination',
          id,
          changedFields(input),
        );
        return updated;
      });
      return destinationDto(merchant, row);
    },
    async listDestinations(merchant: MerchantRow, page: KeysetPage) {
      const result = await listSalesDestinations(db, merchant.id, page);
      return { ...result, data: result.data.map((row) => destinationDto(merchant, row)) };
    },

    // ── Registration declarations ─────────────────────────────────────────────
    async createDeclaration(merchant: MerchantRow, raw: unknown, actor: TaxComplianceActor) {
      const input = parse(createTaxRegistrationDeclarationParams, raw);
      const merged = {
        country: input.country,
        state: input.state ?? null,
        scheme: input.scheme ?? null,
        status: input.status,
        effectiveFrom: date(input.effective_from) ?? null,
        effectiveTo: date(input.effective_to) ?? null,
      };
      checkDeclaration(merged);
      const registrationId = await collectionRegistrationId(
        merchant,
        input.collection_registration,
      );
      const row = await db.transaction(async (tx) => {
        const created = await insertDeclaration(tx, {
          publicId: newId('taxrd'),
          merchantId: merchant.id,
          ...merged,
          filingFrequency: input.filing_frequency ?? 'unknown',
          collectionRegistrationId: registrationId ?? null,
          note: input.note ?? null,
          metadata: input.metadata ?? {},
        });
        await record(
          tx,
          merchant,
          actor,
          'registration_declaration.created',
          'tax.registration_declaration',
          created.publicId,
          { country: created.country, state: created.state, status: created.status },
        );
        return created;
      });
      return declarationDto(merchant, row);
    },
    async retrieveDeclaration(merchant: MerchantRow, id: string) {
      const row = await findDeclaration(db, merchant.id, id);
      if (!row) throw notFound('registration declaration');
      return declarationDto(merchant, row);
    },
    async updateDeclaration(
      merchant: MerchantRow,
      id: string,
      raw: unknown,
      actor: TaxComplianceActor,
    ) {
      const input = parse(updateTaxRegistrationDeclarationParams, raw);
      const registrationId = await collectionRegistrationId(
        merchant,
        input.collection_registration,
      );
      const row = await db.transaction(async (tx) => {
        const current = await findDeclaration(tx, merchant.id, id, { forUpdate: true });
        if (!current) throw notFound('registration declaration');
        const merged = {
          country: current.country,
          state: current.state,
          scheme: input.scheme === undefined ? current.scheme : input.scheme,
          status: input.status ?? current.status,
          effectiveFrom:
            input.effective_from === undefined
              ? current.effectiveFrom
              : (date(input.effective_from) ?? null),
          effectiveTo:
            input.effective_to === undefined
              ? current.effectiveTo
              : (date(input.effective_to) ?? null),
        };
        checkDeclaration(merged);
        const updated = await updateDeclaration(
          tx,
          merchant.id,
          current.id,
          {
            scheme: merged.scheme,
            status: merged.status,
            effectiveFrom: merged.effectiveFrom,
            effectiveTo: merged.effectiveTo,
            ...(input.filing_frequency !== undefined
              ? { filingFrequency: input.filing_frequency }
              : {}),
            ...(registrationId !== undefined ? { collectionRegistrationId: registrationId } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
          input.metadata,
        );
        if (!updated)
          throw new TaxComplianceError(
            'invalid_tax_request',
            'metadata holds at most 50 keys',
            'metadata',
          );
        await record(
          tx,
          merchant,
          actor,
          'registration_declaration.updated',
          'tax.registration_declaration',
          id,
          {
            ...changedFields(input),
            previous_status: current.status,
            status: updated.status,
          },
        );
        return updated;
      });
      return declarationDto(merchant, row);
    },
    async listDeclarations(merchant: MerchantRow, page: KeysetPage) {
      const result = await listDeclarations(db, merchant.id, page);
      return { ...result, data: result.data.map((row) => declarationDto(merchant, row)) };
    },

    // ── Documents ─────────────────────────────────────────────────────────────
    /**
     * Attach the merchant's own `tax_document` file. Idempotent by file: a
     * retry (or a second click) answers the document that file already is.
     */
    async createDocument(
      merchant: MerchantRow,
      raw: unknown,
      actor: TaxComplianceActor,
    ): Promise<{ document: TaxDocument; created: boolean }> {
      const input = parse(createTaxDocumentParams, raw);
      const file = await findFileByPublicId(db, merchant.id, input.file);
      if (file?.purpose !== 'tax_document')
        throw new TaxComplianceError(
          'invalid_tax_document',
          'file must name one of your files of purpose tax_document',
          'file',
        );
      if (file.removedAt !== null)
        throw new TaxComplianceError('invalid_tax_document', 'that file has been removed', 'file');
      const existing = await findDocumentByFile(db, merchant.id, file.id);
      if (existing) return { document: documentDto(merchant, existing), created: false };
      let declarationId: string | null = null;
      if (input.registration_declaration) {
        const declaration = await findDeclaration(db, merchant.id, input.registration_declaration);
        if (!declaration)
          throw new TaxComplianceError(
            'invalid_tax_document',
            'registration_declaration must name one of your registration declarations',
            'registration_declaration',
          );
        declarationId = declaration.id;
      }
      const publicId = await db.transaction(async (tx) => {
        const inserted = await insertDocument(tx, {
          publicId: newId('taxdoc'),
          merchantId: merchant.id,
          fileId: file.id,
          kind: input.kind,
          country: input.country ?? null,
          state: input.state ?? null,
          declarationId,
          description: input.description ?? null,
          metadata: input.metadata ?? {},
        });
        if (inserted)
          await record(tx, merchant, actor, 'document.attached', 'tax.document', inserted, {
            kind: input.kind,
            country: input.country ?? null,
          });
        return inserted;
      });
      const row = publicId
        ? await findDocument(db, merchant.id, publicId)
        : await findDocumentByFile(db, merchant.id, file.id);
      if (!row) throw new Error('tax document vanished');
      return { document: documentDto(merchant, row), created: publicId !== null };
    },
    async retrieveDocument(merchant: MerchantRow, id: string) {
      const row = await findDocument(db, merchant.id, id);
      if (!row) throw notFound('tax document');
      return documentDto(merchant, row);
    },
    async listDocuments(merchant: MerchantRow, page: KeysetPage) {
      const result = await listDocuments(db, merchant.id, page);
      return { ...result, data: result.data.map((row) => documentDto(merchant, row)) };
    },
    async checklist(merchant: MerchantRow): Promise<TaxDocumentChecklist> {
      const [declarations, documents, profile] = await Promise.all([
        allDeclarations(db, merchant.id),
        allDocuments(db, merchant.id),
        findBusinessProfile(db, merchant.id),
      ]);
      const items: TaxDocumentChecklistItem[] = [];
      const judge = (
        key: string,
        kind: TaxDocumentChecklistItem['kind'],
        place: { country: string | null; state: string | null },
        matches: (doc: DocumentRow) => boolean,
        reason: string,
      ) => {
        const attached = documents.filter((doc) => doc.kind === kind && matches(doc));
        const usable = attached.filter((doc) => doc.fileRemovedAt === null);
        items.push({
          key,
          kind,
          country: place.country,
          state: place.state,
          status: usable.length ? 'provided' : attached.length ? 'unavailable' : 'missing',
          documents: attached.map((doc) => doc.publicId),
          reason,
        });
      };
      judge(
        'incorporation_record',
        'incorporation_record',
        {
          country: profile?.incorporationCountry ?? null,
          state: profile?.incorporationState ?? null,
        },
        () => true,
        'Supports the entity facts in the business profile. It is never treated as evidence of a tax registration or liability.',
      );
      for (const declaration of declarations) {
        const forThis = (doc: DocumentRow) =>
          doc.declarationPublicId === declaration.publicId ||
          (doc.declarationPublicId === null &&
            doc.country === declaration.country &&
            (doc.state ?? null) === declaration.state);
        const place = { country: declaration.country, state: declaration.state };
        if (declaration.status === 'registered' || declaration.status === 'ended')
          judge(
            `registration_certificate:${declaration.publicId}`,
            'registration_certificate',
            place,
            forThis,
            'The authority’s confirmation of the declared registration. Peable stores it for review; it does not verify it.',
          );
        if (declaration.status === 'application_pending' || declaration.status === 'rejected')
          judge(
            `authority_correspondence:${declaration.publicId}`,
            'authority_correspondence',
            place,
            forThis,
            declaration.status === 'rejected'
              ? 'The authority’s refusal, so the rejected state can be explained.'
              : 'The application acknowledgement, until the authority answers.',
          );
      }
      return { object: 'tax.document_checklist', livemode: merchant.livemode, items };
    },

    // ── Rules, capabilities, deadlines ───────────────────────────────────────
    ruleSet(): TaxRuleSet {
      return ruleSetDto(currentRuleSet());
    },
    capabilities(merchant: MerchantRow): TaxComplianceCapabilities {
      const definition = currentRuleSet();
      return {
        object: 'tax.compliance_capabilities',
        livemode: merchant.livemode,
        rule_set_version: definition.version,
        supported_rules: definition.rules.map((rule) => rule.id),
        capabilities: [
          {
            id: 'business_onboarding',
            category: 'workflow',
            status: 'available',
            reason:
              'Entity, operating locations, sales destinations, declared registrations and documents.',
          },
          {
            id: 'obligation_assessment',
            category: 'vat_sales_tax',
            status: 'limited',
            reason:
              'Only the rules in the current rule set are assessed; everything else is reported as unsupported. Every finding goes to the review queue.',
          },
          {
            id: 'threshold_monitoring',
            category: 'vat_sales_tax',
            status: 'limited',
            reason:
              'Measured from Peable Tax transactions only; sales outside Peable are not visible.',
          },
          {
            id: 'review_queue',
            category: 'workflow',
            status: 'available',
            reason: 'Findings that need a person, with the owner’s recorded decision.',
          },
          {
            id: 'deadlines',
            category: 'vat_sales_tax',
            status: 'limited',
            reason:
              'EU OSS return and payment dates and the Texas permit date after crossing the threshold. Other due dates are listed as not computed.',
          },
          {
            id: 'sales_reports',
            category: 'vat_sales_tax',
            status: 'available',
            reason: 'The Peable Tax summary report and CSV export. A report is not a filed return.',
          },
          {
            id: 'collection_activation',
            category: 'vat_sales_tax',
            status: 'limited',
            reason:
              'Only the owner turns collection on, by adding a Peable Tax registration and approving it. No assessment, decision or assistant does.',
          },
          {
            id: 'registration_submission',
            category: 'vat_sales_tax',
            status: 'not_available',
            reason:
              'Peable submits no registration to any authority. Register with the authority directly and record the outcome here.',
          },
          {
            id: 'registration_verification',
            category: 'vat_sales_tax',
            status: 'not_available',
            reason:
              'No authority integration confirms a registration; every declaration stays unverified.',
          },
          {
            id: 'return_filing',
            category: 'vat_sales_tax',
            status: 'not_available',
            reason: 'Peable files no return. A CSV export is not a filed return.',
          },
          {
            id: 'remittance',
            category: 'vat_sales_tax',
            status: 'not_available',
            reason: 'Peable pays no tax to any authority and records no payment as made.',
          },
          {
            id: 'corporate_income_tax',
            category: 'corporate_income_tax',
            status: 'out_of_scope',
            reason:
              'Corporate income tax (and Texas franchise tax) is a different obligation and is not assessed.',
          },
          {
            id: 'annual_company_filings',
            category: 'annual_company_filings',
            status: 'out_of_scope',
            reason: 'Annual reports and company registry filings are not tracked.',
          },
          {
            id: 'assistant',
            category: 'workflow',
            status: 'not_available',
            reason:
              'No assistant tool exists. When one does, it may explain and prepare drafts; it can never approve, activate, submit or decide.',
          },
        ],
      };
    },
    async deadlines(
      merchant: MerchantRow,
    ): Promise<{ data: TaxDeadline[]; unavailable: TaxDeadlineUnavailable[] }> {
      const at = now();
      const nowSeconds = Math.floor(+at / 1000);
      const [declarations, latest] = await Promise.all([
        allDeclarations(db, merchant.id),
        latestAssessment(db, merchant.id),
      ]);
      const definition = currentRuleSet();
      const data: TaxDeadline[] = [];
      const unavailable: TaxDeadlineUnavailable[] = [];
      const statusOf = (due: number): TaxDeadline['status'] =>
        due < nowSeconds
          ? 'passed'
          : due - nowSeconds <= DUE_SOON_SECONDS
            ? 'due_soon'
            : 'upcoming';
      const active = declarations.filter(
        (row) =>
          row.status === 'registered' &&
          (!row.effectiveFrom || +row.effectiveFrom <= +at) &&
          (!row.effectiveTo || +row.effectiveTo > +at),
      );
      const oss = active.filter(
        (row) => row.scheme === 'eu_oss_union' || row.scheme === 'eu_oss_non_union',
      );
      if (oss.length) {
        // The calendar quarter in progress and the one before it: each return
        // (and its payment) is due by the end of the month after the quarter.
        const quarterStart = Math.floor(monthIndex(at) / 3) * 3;
        for (const start of [quarterStart - 3, quarterStart]) {
          const periodStart = Math.floor(+monthStart(start) / 1000);
          const periodEnd = Math.floor(+monthStart(start + 3) / 1000);
          const due = Math.floor(+monthStart(start + 4) / 1000) - 1;
          const registeredFrom = Math.min(...oss.map((row) => +(row.effectiveFrom ?? 0) / 1000));
          if (periodEnd <= registeredFrom) continue;
          for (const kind of ['return', 'payment'] as const)
            data.push({
              object: 'tax.deadline',
              kind,
              rule: EU_VAT_RULE,
              country: oss[0]?.country ?? null,
              state: null,
              period_start: periodStart,
              period_end: periodEnd,
              due,
              status: statusOf(due),
              filing_status: 'not_tracked',
              description:
                kind === 'return'
                  ? 'OSS VAT return for the calendar quarter, due by the end of the following month.'
                  : 'OSS VAT payment for the quarter, due by the same date as the return.',
              source: SOURCES.euOssReturns,
            });
        }
      }
      for (const row of active) {
        if (row.scheme === 'eu_oss_union' || row.scheme === 'eu_oss_non_union') continue;
        const rule = ruleFor(definition, row.country, row.state);
        unavailable.push({
          rule: rule?.id ?? null,
          country: row.country,
          state: row.state,
          reason: !rule
            ? 'This jurisdiction is not in the supported rule set; its due dates are not computed.'
            : rule.id === US_TX_RULE
              ? 'Texas return due dates depend on the filing frequency the Comptroller assigns; they are not computed.'
              : 'National VAT return periods are set by each member state and are not computed.',
        });
      }
      for (const result of latest?.results ?? []) {
        if (result.deadline && result.outcome === 'likely_required' && result.rule)
          data.push({
            object: 'tax.deadline',
            kind: 'registration',
            rule: result.rule,
            country: result.country,
            state: result.state,
            period_start: result.measured?.from ?? null,
            period_end: result.measured?.to ?? null,
            due: result.deadline.due,
            status: statusOf(result.deadline.due),
            filing_status: 'not_tracked',
            description:
              'From the latest assessment: the threshold was crossed, and the rule sets a date by which the permit must be obtained.',
            source: result.deadline.source,
          });
      }
      data.sort((a, b) => a.due - b.due);
      return { data, unavailable };
    },

    // ── Assessments ───────────────────────────────────────────────────────────
    async createAssessment(
      merchant: MerchantRow,
      raw: unknown,
      actor: TaxComplianceActor,
    ): Promise<TaxAssessment> {
      const input = parse(createTaxAssessmentParams, raw);
      const at = now();
      const asOf = input.as_of === undefined ? at : fromUnix(input.as_of);
      if (+asOf > +at + 60_000)
        throw new TaxComplianceError(
          'invalid_tax_request',
          'as_of cannot be in the future',
          'as_of',
        );
      const inputs = await gatherInputs(merchant, asOf);
      const evaluated = evaluate(inputs, currentRuleSet());
      const row = await db.transaction(async (tx) => {
        const assessment = await insertAssessment(tx, {
          publicId: newId('taxasm'),
          merchantId: merchant.id,
          ruleSetVersion: inputs.rule_set_version,
          asOf,
          inputs: inputs as unknown as Record<string, unknown>,
          inputsDigest: digest(inputs),
          results: [],
          summary: summarize(evaluated.map((each) => each.result)),
          actorType: actor.type,
          actorId: actor.id,
        });
        const results: TaxAssessmentResult[] = [];
        for (const each of evaluated) {
          const ids: string[] = [];
          for (const item of each.findings) {
            const { row: review, created } = await upsertOpenReviewItem(tx, {
              publicId: newId('taxrev'),
              merchantId: merchant.id,
              dedupeKey: item.dedupeKey,
              code: item.code,
              severity: item.severity,
              rule: item.rule,
              country: item.country,
              state: item.state,
              message: item.message,
              firstAssessmentId: assessment.id,
              latestAssessmentId: assessment.id,
            });
            ids.push(review.publicId);
            if (created) {
              await record(
                tx,
                merchant,
                actor,
                'review_item.opened',
                'tax.review_item',
                review.publicId,
                {
                  code: review.code,
                  severity: review.severity,
                  assessment: assessment.publicId,
                },
              );
              await recordEvent(tx, {
                merchantId: merchant.id,
                type: 'tax.review_item.created',
                object: reviewItemDto(merchant, review),
              });
            }
          }
          results.push({ ...each.result, review_items: ids });
        }
        const stored = await setAssessmentResults(tx, assessment.id, results);
        await record(tx, merchant, actor, 'assessment.created', 'tax.assessment', stored.publicId, {
          rule_set_version: stored.ruleSetVersion,
          likely_required: stored.summary.likely_required,
          uncertain: stored.summary.uncertain,
          unsupported: stored.summary.unsupported,
        });
        await recordEvent(tx, {
          merchantId: merchant.id,
          type: 'tax.assessment.created',
          object: assessmentDto(merchant, stored),
        });
        return stored;
      });
      return assessmentDto(merchant, row);
    },
    async retrieveAssessment(merchant: MerchantRow, id: string) {
      const row = await findAssessment(db, merchant.id, id);
      if (!row) throw notFound('assessment');
      return assessmentDto(merchant, row);
    },
    async listAssessments(merchant: MerchantRow, page: KeysetPage) {
      const result = await listAssessments(db, merchant.id, page);
      return { ...result, data: result.data.map((row) => assessmentDto(merchant, row)) };
    },
    /** Re-run the stored inputs through the stored version. Reads only: opens nothing. */
    async replayAssessment(merchant: MerchantRow, id: string): Promise<TaxAssessmentReplay> {
      const row = await findAssessment(db, merchant.id, id);
      if (!row) throw notFound('assessment');
      const definition = ruleSetByVersion(row.ruleSetVersion);
      if (!definition)
        throw new TaxComplianceError(
          'rule_set_version_unavailable',
          `rule set ${row.ruleSetVersion} is no longer available to replay`,
        );
      const inputs = row.inputs as unknown as AssessmentInputs;
      const replayed = evaluate(inputs, definition).map((each) => ({
        ...each.result,
        review_items: [] as string[],
      }));
      const inputsDigest = digest(inputs);
      return {
        object: 'tax.assessment_replay',
        assessment: row.publicId,
        rule_set_version: definition.version,
        inputs_digest: inputsDigest,
        matches:
          inputsDigest === row.inputsDigest && comparable(replayed) === comparable(row.results),
        results: replayed,
      };
    },

    // ── Review queue ──────────────────────────────────────────────────────────
    async retrieveReviewItem(merchant: MerchantRow, id: string) {
      const row = await findReviewItem(db, merchant.id, id);
      if (!row) throw notFound('review item');
      return reviewItemDto(merchant, row);
    },
    async listReviewItems(
      merchant: MerchantRow,
      page: KeysetPage,
      status?: ReviewItemRow['status'],
    ) {
      const result = await listReviewItems(db, merchant.id, page, status);
      return { ...result, data: result.data.map((row) => reviewItemDto(merchant, row)) };
    },
    /**
     * The owner's decision on an open item. Recorded, never acted on: deciding
     * `will_register` registers nothing and turns nothing on.
     */
    async resolveReviewItem(
      merchant: MerchantRow,
      id: string,
      raw: unknown,
      actor: TaxComplianceActor & { type: 'user'; id: string },
    ): Promise<TaxReviewItem> {
      const input = parse(resolveTaxReviewItemParams, raw);
      const row = await db.transaction(async (tx) => {
        const decided = await decideReviewItem(tx, merchant.id, id, {
          status: input.decision === 'dismissed' ? 'dismissed' : 'resolved',
          decision: input.decision,
          decisionNote: input.note ?? null,
          decidedBy: actor.id,
          decidedAt: now(),
        });
        if (!decided) {
          const existing = await findReviewItem(tx, merchant.id, id);
          if (!existing) throw notFound('review item');
          throw new TaxComplianceError(
            'review_item_not_open',
            `this review item was already ${existing.status}`,
          );
        }
        await record(
          tx,
          merchant,
          actor,
          'review_item.decided',
          'tax.review_item',
          decided.publicId,
          {
            decision: input.decision,
            code: decided.code,
          },
        );
        await recordEvent(tx, {
          merchantId: merchant.id,
          type: 'tax.review_item.updated',
          object: reviewItemDto(merchant, decided),
          previousAttributes: { status: 'open', decision: null },
        });
        return decided;
      });
      return reviewItemDto(merchant, row);
    },

    // ── History ──────────────────────────────────────────────────────────────
    async listActions(merchant: MerchantRow, page: KeysetPage) {
      const result = await listActions(db, merchant.id, page);
      return { ...result, data: result.data.map((row) => actionDto(merchant, row)) };
    },
    /** A list cursor's public id → internal id, inside the merchant. */
    cursor(kind: TaxComplianceCursor, merchant: MerchantRow, publicId: string) {
      return cursorId(db, CURSOR_TABLES[kind], merchant.id, publicId);
    },
  };
  return service;
}

const CURSOR_TABLES = {
  operating_location: taxOperatingLocations,
  sales_destination: taxSalesDestinations,
  registration_declaration: taxRegistrationDeclarations,
  document: taxComplianceDocuments,
  assessment: taxComplianceAssessments,
  review_item: taxReviewItems,
  action: taxComplianceActions,
} as const;
export type TaxComplianceCursor = keyof typeof CURSOR_TABLES;

export type TaxComplianceService = ReturnType<typeof createTaxComplianceService>;
