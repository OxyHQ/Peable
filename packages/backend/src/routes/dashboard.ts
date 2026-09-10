import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { oxyClient } from "@oxy.so/core";
import {
  createOxyAuthMiddleware,
  getRequiredOxyUserId,
  OXY_SERVICE_ENVIRONMENTS,
} from "@oxy.so/core/server";
import type { OxyAuthRequest, OxyServiceEnvironment } from "@oxy.so/core/server";
import { getDb } from "../db/postgres";
import { findIntentForMerchant } from "../db/payments/paymentIntentRepository";
import {
  findDeliveryForMerchant,
  listDeliveriesForMerchant,
} from "../db/webhooks/webhookDeliveryRepository";
import {
  assertAppMembership as realAssertAppMembership,
  type AppMembershipResult,
} from "../services/appMembership";
import type { SafeFetchFn } from "../services/webhookDispatcher";
import {
  createMerchantBodySchema,
  patchMerchantBodySchema,
  registerMerchant,
  applyMerchantPatch,
} from "./merchants";
import {
  resolveMerchantByApp,
  listQuerySchema,
  listPaymentIntentsForMerchant,
} from "./paymentIntents";
import { redeliverWebhookDelivery } from "./webhookDeliveries";
import { toMerchantDTO, toPaymentIntentDTO, toWebhookDeliveryDTO } from "../lib/serialize";
import { sendError, wrap } from "../lib/http";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/**
 * Every `/v1/dashboard/*` route is scoped to one `(applicationId, environment)`
 * pair — the Test/Live toggle in the dashboard UI selects `environment`, which
 * determines which `Merchant` document (and therefore which PaymentIntents/
 * WebhookDeliveries) the request can see (F2.0 task 1b's test/live isolation,
 * extended to the human-auth path).
 */
const environmentQuerySchema = z.object({
  environment: z.enum(OXY_SERVICE_ENVIRONMENTS),
});

function resolveEnvironment(req: Request, res: Response): OxyServiceEnvironment | null {
  const parsed = environmentQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(
      res,
      422,
      "invalid_request_error",
      "a valid environment query parameter is required (development | staging | production)",
    );
    return null;
  }
  return parsed.data.environment;
}

interface DashboardAccess {
  applicationId: string;
  environment: OxyServiceEnvironment;
}

/**
 * The full `/v1/dashboard/*` authorization gate: resolve+validate
 * `?environment=`, then delegate membership to oxy-api via
 * `assertAppMembership` (spec §8 — the gateway NEVER re-implements RBAC).
 * Writes the appropriate error response and returns `null` on any failure, so
 * every handler below just does `if (!access) return`.
 */
async function resolveDashboardAccess(
  req: Request,
  res: Response,
  deps: { assertAppMembership: typeof realAssertAppMembership },
): Promise<DashboardAccess | null> {
  const environment = resolveEnvironment(req, res);
  if (!environment) return null;

  const userId = getRequiredOxyUserId(req);
  const accessToken = (req as OxyAuthRequest).accessToken;
  if (!accessToken) {
    // Unreachable in production once `requireOxyUser` (`createOxyAuthMiddleware`)
    // has run — a real bearer always leaves `req.accessToken` set alongside
    // `req.userId` (`OxyServices.utility.ts`). Guarded so a future change to
    // that contract (or a misconfigured test stub) fails closed instead of
    // forwarding an empty `Authorization` header to oxy-api.
    sendError(res, 401, "authentication_error", "missing bearer token");
    return null;
  }

  // `noUncheckedIndexedAccess` types every `req.params` read as possibly
  // `undefined` even though Express guarantees `:applicationId` is present on
  // any request that matched one of these routes — mirrors the same guard
  // `routes/social.ts` uses for `:username`.
  const { applicationId } = req.params;
  if (!applicationId) {
    sendError(res, 422, "invalid_request_error", "applicationId is required");
    return null;
  }

  const { allowed }: AppMembershipResult = await deps.assertAppMembership(
    userId,
    applicationId,
    accessToken,
  );
  if (!allowed) {
    sendError(res, 403, "permission_error", "you are not a member of this application");
    return null;
  }

  return { applicationId, environment };
}

const webhookDeliveriesListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIST_LIMIT).optional(),
  starting_after: z.string().optional(),
});

