/**
 * Test clocks, billing settings, meters and entitlements — ADR 0018 §3, §5–8.
 * The customer portal's merchant side is `portal.ts`.
 */
import type { Request, Response } from 'express';
import {
  advanceTestClockParams,
  attachProductFeatureParams,
  billingMeterEventSummariesQuery,
  billingMeterStatusParams,
  createBillingMeterEventParams,
  createBillingMeterParams,
  createEntitlementFeatureParams,
  createTestClockParams,
  expandOnlyQuery,
  listActiveEntitlementsQuery,
  listBillingMetersQuery,
  listEntitlementFeaturesQuery,
  listProductFeaturesQuery,
  listTestClocksQuery,
  updateBillingMeterParams,
  updateBillingSettingsParams,
  updateEntitlementFeatureParams,
} from '@peable.to/contracts';
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
import { answerList, parseQuery, surfaceQuery } from '../../lib/list';
import { toTestClockDTO } from '../../lib/serializeBilling';
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
import { idParam, parseBody } from './helpers';

// Test clocks, billing settings, meters and entitlements validate with the
// contract's schemas (`@peable.to/contracts`); the dashboard surface adds its
// `environment` toggle to the same schema.
const retrieveExpandQuery = surfaceQuery(expandOnlyQuery);

// ---- Test clocks ---------------------------------------------------------------------

const listClocksQuery = surfaceQuery(listTestClocksQuery);

const clockRoutes: CatalogRoute[] = [
  {
    method: 'post',
    path: '/test_helpers/test_clocks',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, createTestClockParams);
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
      if (!id || !parseQuery(req, res, retrieveExpandQuery[surface])) return;
      res.status(200).json(toTestClockDTO(await retrieveTestClock(merchant, id)));
    },
  },
  {
    method: 'post',
    path: '/test_helpers/test_clocks/:id/advance',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      if (!id) return;
      const body = parseBody(req, res, advanceTestClockParams);
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

const settingsRoutes: CatalogRoute[] = [
  {
    method: 'get',
    path: '/billing_settings',
    core: async (req, res, merchant, surface) => {
      if (!parseQuery(req, res, retrieveExpandQuery[surface])) return;
      res
        .status(200)
        .json(toBillingSettingsDTO(await getBillingSettings(merchant), merchant.livemode));
    },
  },
  {
    method: 'post',
    path: '/billing_settings',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, updateBillingSettingsParams);
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

const listMetersQuery = surfaceQuery(listBillingMetersQuery);
const summaryQuery = surfaceQuery(billingMeterEventSummariesQuery);

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
      const body = parseBody(req, res, createBillingMeterParams);
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
      if (!parseQuery(req, res, retrieveExpandQuery[surface])) return;
      const meter = await meterOf(req, res, merchant);
      if (meter) res.status(200).json(toMeterDTO(meter));
    },
  },
  {
    method: 'post',
    path: '/billing/meters/:id',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      const body = id ? parseBody(req, res, updateBillingMeterParams) : null;
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
      if (!id || !parseBody(req, res, billingMeterStatusParams)) return;
      res.status(200).json(toMeterDTO(await changeMeter(merchant, id, { status: 'inactive' })));
    },
  },
  {
    method: 'post',
    path: '/billing/meters/:id/reactivate',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      if (!id || !parseBody(req, res, billingMeterStatusParams)) return;
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
      const body = parseBody(req, res, createBillingMeterEventParams);
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

const listFeaturesQuery = surfaceQuery(listEntitlementFeaturesQuery);
const productFeaturesQuery = surfaceQuery(listProductFeaturesQuery);
const activeQuery = surfaceQuery(listActiveEntitlementsQuery);

const entitlementRoutes: CatalogRoute[] = [
  {
    method: 'post',
    path: '/entitlements/features',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, createEntitlementFeatureParams);
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
      if (!id || !parseQuery(req, res, retrieveExpandQuery[surface])) return;
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
      const body = id ? parseBody(req, res, updateEntitlementFeatureParams) : null;
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
      const body = id ? parseBody(req, res, attachProductFeatureParams) : null;
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
      const query = id ? parseQuery(req, res, productFeaturesQuery[surface]) : null;
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
