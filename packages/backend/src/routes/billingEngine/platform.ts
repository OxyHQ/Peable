/**
 * Test clocks, billing settings, meters and entitlements — ADR 0018 §3, §5–8.
 * The customer portal's merchant side is `portal.ts`.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  BILLING_SETTINGS_LIMITS,
  DUNNING_FINAL_ACTIONS,
  DUNNING_INVOICE_ACTIONS,
  METER_AGGREGATIONS,
  METER_STATUSES,
} from '@peable.to/shared-types';
import { findLiveCustomerForMerchant } from '../../db/customers/customerRepository';
import { findProductForMerchant } from '../../db/catalog/productRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  findFeatureForMerchant,
  findFeaturesByIds,
  findProductFeature,
  listFeatures,
  listProductFeatures,
} from '../../db/billingEngine/entitlementRepository';
import { findMeterForMerchant, listMeters } from '../../db/billingEngine/meterRepository';
import { findLiveTestClockForMerchant } from '../../db/billingEngine/testClockRepository';
import { getDb } from '../../db/postgres';
import { answerList, parseQuery, surfaceListQuery, surfaceRetrieveQuery } from '../../lib/list';
import { metadataCreateSchema, metadataUpdateSchema } from '../../lib/metadata';
import { toTestClockDTO } from '../../lib/serializeBilling';
import { booleanQuery } from '../../services/catalog/params';
import {
  activeEntitlements,
  attachProductFeature,
  createFeature,
  detachProductFeature,
  toFeatureDTO,
  toProductFeatureDTO,
  updateFeatureFields,
} from '../../services/billingEngine/entitlements';
import { BillingEngineError, missing } from '../../services/billingEngine/errors';
import {
  changeBillingSettings,
  changeMeter,
  createMeter,
  getBillingSettings,
  meterSummary,
  recordMeterEvent,
  toBillingSettingsDTO,
  toMeterDTO,
  toMeterEventDTO,
} from '../../services/billingEngine/settingsAndMeters';
import {
  advanceTestClock,
  createTestClock,
  deleteTestClock,
  listTestClocks,
  retrieveTestClock,
} from '../../services/billingEngine/testClocks';
import type { CatalogRoute } from '../catalogRoutes';
import { idParam, idString, parseBody, queryUnixSeconds, shortText, unixSeconds } from './helpers';

const retrieveQuery = surfaceRetrieveQuery();

// ---- Test clocks ---------------------------------------------------------------------

const createClockBody = z
  .object({ frozen_time: unixSeconds, name: shortText(300).optional() })
  .strict();
const advanceBody = z.object({ frozen_time: unixSeconds }).strict();
const listClocksQuery = surfaceListQuery({});

const clockRoutes: CatalogRoute[] = [
  {
    method: 'post',
    path: '/test_helpers/test_clocks',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, createClockBody);
      if (!body) return;
      const row = await createTestClock(merchant, {
        frozenTime: body.frozen_time,
        ...(body.name ? { name: body.name } : {}),
      });
      res.status(200).json(toTestClockDTO(row));
    },
  },
  {
    method: 'get',
    path: '/test_helpers/test_clocks',
    core: async (req, res, merchant, surface) => {
      const query = parseQuery(req, res, listClocksQuery[surface]);
      if (!query) return;
      const db = getDb();
      await answerList(req, res, {
        query,
        type: 'test_helpers.test_clock',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findLiveTestClockForMerchant(db, publicId, merchant.id))?.id ?? null,
        fetch: (page) => listTestClocks(merchant, page),
        serialize: toTestClockDTO,
      });
    },
  },
  {
    method: 'get',
    path: '/test_helpers/test_clocks/:id',
    core: async (req, res, merchant, surface) => {
      const id = idParam(req, res);
      if (!id || !parseQuery(req, res, retrieveQuery[surface])) return;
      res.status(200).json(toTestClockDTO(await retrieveTestClock(merchant, id)));
    },
  },
  {
    method: 'post',
    path: '/test_helpers/test_clocks/:id/advance',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      if (!id) return;
      const body = parseBody(req, res, advanceBody);
      if (!body) return;
      res.status(200).json(toTestClockDTO(await advanceTestClock(merchant, id, body.frozen_time)));
    },
  },
  {
    method: 'delete',
    path: '/test_helpers/test_clocks/:id',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      if (!id) return;
      const row = await deleteTestClock(merchant, id);
      res.status(200).json({ id: row.publicId, object: 'test_helpers.test_clock', deleted: true });
    },
  },
];

// ---- Billing settings ------------------------------------------------------------------

const settingsBody = z
  .object({
    invoice_prefix: z
      .string()
      .regex(new RegExp(BILLING_SETTINGS_LIMITS.invoicePrefixPattern))
      .optional(),
    default_days_until_due: z
      .number()
      .int()
      .min(0)
      .max(BILLING_SETTINGS_LIMITS.daysUntilDueMax)
      .optional(),
    dunning: z
      .object({
        retry_schedule_days: z
          .array(z.number().int().min(1).max(BILLING_SETTINGS_LIMITS.retryDaysMax))
          .max(BILLING_SETTINGS_LIMITS.retriesMax)
          .optional(),
        final_action: z.enum(DUNNING_FINAL_ACTIONS).optional(),
        invoice_action: z.enum(DUNNING_INVOICE_ACTIONS).optional(),
      })
      .strict()
      .optional(),
    emails: z
      .object({ invoice_finalized: z.boolean().optional(), payment_failed: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();

const settingsRoutes: CatalogRoute[] = [
  {
    method: 'get',
    path: '/billing_settings',
    core: async (req, res, merchant, surface) => {
      if (!parseQuery(req, res, retrieveQuery[surface])) return;
      res
        .status(200)
        .json(toBillingSettingsDTO(await getBillingSettings(merchant), merchant.livemode));
    },
  },
  {
    method: 'post',
    path: '/billing_settings',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, settingsBody);
      if (!body) return;
      const row = await changeBillingSettings(merchant, {
        invoicePrefix: body.invoice_prefix,
        defaultDaysUntilDue: body.default_days_until_due,
        retryScheduleDays: body.dunning?.retry_schedule_days,
        finalAction: body.dunning?.final_action,
        invoiceAction: body.dunning?.invoice_action,
        emailInvoiceFinalized: body.emails?.invoice_finalized,
        emailPaymentFailed: body.emails?.payment_failed,
      });
      res.status(200).json(toBillingSettingsDTO(row, merchant.livemode));
    },
  },
];

// ---- Meters ---------------------------------------------------------------------------

const payloadKey = z.string().regex(/^[A-Za-z0-9_]{1,100}$/);
const createMeterBody = z
  .object({
    display_name: shortText(250),
    event_name: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    default_aggregation: z.object({ formula: z.enum(METER_AGGREGATIONS) }).strict(),
    customer_mapping: z
      .object({ type: z.literal('by_id'), event_payload_key: payloadKey })
      .strict()
      .optional(),
    value_settings: z.object({ event_payload_key: payloadKey }).strict().optional(),
  })
  .strict();
const updateMeterBody = z.object({ display_name: shortText(250).optional() }).strict();
const meterEventBody = z
  .object({
    event_name: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    payload: z.record(z.string().max(100), z.string().max(255)),
    identifier: z.string().min(1).max(100).optional(),
    timestamp: unixSeconds.optional(),
  })
  .strict();
const listMetersQuery = surfaceListQuery({ status: z.enum(METER_STATUSES).optional() });
const summaryQuery = {
  api: z
    .object({ customer: idString, start_time: queryUnixSeconds, end_time: queryUnixSeconds })
    .strict(),
  dashboard: z
    .object({
      customer: idString,
      start_time: queryUnixSeconds,
      end_time: queryUnixSeconds,
      environment: z.enum(['development', 'staging', 'production']),
    })
    .strict(),
} as const;

async function meterOf(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return null;
  const meter = await findMeterForMerchant(getDb(), id, merchant.id);
  if (!meter) throw missing('meter');
  return meter;
}

const meterRoutes: CatalogRoute[] = [
  {
    method: 'post',
    path: '/billing/meters',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, createMeterBody);
      if (!body) return;
      const row = await createMeter(merchant, {
        displayName: body.display_name,
        eventName: body.event_name,
        aggregation: body.default_aggregation.formula,
        ...(body.customer_mapping
          ? { customerPayloadKey: body.customer_mapping.event_payload_key }
          : {}),
        ...(body.value_settings ? { valuePayloadKey: body.value_settings.event_payload_key } : {}),
      });
      res.status(200).json(toMeterDTO(row));
    },
  },
  {
    method: 'get',
    path: '/billing/meters',
    core: async (req, res, merchant, surface) => {
      const query = parseQuery(req, res, listMetersQuery[surface]);
      if (!query) return;
      const db = getDb();
      await answerList(req, res, {
        query,
        type: 'billing.meter',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findMeterForMerchant(db, publicId, merchant.id))?.id ?? null,
        fetch: (page) => listMeters(db, { merchantId: merchant.id, page, status: query.status }),
        serialize: toMeterDTO,
      });
    },
  },
  {
    method: 'get',
    path: '/billing/meters/:id',
    core: async (req, res, merchant, surface) => {
      if (!parseQuery(req, res, retrieveQuery[surface])) return;
      const meter = await meterOf(req, res, merchant);
      if (meter) res.status(200).json(toMeterDTO(meter));
    },
  },
  {
    method: 'post',
    path: '/billing/meters/:id',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      const body = id ? parseBody(req, res, updateMeterBody) : null;
      if (!id || !body) return;
      res.status(200).json(
        toMeterDTO(
          await changeMeter(merchant, id, {
            ...(body.display_name ? { displayName: body.display_name } : {}),
          }),
        ),
      );
    },
  },
  {
    method: 'post',
    path: '/billing/meters/:id/deactivate',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      if (!id || !parseBody(req, res, z.object({}).strict())) return;
      res.status(200).json(toMeterDTO(await changeMeter(merchant, id, { status: 'inactive' })));
    },
  },
  {
    method: 'post',
    path: '/billing/meters/:id/reactivate',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      if (!id || !parseBody(req, res, z.object({}).strict())) return;
      res.status(200).json(toMeterDTO(await changeMeter(merchant, id, { status: 'active' })));
    },
  },
  {
    method: 'get',
    path: '/billing/meters/:id/event_summaries',
    core: async (req, res, merchant, surface) => {
      const id = idParam(req, res);
      const query = id ? parseQuery(req, res, summaryQuery[surface]) : null;
      if (!id || !query) return;
      const summary = await meterSummary(merchant, id, {
        customer: query.customer,
        startTime: query.start_time,
        endTime: query.end_time,
      });
      res.status(200).json({
        object: 'list',
        data: [summary],
        has_more: false,
        url: req.originalUrl.split('?')[0],
      });
    },
  },
  {
    method: 'post',
    path: '/billing/meter_events',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, meterEventBody);
      if (!body) return;
      const row = await recordMeterEvent(merchant, {
        eventName: body.event_name,
        payload: body.payload,
        ...(body.identifier ? { identifier: body.identifier } : {}),
        ...(body.timestamp !== undefined ? { timestamp: body.timestamp } : {}),
      });
      res.status(200).json(toMeterEventDTO(row, merchant.livemode));
    },
  },
];

// ---- Entitlements -----------------------------------------------------------------------

const createFeatureBody = z
  .object({
    lookup_key: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
    name: shortText(80),
    metadata: metadataCreateSchema.optional(),
  })
  .strict();
const updateFeatureBody = z
  .object({
    name: shortText(80).optional(),
    active: z.boolean().optional(),
    metadata: metadataUpdateSchema.optional(),
  })
  .strict();
const listFeaturesQuery = surfaceListQuery({
  lookup_key: z.string().min(1).max(80).optional(),
  archived: booleanQuery.optional(),
});
const attachBody = z.object({ entitlement_feature: idString }).strict();
const activeQuery = surfaceListQuery({ customer: idString });

const entitlementRoutes: CatalogRoute[] = [
  {
    method: 'post',
    path: '/entitlements/features',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, createFeatureBody);
      if (!body) return;
      const row = await createFeature(merchant, {
        lookupKey: body.lookup_key,
        name: body.name,
        metadata: body.metadata ?? {},
      });
      res.status(200).json(toFeatureDTO(row));
    },
  },
  {
    method: 'get',
    path: '/entitlements/features',
    core: async (req, res, merchant, surface) => {
      const query = parseQuery(req, res, listFeaturesQuery[surface]);
      if (!query) return;
      const db = getDb();
      await answerList(req, res, {
        query,
        type: 'entitlements.feature',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findFeatureForMerchant(db, publicId, merchant.id))?.id ?? null,
        fetch: (page) =>
          listFeatures(db, {
            merchantId: merchant.id,
            page,
            lookupKey: query.lookup_key,
            ...(query.archived !== undefined ? { active: !query.archived } : {}),
          }),
        serialize: toFeatureDTO,
      });
    },
  },
  {
    method: 'get',
    path: '/entitlements/features/:id',
    core: async (req, res, merchant, surface) => {
      const id = idParam(req, res);
      if (!id || !parseQuery(req, res, retrieveQuery[surface])) return;
      const row = await findFeatureForMerchant(getDb(), id, merchant.id);
      if (!row) throw missing('feature');
      res.status(200).json(toFeatureDTO(row));
    },
  },
  {
    method: 'post',
    path: '/entitlements/features/:id',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      const body = id ? parseBody(req, res, updateFeatureBody) : null;
      if (!id || !body) return;
      const row = await updateFeatureFields(merchant, id, {
        ...(body.name ? { name: body.name } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });
      res.status(200).json(toFeatureDTO(row));
    },
  },
  {
    method: 'post',
    path: '/products/:id/features',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      const body = id ? parseBody(req, res, attachBody) : null;
      if (!id || !body) return;
      const { attachment, feature } = await attachProductFeature(
        merchant,
        id,
        body.entitlement_feature,
      );
      res.status(200).json(toProductFeatureDTO(attachment, feature));
    },
  },
  {
    method: 'get',
    path: '/products/:id/features',
    core: async (req, res, merchant, surface) => {
      const id = idParam(req, res);
      const query = id ? parseQuery(req, res, surfaceListQuery({})[surface]) : null;
      if (!id || !query) return;
      const db = getDb();
      const product = await findProductForMerchant(db, id, merchant.id);
      if (!product) throw missing('product');
      await answerList(req, res, {
        query,
        type: 'product_feature',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findProductFeature(db, publicId, product.id))?.id ?? null,
        fetch: (page) => listProductFeatures(db, product.id, page),
        serializeAll: async (rows) => {
          const features = await findFeaturesByIds(
            db,
            rows.map((row) => row.featureId),
          );
          return rows.map((row) => {
            const feature = features.find((candidate) => candidate.id === row.featureId);
            if (!feature) throw new Error('attached feature vanished');
            return toProductFeatureDTO(row, feature);
          });
        },
      });
    },
  },
  {
    method: 'delete',
    path: '/products/:id/features/:feature',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      const attachment = idParam(req, res, 'feature');
      if (!id || !attachment) return;
      const row = await detachProductFeature(merchant, id, attachment);
      res.status(200).json({ id: row.publicId, object: 'product_feature', deleted: true });
    },
  },
  {
    method: 'get',
    path: '/entitlements/active_entitlements',
    core: async (req, res, merchant, surface) => {
      const query = parseQuery(req, res, activeQuery[surface]);
      if (!query) return;
      const customer = await findLiveCustomerForMerchant(getDb(), query.customer, merchant.id);
      if (!customer)
        throw new BillingEngineError(
          'resource_missing',
          `no such customer: '${query.customer}'`,
          'customer',
        );
      // A complete, bounded set (one row per feature): never paged.
      const data = await activeEntitlements(getDb(), customer);
      res
        .status(200)
        .json({ object: 'list', data, has_more: false, url: req.originalUrl.split('?')[0] });
    },
  },
];

export const PLATFORM_ROUTES: readonly CatalogRoute[] = [
  ...clockRoutes,
  ...settingsRoutes,
  ...meterRoutes,
  ...entitlementRoutes,
];
