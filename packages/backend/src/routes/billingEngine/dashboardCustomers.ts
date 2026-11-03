import { expandOnlyQuery, listCustomersQuery } from '@peable.to/contracts';
import {
  findCustomerForMerchant,
  listCustomersForMerchant,
} from '../../db/customers/customerRepository';
import { getDb } from '../../db/postgres';
import { answerList, parseQuery } from '../../lib/list';
import { toCustomerDTO, toDeletedCustomerDTO } from '../../lib/serialize';
import { missing } from '../../services/billingEngine/errors';
import type { CatalogRoute } from '../catalogRoutes';
import { answerObject, bySurface, idParam } from './helpers';

/** The contract's customer queries (`customerRoutes`), plus the dashboard's Test/Live toggle. */
const listQuery = bySurface(listCustomersQuery);
const retrieveQuery = bySurface(expandOnlyQuery);

/**
 * `GET /customers` and `GET /customers/:id` for Orbit's dashboard (ADR 0016's
 * `cus_…`). The merchant API has its own `/v1/customers` router
 * (`routes/customers.ts`); these two reads are the dashboard's mirror of it,
 * mounted there only.
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
];
