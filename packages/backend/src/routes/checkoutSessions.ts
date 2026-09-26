import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { oxy } from "../oxy";
import { verifySecret } from "@oxy.so/core/server";
import type { CreateCheckoutSessionParams } from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import { findMerchantById } from "../db/merchants/merchantRepository";
import { findIntentById } from "../db/payments/paymentIntentRepository";
import {
  findSessionByIntentId,
  findSessionByPublicId,
  findSessionForMerchant,
  insertCheckoutSession,
} from "../db/payments/checkoutSessionRepository";
import {
  createIntent,
  IdempotencyConflictError,
  NetworkMismatchError,
  RailMismatchError,
  RailUnavailableError,
} from "../services/createIntent";
import { EnvironmentModeMismatchError } from "../services/providers/environmentGuard";
import { resolveMerchantDisplay } from "../services/merchantDisplay";
import { newId } from "../lib/ids";
import { toCheckoutSessionDTO, toCheckoutSessionPublicDTO } from "../lib/serialize";
import { sendEnvironmentMismatch, sendError, wrap, requireAuthenticated } from "../lib/http";
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
    oxy.middleware.requireScope("payments:write"),
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

      /**
       * An `Idempotency-Key` on this route is HONOURED when it is sent.
       *
       * The comment here used to say a session "wraps exactly ONE intent minted
       * fresh at session-create time (Stripe Checkout Session parity) — there
       * is nothing to replay against". Parity with Stripe's object model is not
       * a reason to drop the caller's retry semantics: a merchant whose create
       * timed out and retried got a SECOND session and a second payment intent,
       * and the first one stayed alive until it expired. Two live sessions for
       * one order is two prices a buyer can be shown and two payments they can
       * make.
       *
       * No new column is needed. The key converges the INTENT
       * (`payment_intents.idempotency_key`), and `checkout_sessions` is unique
       * on the intent it wraps — so the session that already wraps the replayed
       * intent IS the session that key created. Optional, because the header
       * has never been required here and making it so would break every
       * integration that has not sent one.
       */
      const idempotencyKey = req.header("Idempotency-Key")?.trim();

      try {
        const { intent, reused } = await createIntent({
          merchant,
          amount: params.amount,
          ...(params.rail !== undefined ? { rail: params.rail } : {}),
          ...(params.currency !== undefined ? { currency: params.currency } : {}),
          ...(params.network !== undefined ? { network: params.network } : {}),
          metadata: params.metadata,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });

        if (reused) {
          // The key named an intent that already exists, so the session that
          // wraps it already exists too. 200, not 201: nothing was created, and
          // the status code is what tells a merchant whether they just made a
          // second checkout.
          const existing = await findSessionByIntentId(getDb(), intent.id);
          if (existing) {
            res.status(200).json(toCheckoutSessionDTO(existing, intent));
            return;
          }
          // The intent exists and no session wraps it — a create interrupted
          // between the two writes. Fall through and write the session, which
          // is what finishing that create means.
        }

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
          /**
           * Another request wrapped this intent between the read above and this
           * insert — two concurrent creates with one `Idempotency-Key`. The
           * unique index decided the winner; re-reading it is correct rather
           * than merely convenient, because both requests named the same intent
           * and therefore the same session.
           *
           * Before the key was honoured this branch was unreachable and said
           * so: every session minted a fresh intent, so nothing else could have
           * wrapped it.
           */
          const winner = await findSessionByIntentId(getDb(), intent.id);
          if (!winner) {
            throw new Error(`checkout session insert found intent ${intent.id} already wrapped`);
          }
          res.status(200).json(toCheckoutSessionDTO(winner, intent));
          return;
        }

        res.status(201).json(toCheckoutSessionDTO(session, intent));
      } catch (err) {
        if (err instanceof NetworkMismatchError || err instanceof RailMismatchError) {
          sendError(res, 422, "invalid_request_error", err.message);
          return;
        }
        if (err instanceof EnvironmentModeMismatchError) {
          sendEnvironmentMismatch(res, err.message);
          return;
        }
        if (err instanceof IdempotencyConflictError) {
          sendError(res, 409, "invalid_request_error", err.message);
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
    oxy.middleware.requireScope("payments:read"),
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
