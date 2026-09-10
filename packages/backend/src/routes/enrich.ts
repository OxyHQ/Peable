import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { oxyClient } from "@oxy.so/core";
import { createOxyAuthMiddleware, getRequiredOxyUserId } from "@oxy.so/core/server";
import type { EnrichResponse } from "@peable.to/shared-types";
import { enrichAddresses, ENRICH_MAX_ADDRESSES } from "../services/enrichment";
import { sendError, wrap } from "../lib/http";

const enrichBodySchema = z.object({
  addresses: z.array(z.string().min(1)).min(1).max(ENRICH_MAX_ADDRESSES),
});

/**
 * Build the transaction-enrichment router (spec §4.8). `requireOxyUser`
 * mirrors `createSocialRouter`'s injectable auth — the CALLER's own signed-in
 * Oxy session, since results are scoped to the caller's own payments.
 */
export function createEnrichRouter(deps?: { requireOxyUser?: RequestHandler }): Router {
  const requireOxyUser: RequestHandler =
    deps?.requireOxyUser ?? createOxyAuthMiddleware(oxyClient);
  const router = Router();

  router.post(
    "/v1/enrich",
    requireOxyUser,
    wrap(async (req, res) => {
      const viewerUserId = getRequiredOxyUserId(req);
      const parsed = enrichBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }
      const data = await enrichAddresses(parsed.data.addresses, viewerUserId);
      const body: EnrichResponse = { data };
      res.status(200).json(body);
    }),
  );

  return router;
}
