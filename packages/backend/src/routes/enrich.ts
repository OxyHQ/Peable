import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import { createOxyAuthMiddleware, getRequiredOxyUserId } from '@oxy.so/core/server';
import type { EnrichResponse } from '@peable.to/shared-types';
import { enrichAddresses, ENRICH_MAX_ADDRESSES } from '../services/enrichment';
import { sendValidationError, wrap } from '../lib/http';

const enrichBodySchema = z
  .object({
    addresses: z.array(z.string().min(1)).min(1).max(ENRICH_MAX_ADDRESSES),
  })
  .strict();

/**
 * Build the transaction-enrichment router (spec §4.8). `requireOxyUser`
 * mirrors `createSocialRouter`'s injectable auth — the CALLER's own signed-in
 * Oxy session, since results are scoped to the caller's own payments.
 */
export function createEnrichRouter(deps?: { requireOxyUser?: RequestHandler }): Router {
  const requireOxyUser: RequestHandler = deps?.requireOxyUser ?? createOxyAuthMiddleware(oxy);
  const router = Router();

  router.post(
    '/v1/enrich',
    requireOxyUser,
    wrap(async (req, res) => {
      const viewerUserId = getRequiredOxyUserId(req);
      const parsed = enrichBodySchema.safeParse(req.body);
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
