import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { oxyClient } from "@oxy.so/core";
import { verifySecret } from "@oxy.so/core/server";
import type { CreateCheckoutSessionParams } from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import { findMerchantById } from "../db/merchants/merchantRepository";
import { findIntentById } from "../db/payments/paymentIntentRepository";
import {
  findSessionByPublicId,
  findSessionForMerchant,
  insertCheckoutSession,
} from "../db/payments/checkoutSessionRepository";
import {
  createIntent,
  NetworkMismatchError,
  RailMismatchError,
  RailUnavailableError,
} from "../services/createIntent";
import { resolveMerchantDisplay } from "../services/merchantDisplay";
import { newId } from "../lib/ids";
import { toCheckoutSessionDTO, toCheckoutSessionPublicDTO } from "../lib/serialize";
import { sendError, wrap, requireAuthenticated } from "../lib/http";
import { resolveMerchant } from "./paymentIntents";
import { railBodyFields } from "../lib/railSchema";

const createBodySchema = z.object({
  ...railBodyFields,
  metadata: z.record(z.string(), z.string()).optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

/**
 * Build the checkout-session REST router (F2.2). `POST`/merchant `GET` follow
 * the same merchant-authed chain as `paymentIntents.ts`; the public `GET
 * .../public` is the checkout page's payer path, authorized by possession of
 * the wrapped intent's `client_secret` — exactly the same idiom as the payer
 * branch of `GET /v1/payment_intents/:id` — never a service token.
 */
export function createCheckoutSessionsRouter(deps: {
  requireMerchant: RequestHandler;
  publicRateLimit: RequestHandler;
}): Router {
  const { requireMerchant, publicRateLimit } = deps;
  const router = Router();

  router.post(
    "/v1/checkout_sessions",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }
      const params: CreateCheckoutSessionParams = parsed.data as CreateCheckoutSessionParams;

      try {
        // No `idempotencyKey`: a checkout session wraps exactly ONE intent
        // minted fresh at session-create time (Stripe Checkout Session
        // parity) — there is nothing to replay against.
        const { intent } = await createIntent({
          merchant,
          amount: params.amount,
          ...(params.rail !== undefined ? { rail: params.rail } : {}),
          ...(params.currency !== undefined ? { currency: params.currency } : {}),
          ...(params.network !== undefined ? { network: params.network } : {}),
          metadata: params.metadata,
        });

        // Explicit field whitelist — never spread `req.body`.
        //
        // `paymentIntentId` is the intent's INTERNAL id, which is what
        // `checkout_sessions.payment_intent_id` references. The Mongo document
        // stored the public `pi_…` in this position, because `PaymentIntent`'s
        // schema field was itself called `id` — the expression is unchanged and
        // its meaning is not. The public id still reaches the wire, from
        // `toCheckoutSessionDTO`, which reads it off the intent.
        const session = await insertCheckoutSession(getDb(), {
          publicId: newId("cs"),
          merchantId: merchant.id,
          oxyAppId: merchant.oxyAppId,
          environment: merchant.environment,
          paymentIntentId: intent.id,
          amount: params.amount,
          // Copied from the INTENT, never re-derived from the request. The two
          // rows live in different tables, so no constraint can catch a session
          // whose rail disagrees with the payment it wraps — and that
          // disagreement is a card form rendered over a FairCoin payment.
          currency: intent.currency,
          rail: intent.rail,
          network: intent.network,
          metadata: params.metadata ?? {},
          successUrl: params.successUrl,
          cancelUrl: params.cancelUrl,
        });
        if (!session) {
          // Unreachable: the intent was minted by the `createIntent` call
          // directly above, so nothing else can have wrapped it. Stated rather
          // than asserted away, so a future change that reuses an intent here
          // fails loudly instead of serializing `null`.
          throw new Error(`checkout session insert found intent ${intent.id} already wrapped`);
        }

        res.status(201).json(toCheckoutSessionDTO(session, intent));
      } catch (err) {
        if (err instanceof NetworkMismatchError || err instanceof RailMismatchError) {
          sendError(res, 422, "invalid_request_error", err.message);
          return;
        }
        // 503, not 422: the rail is not configured on this deployment, which is
        // not something the caller can fix by sending different fields.
        if (err instanceof RailUnavailableError) {
          sendError(res, 503, "api_error", err.message);
          return;
        }
        throw err;
      }
    }),
  );

  router.get(
    "/v1/checkout_sessions/:id",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:read"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
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

      const db = getDb();
      const session = await findSessionForMerchant(db, id, merchant.id);
      if (!session) {
        sendError(res, 404, "invalid_request_error", "checkout session not found");
        return;
      }
      // By PRIMARY KEY, and deliberately unscoped: the session that names it
      // was already ownership-checked, so a second merchant predicate here
      // would be a second authority for a decision already made.
      const intent = await findIntentById(db, session.paymentIntentId);
      if (!intent) {
        sendError(res, 404, "invalid_request_error", "checkout session not found");
        return;
      }
      res.status(200).json(toCheckoutSessionDTO(session, intent));
    }),
  );

  // Public payer path — UNAUTHENTICATED, rate-limited, authorized by
  // possession of the wrapped intent's `client_secret` (query param or
  // `X-Peable-Client-Secret` header — mirrors `GET /v1/payment_intents/:id`).
  // Never leaks `merchant`/`paymentIntent` without a proven secret.
  router.get(
    "/v1/checkout_sessions/:id/public",
    publicRateLimit,
    wrap(async (req, res) => {
      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const db = getDb();
      const session = await findSessionByPublicId(db, id);
      if (!session) {
        sendError(res, 404, "invalid_request_error", "checkout session not found");
        return;
      }
      // Unscoped by primary key: this path proves its right to the row by
      // presenting the wrapped intent's `client_secret`, verified below.
      const intent = await findIntentById(db, session.paymentIntentId);
      if (!intent) {
        sendError(res, 404, "invalid_request_error", "checkout session not found");
        return;
      }

      const clientSecretParam = req.query.client_secret;
      const clientSecret =
        typeof clientSecretParam === "string"
          ? clientSecretParam
          : req.header("X-Peable-Client-Secret");
      if (!clientSecret) {
        sendError(res, 401, "authentication_error", "missing client_secret");
        return;
      }
      if (!verifySecret(clientSecret, intent.clientSecret)) {
        sendError(res, 403, "permission_error", "invalid client_secret");
        return;
      }

      const merchant = await findMerchantById(db, session.merchantId);
      if (!merchant) {
        sendError(res, 404, "invalid_request_error", "checkout session not found");
        return;
      }
      const merchantDisplay = await resolveMerchantDisplay(merchant);
      res.status(200).json(toCheckoutSessionPublicDTO(session, merchantDisplay, intent));
    }),
  );

  return router;
}
