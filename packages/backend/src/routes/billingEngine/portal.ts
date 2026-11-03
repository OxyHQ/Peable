/**
 * The customer portal's merchant side — configurations (`bpc_…`) and sessions
 * (`bps_…`), ADR 0018 §9. The payer side is `public.ts`.
 *
 * Every request schema is the contract's (`@peable.to/contracts`
 * `billingPortalRoutes`); the dashboard's reads add only its Test/Live toggle.
 */
import {
  createBillingPortalConfigurationParams,
  createBillingPortalSessionParams,
  expandOnlyQuery,
  listBillingPortalConfigurationsQuery,
  updateBillingPortalConfigurationParams,
} from '@peable.to/contracts';
import {
  findPortalConfigurationForMerchant,
  listPortalConfigurations,
} from '../../db/billingEngine/portalRepository';
import { getDb } from '../../db/postgres';
import { answerList, parseQuery } from '../../lib/list';
import { missing } from '../../services/billingEngine/errors';
import {
  changePortalConfiguration,
  createPortalConfiguration,
  createPortalSession,
  toPortalConfigurationDTO,
} from '../../services/billingEngine/portal';
import type { CatalogRoute } from '../catalogRoutes';
import { answerObject, bySurface, cleared, idParam, parseBody } from './helpers';

const listConfigurationsQuery = bySurface(listBillingPortalConfigurationsQuery);
const retrieveQuery = bySurface(expandOnlyQuery);

export const PORTAL_ROUTES: readonly CatalogRoute[] = [
  {
    method: 'post',
    path: '/billing_portal/configurations',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, createBillingPortalConfigurationParams);
      if (!body) return;
      const row = await createPortalConfiguration(merchant, {
        ...(body.business_profile ? { businessProfile: body.business_profile } : {}),
        ...(body.default_return_url ? { defaultReturnUrl: body.default_return_url } : {}),
        features: body.features,
        metadata: body.metadata ?? {},
      });
      res.status(200).json(toPortalConfigurationDTO(row));
    },
  },
  {
    method: 'get',
    path: '/billing_portal/configurations',
    core: async (req, res, merchant, surface) => {
      const query = parseQuery(req, res, listConfigurationsQuery[surface]);
      if (!query) return;
      const db = getDb();
      await answerList(req, res, {
        query,
        type: 'billing_portal.configuration',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findPortalConfigurationForMerchant(db, publicId, merchant.id))?.id ?? null,
        fetch: (page) =>
          listPortalConfigurations(db, {
            merchantId: merchant.id,
            page,
            active: query.active,
            isDefault: query.is_default,
          }),
        serialize: toPortalConfigurationDTO,
      });
    },
  },
  {
    method: 'get',
    path: '/billing_portal/configurations/:id',
    core: async (req, res, merchant, surface) => {
      const id = idParam(req, res);
      const query = id ? parseQuery(req, res, retrieveQuery[surface]) : null;
      if (!id || !query) return;
      const row = await findPortalConfigurationForMerchant(getDb(), id, merchant.id);
      if (!row) throw missing('portal configuration');
      await answerObject(
        res,
        merchant,
        'billing_portal.configuration',
        toPortalConfigurationDTO(row),
        query.expand,
      );
    },
  },
  {
    method: 'post',
    path: '/billing_portal/configurations/:id',
    core: async (req, res, merchant) => {
      const id = idParam(req, res);
      const body = id ? parseBody(req, res, updateBillingPortalConfigurationParams) : null;
      if (!id || !body) return;
      const row = await changePortalConfiguration(merchant, id, {
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.business_profile ? { businessProfile: body.business_profile } : {}),
        ...(body.default_return_url !== undefined
          ? { defaultReturnUrl: cleared(body.default_return_url) ?? null }
          : {}),
        ...(body.features ? { features: body.features } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });
      res.status(200).json(toPortalConfigurationDTO(row));
    },
  },
  {
    method: 'post',
    path: '/billing_portal/sessions',
    core: async (req, res, merchant) => {
      const body = parseBody(req, res, createBillingPortalSessionParams);
      if (!body) return;
      const session = await createPortalSession(merchant, {
        customer: body.customer,
        ...(body.configuration ? { configuration: body.configuration } : {}),
        ...(body.return_url ? { returnUrl: body.return_url } : {}),
      });
      await answerObject(res, merchant, 'billing_portal.session', session, undefined);
    },
  },
];
