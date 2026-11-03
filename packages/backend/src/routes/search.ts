/**
 * Search (Stripe's Search API): `GET /v1/<resource>/search?query=…` for every
 * resource in `lib/search/resources.ts`, and the same cores under Orbit's
 * dashboard.
 *
 * MOUNTED BEFORE the resource routers (`server.ts`, `routes/dashboard.ts`):
 * `/v1/charges/search` is otherwise `/v1/charges/:id` with an id of `search`,
 * a 404 that looks like a missing charge.
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { SEARCHABLE_RESOURCES } from '@peable.to/shared-types';
import { requireAuthenticated, wrap, requireScope } from '../lib/http';
import { answerGlobalSearch, answerSearch } from '../lib/search/answer';
import { SEARCH_RESOURCES } from '../lib/search/resources';
import { resolveMerchant } from './paymentIntents';
import type { DashboardGate } from './dashboardAccess';

export function createSearchRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  for (const name of SEARCHABLE_RESOURCES) {
    const resource = SEARCH_RESOURCES[name];
    router.get(
      `/v1/${name}/search`,
      deps.requireMerchant,
      requireAuthenticated,
      requireScope('payments:read'),
      wrap(async (req, res) => {
        const merchant = await resolveMerchant(req, res);
        if (!merchant) return;
        await answerSearch(req, res, merchant.id, resource, 'api');
      }),
    );
  }
  return router;
}

/**
 * Orbit's search: each resource's search under the dashboard (the same core,
 * `surface: 'dashboard'`), and the global box over all of them
 * (`…/search?q=`). Every route is a `read` behind the dashboard's gate, so a
 * member searches only their application's merchant in the environment the
 * Test/Live toggle names.
 */
export function mountSearchDashboardRoutes(
  router: Router,
  deps: {
    readonly base: string;
    readonly requireOxyUser: RequestHandler;
    readonly gate: DashboardGate;
  },
): void {
  router.get(
    `${deps.base}/search`,
    deps.requireOxyUser,
    deps.gate('read', (req, res, merchant) => answerGlobalSearch(req, res, merchant.id)),
  );
  for (const name of SEARCHABLE_RESOURCES) {
    const resource = SEARCH_RESOURCES[name];
    router.get(
      `${deps.base}/${name}/search`,
      deps.requireOxyUser,
      deps.gate('read', (req, res, merchant) =>
        answerSearch(req, res, merchant.id, resource, 'dashboard'),
      ),
    );
  }
}