/**
 * Build the `/v1/dashboard/*` router (F2.5 Phase 0 Task 2) — a human Oxy
 * user managing a merchant's Peable integration through
 * `dashboard.peable.to`. Kept as a SEPARATE route family from
 * `/v1/payment_intents/*`/`/v1/merchants/*`/etc (service-auth/payer only) —
 * a single handler never accepts both auth strategies (plan's global
 * constraint). Every route: `requireOxyUser` (human bearer) →
 * `resolveDashboardAccess` (environment + oxy-api membership delegation) →
 * `resolveMerchantByApp` → reuse the EXACT SAME models/serializers/list &
 * redeliver cores the service-authed routers use.
 */
export function createDashboardRouter(deps?: {
  requireOxyUser?: RequestHandler;
  assertAppMembership?: typeof realAssertAppMembership;
  safeFetch?: SafeFetchFn;
}): Router {
  const requireOxyUser: RequestHandler =
    deps?.requireOxyUser ?? createOxyAuthMiddleware(oxyClient);
  const assertAppMembership = deps?.assertAppMembership ?? realAssertAppMembership;
  const safeFetch = deps?.safeFetch;
  const router = Router();

  router.get(
    "/v1/dashboard/applications/:applicationId/merchant",
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;
      res.status(200).json(toMerchantDTO(merchant));
    }),
  );

  router.post(
    "/v1/dashboard/applications/:applicationId/merchant",
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const parsed = createMerchantBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }

      const result = await registerMerchant(access.applicationId, access.environment, parsed.data);
      if (!result.ok) {
        sendError(res, result.status, "invalid_request_error", result.message);
        return;
      }
      res.status(201).json(toMerchantDTO(result.merchant));
    }),
  );

  router.patch(
    "/v1/dashboard/applications/:applicationId/merchant",
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;

      const parsed = patchMerchantBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }
      const updated = await applyMerchantPatch(merchant, parsed.data);
      if (!updated) {
        sendError(res, 404, "invalid_request_error", "merchant not found");
        return;
      }
      res.status(200).json(toMerchantDTO(updated));
    }),
  );

  router.get(
    "/v1/dashboard/applications/:applicationId/payment_intents",
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;

      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid query",
        );
        return;
      }

      const result = await listPaymentIntentsForMerchant(merchant.id, parsed.data);
      if (!result.ok) {
        sendError(res, result.status, "invalid_request_error", result.message);
        return;
      }
      const data = result.data.map((intent) => toPaymentIntentDTO(intent));
      res.status(200).json({ object: "list", data, has_more: result.hasMore });
    }),
  );

  router.get(
    "/v1/dashboard/applications/:applicationId/payment_intents/:id",
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;

      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const intent = await findIntentForMerchant(getDb(), id, merchant.id);
      if (!intent) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }
      res.status(200).json(toPaymentIntentDTO(intent));
    }),
  );

  router.get(
    "/v1/dashboard/applications/:applicationId/webhook_deliveries",
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;

      const parsed = webhookDeliveriesListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid query",
        );
        return;
      }
      const { starting_after } = parsed.data;
      const limit = parsed.data.limit ?? DEFAULT_LIST_LIMIT;

      const db = getDb();

      // The id-shape guard is gone with the ObjectId it existed for: delivery
      // ids are `text`, so a cursor of any shape simply matches no row, and
      // the ownership-scoped lookup below produces the SAME 422 it always did.
      let after: string | undefined;
      if (starting_after) {
        const cursor = await findDeliveryForMerchant(db, starting_after, merchant.id);
        if (!cursor) {
          sendError(
            res,
            422,
            "invalid_request_error",
            "starting_after references an unknown webhook delivery",
          );
          return;
        }
        after = cursor.id;
      }

      // Each row carries its intent's PUBLIC id, joined in by the repository.
      // `WebhookDelivery.intentId` is a shipped wire field holding the `pi_…`,
      // and resolving it per row here would be an N+1 whose size the client
      // chooses through `limit`.
      const page = await listDeliveriesForMerchant(db, {
        merchantId: merchant.id,
        limit,
        after,
      });
      const data = page.data.map((delivery) =>
        toWebhookDeliveryDTO(delivery, delivery.intentPublicId),
      );
      res.status(200).json({ object: "list", data, has_more: page.hasMore });
    }),
  );

  router.post(
    "/v1/dashboard/applications/:applicationId/webhook_deliveries/:id/redeliver",
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;

      const { id: deliveryId } = req.params;
      if (!deliveryId) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const result = await redeliverWebhookDelivery(merchant, deliveryId, { safeFetch });
      if (!result.ok) {
        sendError(res, result.status, "invalid_request_error", result.message);
        return;
      }
      res.status(200).json(toWebhookDeliveryDTO(result.delivery, result.intentPublicId));
    }),
  );

  return router;
}
