import { expandOnlyQuery, listCustomersQuery } from '@peable.to/contracts';
import {
  findCustomerForMerchant,
  listCustomersForMerchant,
} from '../../db/customers/customerRepository';
import { getDb } from '../../db/postgres';
import { answerList, parseQuery, surfaceQuery } from '../../lib/list';
import { toCustomerDTO, toDeletedCustomerDTO } from '../../lib/serialize';
import { missing } from '../../services/billingEngine/errors';
import { updateCustomerCore } from '../customers';
import type { CatalogRoute } from '../catalogRoutes';
import { answerObject, idParam } from './helpers';

/** The contract's customer queries (`customerRoutes`), plus the dashboard's Test/Live toggle. */
const listQuery = surfaceQuery(listCustomersQuery);
const retrieveQuery = surfaceQuery(expandOnlyQuery);

/**
 * `GET /customers`, `GET /customers/:id` and `POST /customers/:id` for Orbit's
 * dashboard (ADR 0016's `cus_…`). The merchant API has its own `/v1/customers`
 * router (`routes/customers.ts`); these are the dashboard's mirror of it,
 * mounted there only. The update is that router's own core
 * (`updateCustomerCore`): one validation, one write, one event.
 */
export const DASHBOARD_CUSTOMER_ROUTES: readonly CatalogRoute[] = [
  {
    method: 'get',
    path: '/customers',
    core: async (req, res, merchant, surface) => {
      const query = parseQuery(req, res, listQuery[surface]);
      if (!query) return;
      const db = getDb();
      await answerList(req, res, {
        query,
        type: 'customer',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findCustomerForMerchant(db, publicId, merchant.id))?.id ?? null,
        fetch: (page) =>
          listCustomersForMerchant(db, { merchantId: merchant.id, email: query.email, page }),
        serialize: toCustomerDTO,
      });
    },
  },
  {
    method: 'get',
    path: '/customers/:id',
    core: async (req, res, merchant, surface) => {
      const id = idParam(req, res);
      const query = id ? parseQuery(req, res, retrieveQuery[surface]) : null;
      if (!id || !query) return;
      const row = await findCustomerForMerchant(getDb(), id, merchant.id);
      if (!row) throw missing('customer');
      await answerObject(
        res,
        merchant,
        'customer',
        row.deletedAt === null ? toCustomerDTO(row) : toDeletedCustomerDTO(row),
        query.expand,
      );
    },
  },
  {
    method: 'post',
    path: '/customers/:id',
    core: (req, res, merchant) => updateCustomerCore(req, res, merchant),
  },
];
