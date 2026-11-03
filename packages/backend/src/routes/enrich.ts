import { Router } from 'express';
import type { RequestHandler } from 'express';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { type EnrichResponse, enrichParams } from '@peable.to/contracts';
import { enrichAddresses } from '../services/enrichment';
import { sendValidationError, wrap } from '../lib/http';

/**
 * Build the transaction-enrichment router (spec §4.8). `requireOxyUser`
 * mirrors `createSocialRouter`'s injectable auth — the CALLER's own signed-in
 * Oxy session, since results are scoped to the caller's own payments.
 */
export function createEnrichRouter(deps: { requireOxyUser: RequestHandler }): Router {
  const { requireOxyUser } = deps;
  const router = Router();

  router.post(
    '/v1/enrich',
    requireOxyUser,
    wrap(async (req, res) => {
      const viewerUserId = getRequiredOxyUserId(req);
      const parsed = enrichParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const data = await enrichAddresses(parsed.data.addresses, viewerUserId);
      const body: EnrichResponse = { data };
      res.status(200).json(body);
    }),
  );

  return router;
}
